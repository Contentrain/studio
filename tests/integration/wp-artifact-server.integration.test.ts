import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serveArtifact } from '../../scripts/wp-runtime-preflight.mjs'

describe('read-only artifact server', () => {
  it('serves nested routes but rejects writes, missing routes and escaping symlinks', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'cr-artifact-test-'))
    let server: Awaited<ReturnType<typeof serveArtifact>> | undefined
    try {
      const root = join(temporary, 'dist')
      await mkdir(join(root, 'article'), { recursive: true })
      await writeFile(join(root, 'article/index.html'), '<h1>Fixture</h1>')
      await writeFile(join(temporary, 'outside.txt'), 'must not be served')
      await symlink(join(temporary, 'outside.txt'), join(root, 'escape.txt'))
      server = await serveArtifact(root)
      const page = await fetch(`${server.origin}/article/`)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toBe('text/html')
      expect(await page.text()).toBe('<h1>Fixture</h1>')
      expect((await fetch(`${server.origin}/absent/`)).status).toBe(404)
      expect((await fetch(`${server.origin}/article/`, { method: 'POST' })).status).toBe(405)
      expect((await fetch(`${server.origin}/escape.txt`)).status).toBe(403)
      expect(await (await fetch(`${server.origin}/article/`, { method: 'HEAD' })).text()).toBe('')
    }
    finally {
      await server?.close()
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
