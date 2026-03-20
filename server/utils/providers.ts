import type { AuthProvider } from '../providers/auth'
import type { AIProvider } from '../providers/ai'
import type { GitProvider } from '../providers/git'
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
