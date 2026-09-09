/** Opt-in cross-repo acceptance. Real WP export and PostgreSQL; no production services.
 * This checks contract continuity, not browser UX, hosted storage or fidelity.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { MigrationHandoff } from '@contentrain/types'
import { createPostgresDatabaseProvider } from '../../server/providers/postgres-db'
import { importCommentsFromHandoff, syncMigrationHandoff } from '../../server/utils/migration-handoff'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const fixture = process.env.WP_ACCEPTANCE_WXR
const importerPath = process.env.WP_ACCEPTANCE_IMPORTER
const emitterPath = process.env.WP_ACCEPTANCE_EMITTER

describe.skipIf(!fixture || !importerPath || !emitterPath)('real WordPress export → Astro + Studio contract acceptance', () => {
  const db = createPostgresDatabaseProvider()
  let user: SeededUser
  let projectId: string
  beforeAll(async () => {
    user = await seedUser('wp-acceptance')
    const project = await sql<{ id: string }>`INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/wp-acceptance') RETURNING id`.execute(getDb())
    projectId = project.rows[0]!.id
    vi.stubGlobal('useDatabaseProvider', () => db)
  })
  afterAll(async () => {
    if (user) await deleteSeededUser(user.userId)
  })

  it('keeps content identities, comments/parents, form submissions and schedule acknowledgements on one project', async () => {
    const importer = await import(/* @vite-ignore */ pathToFileURL(importerPath!).href)
    const emitter = await import(/* @vite-ignore */ pathToFileURL(emitterPath!).href)
    const { raw } = await importer.parseWxr(readFileSync(fixture!, 'utf8'))
    const content = importer.rawToContentrain(raw)
    const commentExport = importer.buildCommentsExport(raw, content.entry_source_map)
    expect(raw.posts.length).toBeGreaterThan(0)
    expect(commentExport.comments.length).toBeGreaterThan(0)
    expect.soft(content.report.dropped_relations, 'Lossless import gate: unresolved relations must be explained or repaired').toBe(0)
    let parentsVerified = 0
    for (const post of raw.posts) {
      if (!post.parent) continue
      const address = content.entry_source_map[String(post.id)]
      if (!address) continue // Explicitly excluded source types have no exported entry.
      const parentAddress = content.entry_source_map[String(post.parent)]
      expect(parentAddress, `parent of WP record ${post.id}`).toBeDefined()
      const model = JSON.parse(content.files[`.contentrain/models/${address.model_id}.json`])
      const entries = JSON.parse(content.files[`.contentrain/content/${model.domain}/${address.model_id}/data.json`])
      const targets = model.fields.parent.model
      const polymorphic = Array.isArray(targets) && targets.length > 1
      expect(Array.isArray(targets) ? targets : [targets]).toContain(parentAddress.model_id)
      expect(entries[address.entry_id].parent).toEqual(polymorphic
        ? { model: parentAddress.model_id, ref: parentAddress.entry_id }
        : parentAddress.entry_id)
      parentsVerified++
    }
    const handoff: MigrationHandoff = {
      version: 1, site_url: raw.site.url, generated_at: new Date().toISOString(),
      capabilities: [{ key: 'comments', disposition: 'needs_runtime' }],
      comments: { total: commentExport.comments.length, export: { format: 'contentrain-comments@1', inline: commentExport } },
    }
    const synced = await syncMigrationHandoff({ projectId, contentRoot: '',
      project: { repo_full_name: 'contentrain/wp-acceptance', default_branch: 'main' },
      git: { readFile: async () => JSON.stringify(handoff) } as unknown as GitProvider })
    expect(synced.found).toBe(true)
    const first = await importCommentsFromHandoff(projectId, user.workspaceId, handoff, 'en')
    expect(first?.unmapped).toEqual([])
    expect(first?.orphanCount).toBe(0)
    expect(first?.inserted).toBe(commentExport.comments.length)
    const second = await importCommentsFromHandoff(projectId, user.workspaceId, handoff, 'en')
    expect(second?.inserted).toBe(0)
    expect(second?.skippedExisting).toBe(commentExport.comments.length)

    const entry = content.entry_source_map[String(commentExport.comments[0].post)]
    const form = await db.createFormSubmission({ project_id: projectId, workspace_id: user.workspaceId,
      model_id: 'contact', data: { message: 'Acceptance fixture' } })
    const approved = await db.updateFormSubmissionStatus(String(form.id), 'approved', user.userId, entry.entry_id)
    expect(approved.status).toBe('approved')

    const now = new Date()
    await db.upsertScheduledPublications([{ project_id: projectId, workspace_id: user.workspaceId,
      model_id: entry.model_id, entry_id: entry.entry_id, locale: entry.locale ?? 'en', kind: 'publish', fire_at: now.toISOString() }])
    const claimed = (await db.claimDueScheduledPublications(now, 200)).find(r => r.project_id === projectId)!
    expect(claimed.fired_at).toBeNull()
    expect(await db.settleScheduledPublication(String(claimed.id), String(claimed.claim_token), true, now)).toBe(true)

    const emitted = emitter.emitAstroProject({ ir: { version: 1, site: { url: raw.site.url, locales: ['en'] },
      routes: [{ id: 'home', pattern: '/', kind: 'front', family: 'page' }],
      families: [{ id: 'page', kind: 'page', css: { strategy: 'purge_set' }, chrome: [{ id: 'body', position: 'body', html: '<main><!--@@body@@--></main>' }] }],
      queries: [], tokens: {}, css_default: 'purge_set', viewport_strategy: 'responsive' } })
    expect(emitted.files['src/pages/index.astro']).toBeTruthy()
    // These files are deliberately NOT deployed. Source-contract continuity
    // does not prove provider-bound form/comment rendering in the emitter.
    // eslint-disable-next-line no-console -- opt-in acceptance evidence, no credentials or content
    console.log(JSON.stringify({ acceptance: 'contract-only', posts: raw.posts.length,
      mappedEntries: Object.keys(content.entry_source_map).length, droppedRelations: content.report.dropped_relations, parentsVerified, commentsImported: first?.inserted,
      commentsRetriedWithoutDuplicates: second?.skippedExisting, assetsDeclared: raw.attachments.length,
      astroFiles: Object.keys(emitted.files).length, formApproved: true, scheduleAcknowledged: true }))
  })
})
