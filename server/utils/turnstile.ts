/**
 * Cloudflare Turnstile server-side verification, shared by the public
 * forms and comments endpoints.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Secret comes from `runtimeConfig.turnstile.secretKey`
 * (NUXT_TURNSTILE_SECRET_KEY). An unset secret fails closed: a model that
 * asks for captcha never accepts an unverified submission.
 */

export function isTurnstileConfigured(): boolean {
  const config = useRuntimeConfig()
  return Boolean(config.turnstile?.secretKey)
}

export async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  const config = useRuntimeConfig()
  const secret = config.turnstile?.secretKey ?? ''
  if (!secret || !token) return false

  try {
    const params = new URLSearchParams({ secret, response: token })
    if (remoteIp && remoteIp !== 'unknown') params.set('remoteip', remoteIp)
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
    const result = await response.json() as { success?: boolean }
    return result.success === true
  }
  catch {
    return false
  }
}
