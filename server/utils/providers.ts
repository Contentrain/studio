import type { AuthProvider } from '../providers/auth'
import type { AIProvider } from '../providers/ai'
import type { DatabaseProvider } from '../providers/database'
import type { GitAppProvider, GitAppService, GitProvider } from '../providers/git'
import type { CDNProvider } from '../providers/cdn'
import type { MediaProvider } from '../providers/media'
import type { EmailProvider } from '../providers/email'
import type { PaymentPluginConfig, PaymentProvider } from '../providers/payment'
import { bootstrapPaymentPlugins, resolveDefaultPlugin } from '../providers/payment'
import { createSupabaseAuthProvider } from '../providers/supabase-auth'
import { createSupabaseDatabaseProvider } from '../providers/supabase-db'
import { createStudioGitProvider } from '../providers/git'
import { createGitAppService, createGitHubAppInstallationProvider } from '../providers/github-app'
import { createAnthropicProvider } from '../providers/anthropic-ai'
import { createResendEmailProvider } from '../providers/resend-email'
import { getLoadedEnterpriseBridge } from './enterprise'

/**
 * Singleton provider instances.
 *
 * All server code accesses providers through this factory — never by
 * importing concrete implementations directly. Swap the create*() call
 * to switch providers (e.g. AuthJS, Clerk, GitLab, Bitbucket, OpenAI).
 */

let _authProvider: AuthProvider | null = null
let _aiProvider: AIProvider | null = null
let _databaseProvider: DatabaseProvider | null = null
let _cdnProvider: CDNProvider | null = null
let _mediaProvider: MediaProvider | null = null
let _emailProvider: EmailProvider | null | undefined

export function useAuthProvider(): AuthProvider {
  if (!_authProvider) {
    const kind = useRuntimeConfig().authProvider || 'supabase'
    if (kind === 'managed') {
      // Ships with the managed-auth phase. Boot validation (00.validate-config.ts)
      // rejects this selection until then — this throw is the defensive backstop.
      throw new Error('[providers] authProvider "managed" is not implemented yet')
    }
    _authProvider = createSupabaseAuthProvider()
  }

  return _authProvider
}

export function useDatabaseProvider(): DatabaseProvider {
  if (!_databaseProvider) {
    const kind = useRuntimeConfig().databaseProvider || 'supabase'
    if (kind === 'postgres') {
      // Ships with the postgres-db phase. Boot validation (00.validate-config.ts)
      // rejects this selection until then — this throw is the defensive backstop.
      throw new Error('[providers] databaseProvider "postgres" is not implemented yet')
    }
    _databaseProvider = createSupabaseDatabaseProvider()
  }

  return _databaseProvider
}

/**
 * AI Provider (singleton).
 *
 * Abstracts AI model interaction. Current: Anthropic.
 * Future: swap createAnthropicProvider with createOpenAIProvider, etc.
 * Or resolve dynamically based on user's BYOA key provider.
 */
export function useAIProvider(): AIProvider {
  if (!_aiProvider)
    _aiProvider = createAnthropicProvider()

  return _aiProvider
}

/**
 * Create a GitProvider scoped to a specific repository.
 *
 * Unlike AuthProvider (singleton), GitProvider is per-repo because
 * each repository has its own owner/repo/installationId context.
 *
 * Composes MCP's `GitHubProvider` (content-ops surface) with Studio
 * extensions — see `../providers/git.ts`. GitLab support ships by
 * swapping `createStudioGitProvider` for a GitLab equivalent that
 * wraps `GitLabProvider` from `@contentrain/mcp/providers/gitlab`.
 */
export function useGitProvider(options: {
  installationId: number
  owner: string
  repo: string
  contentRoot?: string
}): GitProvider {
  return createStudioGitProvider(options)
}

export function useGitAppProvider(installationId: number): GitAppProvider {
  const config = useRuntimeConfig()
  const privateKey = Buffer.from(config.github.privateKey, 'base64').toString('utf-8')

  return createGitHubAppInstallationProvider({
    appId: config.github.appId,
    privateKey,
    installationId,
  })
}

/**
 * App-level GitHub service (not installation-scoped).
 *
 * Use this for operations that enumerate or verify installations
 * against either an App JWT or a user's OAuth token — e.g. listing
 * the installations a user can see (`GET /user/installations`),
 * verifying user access before binding an installation
 * (PostHog-style ownership check), or App-administration calls that
 * don't fit a single installation scope.
 *
 * Per-installation operations (repo list, framework detect, revoke,
 * repo create) still go through `useGitAppProvider(installationId)`.
 */
let _gitAppService: GitAppService | null = null
export function useGitAppService(): GitAppService {
  if (_gitAppService) return _gitAppService

  const config = useRuntimeConfig()
  const privateKey = Buffer.from(config.github.privateKey, 'base64').toString('utf-8')
  _gitAppService = createGitAppService({
    appId: config.github.appId,
    privateKey,
  })
  return _gitAppService
}

/**
 * CDN Provider (singleton).
 *
 * Returns null if CDN is not configured (no R2 credentials).
 * EE implementation: Cloudflare R2.
 */
export function useCDNProvider(): CDNProvider | null {
  if (_cdnProvider) return _cdnProvider

  const config = useRuntimeConfig()
  const { r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket } = config.cdn as {
    r2AccountId: string
    r2AccessKeyId: string
    r2SecretAccessKey: string
    r2Bucket: string
  }

  // CDN not configured — graceful null
  if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey) return null

  const bridge = getLoadedEnterpriseBridge()
  if (!bridge?.createCDNProvider) return null

  _cdnProvider = bridge.createCDNProvider({
    accountId: r2AccountId,
    accessKeyId: r2AccessKeyId,
    secretAccessKey: r2SecretAccessKey,
    // No implicit bucket default: boot validation (00.validate-config.ts)
    // rejects R2 creds without an explicit NUXT_CDN_R2_BUCKET, so a blank env
    // fails loudly instead of silently targeting a shared/prod bucket.
    bucket: r2Bucket,
  })

  return _cdnProvider
}

/**
 * Media Provider (singleton).
 *
 * Returns null if CDN/R2 is not configured (media requires object storage).
 * Uses Sharp for image processing + CDNProvider for R2 storage.
 */
export function useMediaProvider(): MediaProvider | null {
  if (_mediaProvider) return _mediaProvider

  const cdn = useCDNProvider()
  if (!cdn) return null

  const bridge = getLoadedEnterpriseBridge()
  if (!bridge?.createMediaProvider) return null

  _mediaProvider = bridge.createMediaProvider({ cdn, db: useDatabaseProvider() })

  return _mediaProvider
}

/**
 * Email Provider (singleton).
 *
 * Returns null if no email API key is configured.
 * Current impl: Resend. Swap to SendGrid, Postmark, or nodemailer
 * by changing the create*() call below.
 */
export function useEmailProvider(): EmailProvider | null {
  if (_emailProvider !== undefined) return _emailProvider

  const config = useRuntimeConfig()
  const apiKey = (config.resend as { apiKey?: string })?.apiKey

  if (!apiKey) {
    _emailProvider = null
    return null
  }

  _emailProvider = createResendEmailProvider(apiKey)
  return _emailProvider
}

/**
 * Payment Provider (singleton).
 *
 * Resolves the active payment plugin from the registry using runtime config.
 * Returns null in self-hosted/no-billing mode (no plugin configured).
 *
 * Registered plugins live in `server/providers/payment/plugins/`. The
 * preference order is defined in `payment/registry.ts` (currently
 * `polar` → `stripe`). To add a provider: implement a plugin file and
 * register it inside `bootstrapPaymentPlugins()`.
 */
let _paymentProvider: PaymentProvider | null | undefined
export function usePaymentProvider(): PaymentProvider | null {
  if (_paymentProvider !== undefined) return _paymentProvider

  bootstrapPaymentPlugins()
  const config = useRuntimeConfig() as unknown as PaymentPluginConfig
  const plugin = resolveDefaultPlugin(config)

  if (!plugin) {
    _paymentProvider = null
    return null
  }

  _paymentProvider = plugin.create(config)
  return _paymentProvider
}
