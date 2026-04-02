import type { AuthProvider } from '../providers/auth'
import type { AIProvider } from '../providers/ai'
import type { DatabaseProvider } from '../providers/database'
import type { GitAppProvider, GitProvider } from '../providers/git'
import type { CDNProvider } from '../providers/cdn'
import type { MediaProvider } from '../providers/media'
import type { EmailProvider } from '../providers/email'
import type { PaymentProvider } from '../providers/payment'
import { createSupabaseAuthProvider } from '../providers/supabase-auth'
import { createSupabaseDatabaseProvider } from '../providers/supabase-db'
import { createGitHubAppInstallationProvider, createGitHubAppProvider } from '../providers/github-app'
import { createAnthropicProvider } from '../providers/anthropic-ai'
import { createResendEmailProvider } from '../providers/resend-email'
import { createStripePaymentProvider } from '../providers/stripe-payment'
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
  if (!_authProvider)
    _authProvider = createSupabaseAuthProvider()

  return _authProvider
}

export function useDatabaseProvider(): DatabaseProvider {
  if (!_databaseProvider)
    _databaseProvider = createSupabaseDatabaseProvider()

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
 * Future: swap createGitHubAppProvider with createGitLabProvider, etc.
 */
export function useGitProvider(options: {
  installationId: number
  owner: string
  repo: string
}): GitProvider {
  const config = useRuntimeConfig()

  // Decode base64 PEM
  const privateKey = Buffer.from(config.github.privateKey, 'base64').toString('utf-8')

  return createGitHubAppProvider({
    appId: config.github.appId,
    privateKey,
    installationId: options.installationId,
    owner: options.owner,
    repo: options.repo,
  })
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
    bucket: r2Bucket || 'contentrain-cdn',
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
 * Returns null if Stripe is not configured (self-hosted mode).
 * Current impl: Stripe. Swap to Paddle, LemonSqueezy, etc.
 */
let _paymentProvider: PaymentProvider | null | undefined
export function usePaymentProvider(): PaymentProvider | null {
  if (_paymentProvider !== undefined) return _paymentProvider

  const config = useRuntimeConfig()
  const secretKey = (config.stripe as { secretKey?: string })?.secretKey

  if (!secretKey) {
    _paymentProvider = null
    return null
  }

  _paymentProvider = createStripePaymentProvider()
  return _paymentProvider
}
