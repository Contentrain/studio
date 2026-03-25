/**
 * Boot-time configuration validation.
 *
 * Runs once when Nitro starts — before any route is served.
 * Fails fast with a clear error if required secrets are missing or invalid.
 */
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  const errors: string[] = []
  const warnings: string[] = []

  // Session secret — required for cookie encryption (AES-256)
  if (!config.sessionSecret || config.sessionSecret.length < 32)
    errors.push('NUXT_SESSION_SECRET must be at least 32 characters')

  // Supabase — required for all database operations
  if (!config.supabase.url)
    errors.push('NUXT_SUPABASE_URL is required')
  if (!config.supabase.serviceRoleKey)
    errors.push('NUXT_SUPABASE_SERVICE_ROLE_KEY is required')
  if (!config.supabase.anonKey)
    errors.push('NUXT_SUPABASE_ANON_KEY is required')

  // GitHub App — required for repo operations
  if (config.github.appId) {
    if (!config.github.clientId)
      errors.push('NUXT_GITHUB_CLIENT_ID is required when NUXT_GITHUB_APP_ID is set')
    if (!config.github.clientSecret)
      errors.push('NUXT_GITHUB_CLIENT_SECRET is required when NUXT_GITHUB_APP_ID is set')
    if (!config.github.privateKey) {
      errors.push('NUXT_GITHUB_PRIVATE_KEY is required when NUXT_GITHUB_APP_ID is set (base64-encoded .pem)')
    }
    else {
      try {
        Buffer.from(config.github.privateKey, 'base64').toString('utf-8')
      }
      catch {
        errors.push('NUXT_GITHUB_PRIVATE_KEY is not valid base64')
      }
    }
    if (!config.github.webhookSecret)
      warnings.push('NUXT_GITHUB_WEBHOOK_SECRET is not set — webhook signature verification disabled')
  }

  // Anthropic — optional (BYOA fallback available)
  if (!config.anthropic.apiKey)
    warnings.push('NUXT_ANTHROPIC_API_KEY is not set — chat requires user BYOA keys')

  // CDN — optional (graceful degradation)
  if (config.cdn.r2AccountId && (!config.cdn.r2AccessKeyId || !config.cdn.r2SecretAccessKey))
    warnings.push('NUXT_CDN_R2_ACCOUNT_ID is set but access credentials are incomplete — CDN disabled')

  // Report
  for (const w of warnings)
    // eslint-disable-next-line no-console
    console.warn(`[config] ⚠ ${w}`)

  if (errors.length > 0) {
    const msg = errors.map(e => `  ✗ ${e}`).join('\n')
    throw new Error(`Boot validation failed:\n${msg}`)
  }
})
