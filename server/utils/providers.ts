import type { AuthProvider } from '../providers/auth'
import type { AIProvider } from '../providers/ai'
import type { GitProvider } from '../providers/git'
import type { CDNProvider, CDNObject } from '../providers/cdn'
import type { MediaProvider } from '../providers/media'
import { createSharpMediaProvider } from '../../ee/media/sharp-processor'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createSupabaseAuthProvider } from '../providers/supabase-auth'
import { createGitHubAppProvider } from '../providers/github-app'
import { createAnthropicProvider } from '../providers/anthropic-ai'

/**
 * Singleton provider instances.
 *
 * All server code accesses providers through this factory — never by
 * importing concrete implementations directly. Swap the create*() call
 * to switch providers (e.g. AuthJS, Clerk, GitLab, Bitbucket, OpenAI).
 */

let _authProvider: AuthProvider | null = null
let _aiProvider: AIProvider | null = null
let _cdnProvider: CDNProvider | null = null
let _mediaProvider: MediaProvider | null = null

export function useAuthProvider(): AuthProvider {
  if (!_authProvider)
    _authProvider = createSupabaseAuthProvider()

  return _authProvider
}

/**
 * AI Provider (singleton).
 *
 * Abstracts AI model interaction. Current: Anthropic.
 * Future: swap createAnthropicProvider with createOpenAIProvider, etc.
 * Or resolve dynamically based on user's BYOA key provider.
 */
export function useAIProvider(): AIProvider {
  if (!_aiProvider)
    _aiProvider = createAnthropicProvider()

  return _aiProvider
}

/**
 * Create a GitProvider scoped to a specific repository.
 *
 * Unlike AuthProvider (singleton), GitProvider is per-repo because
 * each repository has its own owner/repo/installationId context.
 *
 * Future: swap createGitHubAppProvider with createGitLabProvider, etc.
 */
export function useGitProvider(options: {
  installationId: number
  owner: string
  repo: string
}): GitProvider {
  const config = useRuntimeConfig()

  // Decode base64 PEM
  const privateKey = Buffer.from(config.github.privateKey, 'base64').toString('utf-8')

  return createGitHubAppProvider({
    appId: config.github.appId,
    privateKey,
    installationId: options.installationId,
    owner: options.owner,
    repo: options.repo,
  })
}

/**
 * CDN Provider (singleton).
 *
 * Returns null if CDN is not configured (no R2 credentials).
 * EE implementation: Cloudflare R2.
 */
export function useCDNProvider(): CDNProvider | null {
  if (_cdnProvider) return _cdnProvider

  const config = useRuntimeConfig()
  const { r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket } = config.cdn as {
    r2AccountId: string
    r2AccessKeyId: string
    r2SecretAccessKey: string
    r2Bucket: string
  }

  // CDN not configured — graceful null
  if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey) return null

  // Inline R2 provider creation (avoids dynamic import issues with Nitro bundler)
  _cdnProvider = createR2Provider({
    accountId: r2AccountId,
    accessKeyId: r2AccessKeyId,
    secretAccessKey: r2SecretAccessKey,
    bucket: r2Bucket || 'contentrain-cdn',
  })

  return _cdnProvider
}

/**
 * Media Provider (singleton).
 *
 * Returns null if CDN/R2 is not configured (media requires object storage).
 * Uses Sharp for image processing + CDNProvider for R2 storage.
 */
export function useMediaProvider(): MediaProvider | null {
  if (_mediaProvider) return _mediaProvider

  const cdn = useCDNProvider()
  if (!cdn) return null

  _mediaProvider = createSharpMediaProvider({ cdn, admin: useSupabaseAdmin() })

  return _mediaProvider
}

/**
 * Create Cloudflare R2 CDN provider inline.
 * Uses @aws-sdk/client-s3 for S3-compatible API.
 */
function createR2Provider(r2Config: {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}): CDNProvider {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2Config.accessKeyId,
      secretAccessKey: r2Config.secretAccessKey,
    },
  })

  const bucket = r2Config.bucket

  return {
    async putObject(projectId, path, data, contentType) {
      const key = `${projectId}/${path}`
      const body = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data

      const result = await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400',
      }))

      return { path, size: body.length, contentType, etag: result.ETag ?? '' }
    },

    async getObject(projectId, path) {
      const key = `${projectId}/${path}`
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        if (!result.Body) return null
        const data = Buffer.from(await result.Body.transformToByteArray())
        return { data, contentType: result.ContentType ?? 'application/octet-stream', etag: result.ETag ?? '' }
      }
      catch (e: unknown) {
        if ((e as { name?: string }).name === 'NoSuchKey') return null
        throw e
      }
    },

    async deleteObject(projectId, path) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${projectId}/${path}` }))
    },

    async deletePrefix(projectId, prefix) {
      const fullPrefix = prefix ? `${projectId}/${prefix}` : `${projectId}/`
      let continuationToken: string | undefined
      do {
        const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: fullPrefix, ContinuationToken: continuationToken }))
        if (list.Contents?.length) {
          await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: list.Contents.map(obj => ({ Key: obj.Key! })) } }))
        }
        continuationToken = list.NextContinuationToken
      } while (continuationToken)
    },

    async listObjects(projectId, prefix?) {
      const fullPrefix = prefix ? `${projectId}/${prefix}` : `${projectId}/`
      const objects: CDNObject[] = []
      let continuationToken: string | undefined
      do {
        const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: fullPrefix, ContinuationToken: continuationToken }))
        for (const obj of list.Contents ?? []) {
          objects.push({ path: obj.Key?.replace(`${projectId}/`, '') ?? '', size: obj.Size ?? 0, contentType: 'application/json', etag: obj.ETag ?? '' })
        }
        continuationToken = list.NextContinuationToken
      } while (continuationToken)
      return objects
    },

    async purgeCache() {
      // R2 uses Cache-Control headers for TTL-based invalidation
    },

    getStorageKey(projectId, path) {
      return `${projectId}/${path}`
    },
  }
}
