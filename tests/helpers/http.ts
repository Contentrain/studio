import type { EventHandler } from 'h3'
import { createServer } from 'node:http'
import { createApp, toNodeListener } from 'h3'

interface TestRoute {
  path: string
  handler: EventHandler
}

interface TestServerOptions {
  middleware?: EventHandler[]
  routes: TestRoute[]
}

export class TestCookieJar {
  private readonly cookies = new Map<string, string>()

  absorb(response: Response) {
    for (const cookie of getSetCookieValues(response.headers)) {
      const [pair = ''] = cookie.split(';', 1)
      const [name, value = ''] = pair.split('=')
      if (!name) continue

      const isCleared = /max-age=0/i.test(cookie) || value === ''
      if (isCleared) {
        this.cookies.delete(name)
        continue
      }

      this.cookies.set(name, value)
    }
  }

  header() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }

  has(name: string) {
    return this.cookies.has(name)
  }
}

export async function withTestServer<T>(
  options: TestServerOptions,
  run: (ctx: {
    baseUrl: string
    request: (path: string, init?: RequestInit) => Promise<Response>
  }) => Promise<T>,
) {
  const app = createApp()

  for (const middleware of options.middleware ?? []) {
    app.use(middleware)
  }

  for (const route of options.routes) {
    app.use(route.path, route.handler)
  }

  const server = createServer(toNodeListener(app))

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to resolve test server address')
  }

  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    return await run({
      baseUrl,
      request: (path, init) => fetch(`${baseUrl}${path}`, init),
    })
  }
  finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

function getSetCookieValues(headers: Headers) {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie()
  }

  const header = headers.get('set-cookie')
  return header ? [header] : []
}
