import type { AuthProvider } from '../providers/auth'
import type { AIProvider } from '../providers/ai'
import type { GitProvider } from '../providers/git'
import type { CDNProvider } from '../providers/cdn'
import { createSupabaseAuthProvider } from '../providers/supabase-auth'
import { createGitHubAppProvider } from '../providers/github-app'
import { createAnthropicProvider } from '../providers/anthropic-ai'

/**
 * Singleton provider instances.
 *
 * All server code accesses providers through this factory — never by
 * importing concrete implementations directly. Swap the create*() call
 * to switch providers (e.g. AuthJS, Clerk, GitLab, Bitbucket, OpenAI).
 */

let _authProvider: AuthProvider | null = null
let _aiProvider: AIProvider | null = null
let _cdnProvider: CDNProvider | null = null

export function useAuthProvider(): AuthProvider {
  if (!_authProvider)
    _authProvider = createSupabaseAuthProvider()

  return _authProvider
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

  try {
    // Dynamic import of EE implementation
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createCloudflareR2Provider } = require('../../ee/cdn/cloudflare-cdn') as {
      createCloudflareR2Provider: (config: { accountId: string, accessKeyId: string, secretAccessKey: string, bucket: string }) => CDNProvider
    }

    _cdnProvider = createCloudflareR2Provider({
      accountId: r2AccountId,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      bucket: r2Bucket || 'contentrain-cdn',
    })

    return _cdnProvider
  }
  catch {
    // EE module not available — CDN disabled
    return null
  }
}
