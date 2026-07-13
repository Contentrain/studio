/**
 * OpenAI Apps domain verification. The plugin-submission portal issues a
 * token that must be served verbatim at this exact path; operators set it
 * via NUXT_OPENAI_APPS_CHALLENGE for the duration of the verification.
 * Unset (the default everywhere) → the route does not exist.
 */
export default defineEventHandler((event) => {
  const token = useRuntimeConfig().openaiAppsChallenge as string
  if (!token) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  return token
})
