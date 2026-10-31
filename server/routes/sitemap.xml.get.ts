/**
 * GET /sitemap.xml — a real 404. Without this route the SPA fallback answers
 * with the app shell and a 200, which crawlers read as a soft 404. Studio has
 * no public pages worth a sitemap: everything past /auth/login is signed-in.
 */
export default defineEventHandler(() => {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
})
