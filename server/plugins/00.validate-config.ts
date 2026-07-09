/**
 * Boot-time configuration validation.
 *
 * Runs once when Nitro starts — before any route is served.
 * Fails fast with a clear error if required secrets are missing or invalid.
 */

/** Decode the `role` claim from a Supabase JWT (anon / service_role). Returns null if not a decodable JWT. */
function decodeJwtRole(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const role = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')).role
    return typeof role === 'string' ? role : null
  }
  catch {
    return null
  }
}

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

  // The service-role key must actually carry the `service_role` claim. A
  // present-but-wrong key — most commonly the anon key pasted into this slot
  // — passes the "is set" checks above but silently degrades EVERY admin
  // operation to anon-level access: RLS-blocked reads return empty (e.g. the
  // billing panel shows Free despite an active subscription) and writes fail
  // with `42501`. Catch it at boot instead of shipping a container that
  // serves wrong data.
  if (config.supabase.serviceRoleKey) {
    const role = decodeJwtRole(config.supabase.serviceRoleKey)
    if (role && role !== 'service_role')
      errors.push(`NUXT_SUPABASE_SERVICE_ROLE_KEY has role "${role}" — expected "service_role" (admin ops would silently degrade to anon / RLS-blocked)`)
    if (config.supabase.anonKey && config.supabase.serviceRoleKey === config.supabase.anonKey)
      errors.push('NUXT_SUPABASE_SERVICE_ROLE_KEY must not equal NUXT_SUPABASE_ANON_KEY')
  }

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

  // CDN — optional (graceful degradation), but if R2 is configured it must be
  // configured completely.
  if (config.cdn.r2AccountId && (!config.cdn.r2AccessKeyId || !config.cdn.r2SecretAccessKey))
    warnings.push('NUXT_CDN_R2_ACCOUNT_ID is set but access credentials are incomplete — CDN disabled')
  // NUXT_CDN_R2_BUCKET has NO implicit default: a blank bucket with valid creds
  // must fail loudly rather than silently writing to a shared/prod bucket name.
  if (config.cdn.r2AccountId && config.cdn.r2AccessKeyId && config.cdn.r2SecretAccessKey && !config.cdn.r2Bucket)
    errors.push('NUXT_CDN_R2_BUCKET is required when R2 credentials are set (no implicit default — prevents silently targeting a shared bucket)')

  // Report
  for (const w of warnings)
    // eslint-disable-next-line no-console
    console.warn(`[config] ⚠ ${w}`)

  if (errors.length > 0) {
    const msg = errors.map(e => `  ✗ ${e}`).join('\n')
    throw new Error(`Boot validation failed:\n${msg}`)
  }
})
