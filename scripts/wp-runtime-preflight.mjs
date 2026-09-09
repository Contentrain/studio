/** Read-only browser gate for an existing generated Astro dist directory.
 * No API submission, auth, deployment, source fetch or fidelity claim.
 */
import { createServer } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

export function judgePreflight(pages, runtimePending = []) {
  const failures = []
  if (!pages.length) failures.push('no_pages_checked')
  for (const page of pages) {
    for (const key of ['navigationError', 'httpError', 'missingHeading', 'emptyComponents', 'brokenImages', 'failedAssets', 'externalRequests', 'pageErrors']) {
      const value = page[key]
      if (Array.isArray(value) ? value.length > 0 : Boolean(value)) failures.push(`${page.route}@${page.width}:${key}`)
    }
  }
  return { scope: 'read-only-browser-preflight', status: failures.length || runtimePending.length ? 'blocked' : 'preflight_passed',
    fullAcceptance: false, failures, runtimePending, pages }
}

export async function serveArtifact(directory) {
  const root = await realpath(directory)
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      let target = resolve(root, `.${pathname}`)
      if (!extname(target)) target = resolve(target, 'index.html')
      target = await realpath(target)
      if (!target.startsWith(root + sep)) {
        res.writeHead(403).end()
        return
      }
      const body = await readFile(target)
      res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    catch { res.writeHead(404).end() }
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  return { origin: `http://127.0.0.1:${server.address().port}`, close: async () => {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  } }
}

export async function runPreflight({ directory, routes, executablePath, runtimePending = [] }) {
  if (!routes.length || routes.some(route => !route.startsWith('/') || route.startsWith('//'))) throw new Error('Provide local absolute route paths')
  const site = await serveArtifact(directory)
  let browser
  const pages = []
  try {
    browser = await chromium.launch({ headless: true, executablePath })
    for (const width of [1280, 390]) {
      for (const route of routes) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' })
        const page = await context.newPage()
        const evidence = { route, width, externalRequests: [], failedAssets: [], pageErrors: [] }
        await context.route('**/*', async (requestRoute) => {
          const request = requestRoute.request()
          const url = new URL(request.url())
          if (url.origin !== site.origin || !['GET', 'HEAD'].includes(request.method())) {
            // Do not record URL queries or request bodies (potential credentials/PII).
            evidence.externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`)
            await requestRoute.abort()
          }
          else await requestRoute.continue()
        })
        await context.routeWebSocket('**/*', (socket) => {
          const url = new URL(socket.url())
          evidence.externalRequests.push(`WEBSOCKET ${url.origin}${url.pathname}`)
          socket.close()
        })
        page.on('pageerror', error => evidence.pageErrors.push(error.name || 'Error'))
        page.on('requestfailed', (request) => {
          const url = new URL(request.url())
          if (url.origin === site.origin) evidence.failedAssets.push(`request_failed ${url.pathname}`)
        })
        page.on('response', (response) => {
          if (response.status() >= 400) evidence.failedAssets.push(`${response.status()} ${new URL(response.url()).pathname}`)
        })
        try {
          const response = await page.goto(`${site.origin}${route}`, { waitUntil: 'networkidle', timeout: 30000 })
          evidence.httpError = !response || response.status() >= 400
          Object.assign(evidence, await page.evaluate(() => ({
            missingHeading: !document.querySelector('h1')?.textContent?.trim(),
            emptyComponents: [...document.querySelectorAll('cr-component')].filter(el => !el.textContent.trim() && !el.children.length).length,
            brokenImages: [...document.images].filter(img => img.complete && !img.naturalWidth).length,
          })))
        }
        catch (error) { evidence.navigationError = error.name }
        finally {
          pages.push(evidence)
          await context.close()
        }
      }
    }
    return judgePreflight(pages, runtimePending)
  }
  finally {
    await browser?.close()
    await site.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, handoffPath, ...routes] = process.argv.slice(2)
  if (!directory || !handoffPath || !routes.length) throw new Error('Usage: node scripts/wp-runtime-preflight.mjs <dist> <handoff.json> </route> ...')
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8'))
  if (handoff.version !== 1 || !Array.isArray(handoff.capabilities)) throw new Error('Invalid handoff')
  const runtimePending = handoff.capabilities.filter(cap => cap.disposition === 'needs_runtime').map(cap => cap.key)
  const report = await runPreflight({ directory, routes, runtimePending, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
  // eslint-disable-next-line no-console -- diagnostic report, no request bodies/query strings
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.status === 'blocked' ? 1 : 0
}
