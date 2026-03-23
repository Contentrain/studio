/**
 * Cloudflare R2 CDN Provider implementation.
 *
 * S3-compatible API, zero egress fee, global edge network.
 * Uses @aws-sdk/client-s3 for R2 compatibility.
 *
 * Bucket structure: {projectId}/{path}
 * All projects share one bucket, isolated by projectId prefix.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { CDNProvider, CDNObject } from '../../server/providers/cdn'

export interface CloudflareR2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export function createCloudflareR2Provider(config: CloudflareR2Config): CDNProvider {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })

  const bucket = config.bucket

  return {
    async putObject(projectId, path, data, contentType): Promise<CDNObject> {
      const key = `${projectId}/${path}`
      const body = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
      const size = body.length

      const result = await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400',
      }))

      return {
        path,
        size,
        contentType,
        etag: result.ETag ?? '',
      }
    },

    async getObject(projectId, path) {
      const key = `${projectId}/${path}`

      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }))

        if (!result.Body) return null

        const data = Buffer.from(await result.Body.transformToByteArray())
        return {
          data,
          contentType: result.ContentType ?? 'application/octet-stream',
          etag: result.ETag ?? '',
        }
      }
      catch (e: unknown) {
        if ((e as { name?: string }).name === 'NoSuchKey') return null
        throw e
      }
    },

    async deleteObject(projectId, path) {
      const key = `${projectId}/${path}`
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }))
    },

    async deletePrefix(projectId, prefix) {
      const fullPrefix = prefix ? `${projectId}/${prefix}` : `${projectId}/`
      let continuationToken: string | undefined

      do {
        const list = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }))

        if (list.Contents?.length) {
          await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: list.Contents.map(obj => ({ Key: obj.Key! })),
            },
          }))
        }

        continuationToken = list.NextContinuationToken
      } while (continuationToken)
    },

    async listObjects(projectId, prefix?) {
      const fullPrefix = prefix ? `${projectId}/${prefix}` : `${projectId}/`
      const objects: CDNObject[] = []
      let continuationToken: string | undefined

      do {
        const list = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }))

        for (const obj of list.Contents ?? []) {
          objects.push({
            path: obj.Key?.replace(`${projectId}/`, '') ?? '',
            size: obj.Size ?? 0,
            contentType: 'application/json',
            etag: obj.ETag ?? '',
          })
        }

        continuationToken = list.NextContinuationToken
      } while (continuationToken)

      return objects
    },

    async purgeCache(_projectId, _paths?) {
      // R2 doesn't have a native cache purge API.
      // Cache-Control headers handle TTL-based invalidation.
      // For Cloudflare Workers-based edge cache, purge via Cloudflare API (future).
    },

    getStorageKey(projectId, path) {
      return `${projectId}/${path}`
    },
  }
}
