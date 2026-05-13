/**
 * Delete a workspace and all its projects.
 *
 * Only the workspace owner can delete. Primary (personal) workspace
 * cannot be deleted.
 *
 * Optional cleanup flags in the request body:
 *  - `uninstallGithubApp` (default false): also revoke the GitHub App
 *    installation from the user's account/org. Without this, GitHub
 *    leaves the App installed after the workspace is gone — making
 *    the next install on a fresh workspace land on GitHub's "Configure"
 *    page (which doesn't fire a callback) instead of a fresh install
 *    flow. The connect-existing endpoint handles this case, but
 *    opting into clean uninstall avoids the recovery flow entirely.
 *  - `cancelSubscription` (default false): also cancel the active
 *    Polar/Stripe subscription. Without this, deleting the workspace
 *    silently leaves the customer paying for nothing — the subscription
 *    keeps running on the provider side until the customer self-cancels
 *    via their billing portal.
 *
 * Both are best-effort: failure is logged and swallowed so the
 * underlying workspace delete (DB CASCADE) still proceeds. The
 * `installation.deleted` webhook will reconcile any leftover
 * github_installation_id rows, and the next billing-status read will
 * pick up provider-side cancellations.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  // Optional flags from body. DELETE requests in JSON are non-standard
  // but supported by ofetch/native fetch when an explicit body is sent.
  const body = await readBody<{ uninstallGithubApp?: boolean, cancelSubscription?: boolean } | null>(event).catch(() => null)
  const uninstallGithubApp = body?.uninstallGithubApp === true
  const cancelSubscription = body?.cancelSubscription === true

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner'])

  // Fetch workspace and verify ownership
  const workspace = await db.getWorkspaceById(workspaceId, 'id, type, owner_id, github_installation_id')

  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('workspace.not_found') })

  if (workspace.type === 'primary')
    throw createError({ statusCode: 400, message: errorMessage('workspace.cannot_delete_primary') })

  if (workspace.owner_id !== session.user.id)
    throw createError({ statusCode: 403, message: errorMessage('workspace.owner_only_delete') })

  // Optional: revoke the GitHub App installation before deleting the
  // workspace. Done first so a failure here doesn't prevent the user
  // from retrying the workspace delete later (the App is still
  // installed but the workspace is gone). We only attempt revoke when
  // the installation is exclusively bound to this workspace —
  // findWorkspaceByGithubInstallation excludes the current workspace,
  // so a non-null result means another workspace shares this id and
  // revoke would orphan them too.
  const installationId = typeof workspace.github_installation_id === 'number'
    ? workspace.github_installation_id
    : null
  if (uninstallGithubApp && installationId) {
    const otherBound = await db.findWorkspaceByGithubInstallation(installationId, workspaceId)
    if (!otherBound) {
      try {
        const gitApp = useGitAppProvider(installationId)
        await gitApp.revokeInstallation()
      }
      catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.warn('[workspace-delete] revokeInstallation failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  // Optional: cancel the active subscription. Done before delete because
  // CASCADE will drop the payment_accounts row and we lose the
  // subscription_id reference.
  if (cancelSubscription) {
    try {
      const account = await db.getActivePaymentAccount(workspaceId)
      const subscriptionId = (account?.subscription_id as string | null) ?? null
      if (subscriptionId) {
        const payment = usePaymentProvider()
        if (payment)
          await payment.cancelSubscription(subscriptionId)
      }
    }
    catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn('[workspace-delete] cancelSubscription failed:', err instanceof Error ? err.message : err)
    }
  }

  // Clean R2 storage for all projects
  const projects = await db.listWorkspaceProjects(session.accessToken, workspaceId)

  const cdn = useCDNProvider()
  if (cdn && projects?.length) {
    for (const project of projects) {
      try {
        await cdn.deletePrefix(project.id as string, '')
      }
      catch {
        // R2 cleanup failure should not block deletion
      }
    }
  }

  // Delete workspace — CASCADE handles all child records
  await db.deleteWorkspace(workspaceId)

  return { deleted: true }
})
