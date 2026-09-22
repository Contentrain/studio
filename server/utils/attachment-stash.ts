import type { CDNProvider } from '../providers/cdn'

/**
 * Short-lived originals of chat image attachments (#289).
 *
 * A chat image reaches the model as a downscaled copy and is otherwise not
 * kept. When the agent later puts that image into an image/video/file field,
 * the write promotes it into the media library (`attachment-promotion.ts`) —
 * from the ORIGINAL bytes, which live here for a day.
 *
 * Layout: `_tmp/<workspaceId>/<projectId>/<id>` in the CDN bucket, written
 * through the CDN provider with `_tmp` in the project slot. So the objects:
 *  - sit under one top-level prefix, which an R2 lifecycle rule expires
 *    (`_tmp/`, 1 day — see the PR/deploy notes);
 *  - are outside every project's namespace, so neither the delivery route
 *    (`/api/cdn/v1/{projectId}/…`) nor a build's stale-object sweep reaches them;
 *  - are scoped to the workspace AND project the attachment was made in: a
 *    lookup builds the key from the caller's own ids, so another tenant's id
 *    resolves to nothing.
 * They do not count toward the storage quota; the promoted asset does.
 */

export const ATTACHMENT_STASH_TTL_MS = 24 * 60 * 60 * 1000

/** The pseudo project id whose namespace is the bucket's `_tmp/` prefix. */
const STASH_NAMESPACE = '_tmp'

/** `<created, base36 ms>.<128 random bits, hex>` — unguessable, and carries its own age. */
const STASH_ID = /^[0-9a-z]{6,12}\.[0-9a-f]{32}$/
const MARKER = /attachment:([0-9a-z]{6,12}\.[0-9a-f]{32})/g

export function isStashId(value: unknown): value is string {
  return typeof value === 'string' && STASH_ID.test(value)
}

/** Every stash id referenced as `attachment:<id>` inside a string. */
export function stashIdsIn(text: string): string[] {
  return [...text.matchAll(MARKER)].map(m => m[1]!)
}

export function replaceStashMarkers(text: string, urlFor: (id: string) => string | undefined): string {
  return text.replace(MARKER, (whole, id: string) => urlFor(id) ?? whole)
}

export function newStashId(now = Date.now()): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return `${now.toString(36)}.${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

/** Past its day — or malformed. Checked on read, not left to the lifecycle rule alone. */
export function isStashExpired(id: string, now = Date.now()): boolean {
  if (!isStashId(id)) return true
  const created = Number.parseInt(id.split('.')[0]!, 36)
  return !Number.isFinite(created) || now - created > ATTACHMENT_STASH_TTL_MS || created > now + 60_000
}

interface StashScope { workspaceId: string, projectId: string }

function stashPath(scope: StashScope, id: string): string {
  return `${scope.workspaceId}/${scope.projectId}/${id}`
}

export async function stashOriginal(cdn: CDNProvider, scope: StashScope, file: { buffer: Buffer, contentType: string, filename: string }): Promise<string> {
  const id = newStashId()
  const path = stashPath(scope, id)
  await cdn.putObject(STASH_NAMESPACE, path, file.buffer, file.contentType)
  await cdn.putObject(STASH_NAMESPACE, `${path}.json`, JSON.stringify({ filename: file.filename }), 'application/json')
  return id
}

export async function readStash(cdn: CDNProvider, scope: StashScope, id: string): Promise<{ buffer: Buffer, contentType: string, filename: string } | null> {
  if (isStashExpired(id)) return null
  const path = stashPath(scope, id)
  const object = await cdn.getObject(STASH_NAMESPACE, path)
  if (!object || 'notModified' in object) return null
  let filename = `${id}.bin`
  const meta = await cdn.getObject(STASH_NAMESPACE, `${path}.json`).catch(() => null)
  if (meta && !('notModified' in meta)) {
    try {
      filename = String((JSON.parse(meta.data.toString('utf-8')) as { filename?: unknown }).filename ?? filename)
    }
    catch { /* keep the fallback name */ }
  }
  return { buffer: object.data, contentType: object.contentType, filename }
}

/** The library path an attachment was already promoted to, so a second write reuses it. */
export async function readPromotion(cdn: CDNProvider, scope: StashScope, id: string): Promise<string | null> {
  const object = await cdn.getObject(STASH_NAMESPACE, `${stashPath(scope, id)}.promoted.json`).catch(() => null)
  if (!object || 'notModified' in object) return null
  try {
    const path = (JSON.parse(object.data.toString('utf-8')) as { path?: unknown }).path
    return typeof path === 'string' ? path : null
  }
  catch {
    return null
  }
}

export async function recordPromotion(cdn: CDNProvider, scope: StashScope, id: string, path: string): Promise<void> {
  await cdn.putObject(STASH_NAMESPACE, `${stashPath(scope, id)}.promoted.json`, JSON.stringify({ path }), 'application/json')
}
