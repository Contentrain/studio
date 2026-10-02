#!/usr/bin/env tsx
/// <reference types="node" />
/* eslint-disable no-console -- CLI script: console output is the intended UX */
/**
 * Remove EXIF/XMP from stored WebP media and re-sanitise stored SVGs, in place and losslessly (#391).
 *
 *   pnpm media:strip-metadata --site-url https://studio.example.com            # dry run: reads and reports only
 *   pnpm media:strip-metadata --site-url https://studio.example.com --apply    # rewrite
 *
 * Options:
 *   --site-url <url>    Public origin the purge URLs are built from (or NUXT_PUBLIC_SITE_URL / NUXT_PUBLIC_CDN_URL).
 *   --apply             Rewrite files and fix `size_bytes` + the workspace storage counter. Without it nothing is written.
 *   --project <id>      Only this project.
 *   --variants          Also look at variant files (a verification pass: variants are cut without metadata).
 *   --urls-out <file>   Write the rewritten public URLs there, one per line (the CDN purge list).
 *
 * Environment (the same names the app uses): NUXT_POSTGRES_URL (or DATABASE_URL), NUXT_CDN_R2_ACCOUNT_ID,
 * NUXT_CDN_R2_ACCESS_KEY_ID, NUXT_CDN_R2_SECRET_ACCESS_KEY, NUXT_CDN_R2_BUCKET. Run with `--env-file` as in `polar:sync`.
 *
 * Storage paths do not change, so no content reference changes, but the CDN edge caches the old bytes
 * (`s-maxage=3600, stale-while-revalidate=86400`): purge the printed URLs (Cloudflare "purge by URL", 30 per call) after
 * an apply. Idempotent: a second run finds nothing. See docs/MEDIA_INGEST.md.
 */

import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { createCloudflareR2Provider } from '../ee/cdn/cloudflare-cdn'
import { formatSweepReport, purgeList, runMetadataSweep, type SweepAsset, type SweepStore } from '../ee/media/metadata-sweep'

const { values } = parseArgs({
  options: {
    'site-url': { type: 'string' },
    'apply': { type: 'boolean', default: false },
    'project': { type: 'string' },
    'variants': { type: 'boolean', default: false },
    'urls-out': { type: 'string' },
  },
})

function need(name: string, ...alternatives: string[]): string {
  const value = [name, ...alternatives].map(key => process.env[key]).find(Boolean)
  if (!value) {
    console.error(`Missing ${[name, ...alternatives].join(' / ')}`)
    process.exit(2)
  }
  return value
}

const siteUrl = values['site-url'] ?? process.env.NUXT_PUBLIC_CDN_URL ?? process.env.NUXT_PUBLIC_SITE_URL
if (!siteUrl) {
  console.error('Missing --site-url (or NUXT_PUBLIC_SITE_URL / NUXT_PUBLIC_CDN_URL)')
  process.exit(2)
}

const pool = new pg.Pool({ connectionString: need('NUXT_POSTGRES_URL', 'DATABASE_URL') })
const cdn = createCloudflareR2Provider({
  accountId: need('NUXT_CDN_R2_ACCOUNT_ID'),
  accessKeyId: need('NUXT_CDN_R2_ACCESS_KEY_ID'),
  secretAccessKey: need('NUXT_CDN_R2_SECRET_ACCESS_KEY'),
  bucket: need('NUXT_CDN_R2_BUCKET'),
})

const store: SweepStore = {
  async listAssets(afterId, limit, projectId) {
    const { rows } = await pool.query<SweepAsset>(
      `SELECT id, project_id, workspace_id, content_type, original_path, variants
         FROM public.media_assets
        WHERE ($1::uuid IS NULL OR id > $1::uuid) AND ($2::uuid IS NULL OR project_id = $2::uuid)
        ORDER BY id LIMIT $3`,
      [afterId, projectId ?? null, limit],
    )
    return rows
  },
  async applyChange(change) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE public.media_assets
            SET size_bytes = GREATEST(0, size_bytes + $2), content_hash = COALESCE($3, content_hash), updated_at = now()
          WHERE id = $1`,
        [change.assetId, change.sizeDelta, change.contentHash ?? null],
      )
      await client.query('SELECT public.increment_storage_bytes($1::uuid, $2::bigint)', [change.workspaceId, change.sizeDelta])
      await client.query('COMMIT')
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    finally {
      client.release()
    }
  },
}

try {
  const report = await runMetadataSweep({
    store,
    cdn,
    siteUrl,
    dryRun: !values.apply,
    ...(values.project ? { projectId: values.project } : {}),
    includeVariants: values.variants,
    onProgress: line => console.error(line),
  })
  console.log(formatSweepReport(report))
  if (values['urls-out']) {
    writeFileSync(values['urls-out'], purgeList(report))
    console.log(`purge list written to ${values['urls-out']}`)
  }
  else if (report.urls.length) {
    console.log('', purgeList(report).trimEnd())
  }
  process.exitCode = report.errors.length || report.svgUnsafe.length ? 1 : 0
}
finally {
  await pool.end()
}
