import { createError, getRouterParam, readBody, type H3Event } from 'h3'
import { useRuntimeConfig } from '#imports'
import { requireAuth } from '../../server/utils/auth'
import { errorMessage } from '../../server/utils/content-strings'
import { decryptApiKey, encryptApiKey, getKeyHint, needsReEncryption } from '../../server/utils/encryption'
import { getWorkspacePlan, hasFeature } from '../../server/utils/license'
import { useDatabaseProvider } from '../../server/utils/providers'

export async function resolveEnterpriseChatApiKey(input: {
  workspaceId: string
  userId: string
  accessToken: string
  plan: string | null | undefined
  sessionSecret: string
  previousSessionSecret?: string
  studioApiKey?: string | null
}): Promise<{ apiKey: string, usageSource: 'byoa' | 'studio' } | null> {
  if (!hasFeature(input.plan, 'ai.byoa'))
    return null

  const db = useDatabaseProvider()

  const encryptedKey = await db.getBYOAKey(input.accessToken, input.workspaceId, input.userId)

  if (encryptedKey) {
    const apiKey = decryptApiKey(encryptedKey, input.sessionSecret, input.previousSessionSecret)

    // Auto re-encrypt if key was decrypted with previous secret or older format
    if (needsReEncryption(encryptedKey, input.sessionSecret, input.previousSessionSecret)) {
      const reEncrypted = encryptApiKey(apiKey, input.sessionSecret)
      const keyHint = getKeyHint(apiKey)
      db.upsertUserAIKey(input.accessToken, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: 'anthropic',
        encryptedKey: reEncrypted,
        keyHint,
      }).catch(() => { /* best-effort re-encryption */ })
    }

    return { apiKey, usageSource: 'byoa' }
  }

  if (input.studioApiKey) {
    return {
      apiKey: input.studioApiKey,
      usageSource: 'studio',
    }
  }

  return null
}

export function createAiKeysBridge() {
  return {
    async listWorkspaceAiKeys(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')

      if (!workspaceId)
        throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])
      return db.listUserAIKeys(session.accessToken, workspaceId, session.user.id)
    },

    async createWorkspaceAiKey(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const body = await readBody<{ provider: string, apiKey: string }>(event)

      if (!workspaceId)
        throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

      if (!body.provider || !body.apiKey)
        throw createError({ statusCode: 400, message: errorMessage('api.provider_key_required') })

      if (!['anthropic'].includes(body.provider))
        throw createError({ statusCode: 400, message: errorMessage('api.unsupported_provider') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])
      const workspace = await db.getWorkspaceById(workspaceId, 'plan')

      if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'ai.byoa'))
        throw createError({ statusCode: 403, message: errorMessage('api.byoa_upgrade') })

      const runtimeConfig = useRuntimeConfig()
      const encryptedKey = encryptApiKey(body.apiKey, runtimeConfig.sessionSecret)
      const keyHint = getKeyHint(body.apiKey)

      return db.upsertUserAIKey(session.accessToken, {
        workspaceId,
        userId: session.user.id,
        provider: body.provider,
        encryptedKey,
        keyHint,
      })
    },

    async deleteWorkspaceAiKey(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const keyId = getRouterParam(event, 'keyId')

      if (!workspaceId || !keyId)
        throw createError({ statusCode: 400, message: errorMessage('api.key_id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])
      await db.deleteUserAIKey(session.accessToken, workspaceId, keyId, session.user.id)

      return { deleted: true }
    },
  }
}
