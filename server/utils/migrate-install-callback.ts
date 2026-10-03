/**
 * The GitHub App setup callback's signed-`state` branch (Studio setup beside
 * a live Migrate move, W39).
 *
 * The customer installed Studio's App from the address Migrate handed them.
 * With "Request user authorization during installation" on, GitHub returns
 * them here with `code` (their authorization), `installation_id` and our
 * signed `state`. There is no Studio session yet, so everything rests on:
 *
 *  1. the `state` — ours, unexpired, single-use (`jti` taken before any write);
 *  2. the grant — the one the state names, redeemed, bound to that workspace;
 *  3. the `code` — exchanged for the installer's own GitHub identity and token,
 *     with which GitHub itself confirms they can reach the installation.
 *     Without a `code` nothing proves who installed, so nothing is bound.
 *
 * If the installer is the grant's owner (same GitHub account the Migrate
 * customer signed in with) they are signed in and sent to the workspace.
 * Otherwise (an org admin installed for them) the installation is still bound
 * — the installer proved access to it, the grant is the payer's — but no
 * session is created; the payer is sent to sign in and open their offer.
 */
import type { H3Event } from 'h3'
import { exchangeGitHubInstallCode } from './github-user-code'
import { migrateInstallStateKey, verifyMigrateInstallState } from './migrate-install-state'
import { migrateGrantStateOf } from './migrate-grant-status'
import { useAuthProvider, useDatabaseProvider, useGitAppService } from './providers'
import { completeOAuthSignIn } from '../providers/managed-auth'

interface CallbackQuery {
  installation_id?: string
  code?: string
  state?: string
}

const claimScreen = (grantId: string) => `/migrate/claim?grant=${encodeURIComponent(grantId)}`
const loginThenClaim = (grantId: string) => `/auth/login?redirect=${encodeURIComponent(claimScreen(grantId))}`

export async function handleMigrateInstallCallback(event: H3Event, query: CallbackQuery) {
  const key = migrateInstallStateKey()
  const state = key && query.state ? await verifyMigrateInstallState(query.state, key) : null
  if (!state) throw createError({ statusCode: 400, message: errorMessage('migrate.install_state_invalid') })

  const installationId = Number(query.installation_id)
  if (!query.installation_id || !Number.isInteger(installationId) || installationId <= 0)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_id_invalid') })

  const db = useDatabaseProvider()
  const grant = await db.getMigrateGrantForUser(state.grantId, state.userId)
  if (!grant || grant.workspace_id !== state.workspaceId || migrateGrantStateOf(grant) !== 'redeemed')
    throw createError({ statusCode: 400, message: errorMessage('migrate.install_state_invalid') })

  const workspace = await db.getWorkspaceById(state.workspaceId, 'id, slug, github_installation_id')
  if (!workspace || typeof workspace.slug !== 'string')
    throw createError({ statusCode: 404, message: errorMessage('github.workspace_not_found') })

  // Without the installer's authorization nothing proves who installed:
  // bind nothing, send the payer to the manual path.
  if (!query.code) return sendRedirect(event, loginThenClaim(grant.id as string))

  // Single use, taken before any write: a replayed callback finds it gone.
  if (!(await db.claimMigrateS2sJti(state.jti, 'install-state', new Date((state.exp + 60) * 1000))))
    throw createError({ statusCode: 409, message: errorMessage('migrate.s2s_replayed') })

  const installer = await exchangeGitHubInstallCode(query.code)
  if (!installer) throw createError({ statusCode: 403, message: errorMessage('github.installation_access_denied') })

  if (!(await useGitAppService().verifyUserHasAccessToInstallation(installer.tokens.accessToken, installationId)))
    throw createError({ statusCode: 403, message: errorMessage('github.installation_access_denied') })

  if (Number(workspace.github_installation_id) !== installationId) {
    if (await db.findWorkspaceByGithubInstallation(installationId, state.workspaceId))
      throw createError({ statusCode: 409, message: errorMessage('github.installation_linked') })
    await db.updateWorkspaceGithubInstallation(state.workspaceId, installationId)
  }

  const owner = await useAuthProvider().getUserById(state.userId)
  const sameAccount = !!owner && owner.provider === 'github' && owner.providerAccountId === installer.id
  const signInAvailable = useRuntimeConfig().authProvider === 'managed'
  if (!owner || !owner.email || !sameAccount || !signInAvailable)
    return sendRedirect(event, loginThenClaim(grant.id as string))

  const session = await completeOAuthSignIn({
    provider: 'github',
    providerAccountId: installer.id,
    email: owner.email,
    name: null,
    userName: installer.login || null,
    avatarUrl: owner.avatarUrl,
  })
  await db.upsertOAuthProviderToken({ userId: session.user.id, provider: 'github', ...installer.tokens })
  await setServerSession(event, {
    userId: session.user.id,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    expiresAt: session.tokens.expiresAt,
  })
  return sendRedirect(event, `/w/${workspace.slug}`)
}
