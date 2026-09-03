import { syncMigrationHandoff } from '~~/server/utils/migration-handoff'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    repoFullName: string
    defaultBranch?: string
    contentRoot?: string
    detectedStack?: string
    hasContentrain?: boolean
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  if (!body.repoFullName)
    throw createError({ statusCode: 400, message: errorMessage('validation.repo_required') })

  // Free plan cannot create projects — requires paid subscription
  const billingPlan = event.context.billing?.effectivePlan
  if (billingPlan === 'free') {
    throw createError({
      statusCode: 402,
      message: 'A paid plan is required to connect repositories.',
      data: { requiresCheckout: true, workspaceId },
    })
  }

  const db = useDatabaseProvider()

  // Prevent duplicate — same repo in same workspace
  const isDuplicate = await db.checkDuplicateProject(workspaceId, body.repoFullName)

  if (isDuplicate)
    throw createError({ statusCode: 409, message: errorMessage('project.already_connected') })

  const defaultBranch = body.defaultBranch || 'main'

  // Establish the content SSOT branch before the project row exists, so a
  // stored project always implies a write-ready one. Without this a repo that
  // already carries `.contentrain/` connects as `active` and reads fine while
  // every write fails on the missing base ref — see ensureContentBranch.
  const workspace = await db.getWorkspaceById(workspaceId, 'id, github_installation_id')
  const installationId = workspace?.github_installation_id as number | null | undefined

  if (installationId) {
    const [owner = '', repo = ''] = body.repoFullName.split('/')
    try {
      await ensureContentBranch(
        useGitProvider({ installationId, owner, repo, contentRoot: body.contentRoot || '/' }),
        defaultBranch,
      )
    }
    catch {
      throw createError({
        statusCode: 502,
        message: errorMessage('project.content_branch_failed'),
      })
    }
  }

  const project = await db.createProject(session.accessToken, {
    workspace_id: workspaceId,
    repo_full_name: body.repoFullName,
    default_branch: defaultBranch,
    content_root: body.contentRoot || '/',
    detected_stack: body.detectedStack || null,
    status: body.hasContentrain === false ? 'setup' : 'active',
  })

  // A repository produced by Contentrain Migrate carries `contentrain-handoff.json`;
  // pick it up now so the overview card and the agent see the migration on the
  // very first visit. Best-effort — a missing or malformed file never blocks the
  // connect (the project can re-sync from the overview card).
  if (installationId && project?.id) {
    const [owner = '', repo = ''] = body.repoFullName.split('/')
    syncMigrationHandoff({
      projectId: project.id as string,
      git: useGitProvider({ installationId, owner, repo }),
      contentRoot: normalizeContentRoot(body.contentRoot || '/'),
      project: { repo_full_name: body.repoFullName, default_branch: defaultBranch },
    }).catch(() => {})
  }

  return project
})
