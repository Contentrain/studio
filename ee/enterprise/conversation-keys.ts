import { createError, getRouterParam, readBody, type H3Event } from 'h3'
import { requireAuth } from '../../server/utils/auth'
import { errorMessage } from '../../server/utils/content-strings'
import { getWorkspacePlan, hasFeature, getPlanLimit } from '../../server/utils/license'
import { generateConversationKey } from '../../server/utils/conversation-keys'
import { useDatabaseProvider } from '../../server/utils/providers'

export function createConversationKeysBridge() {
  return {
    async listProjectConversationKeys(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')

      if (!workspaceId || !projectId)
        throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
      const data = await db.listConversationKeys(projectId, workspaceId)

      const month = new Date().toISOString().substring(0, 7)
      const keyIds = (data ?? []).filter(k => !k.revoked_at).map(k => String(k.id))

      let usageMap: Record<string, number> = {}
      if (keyIds.length > 0) {
        const usageRows = await db.getConversationKeyUsage(keyIds, month)

        usageMap = Object.fromEntries(
          (usageRows ?? []).map(r => [String(r.api_key_id), Number(r.message_count ?? 0)]),
        )
      }

      return (data ?? []).map(key => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.key_prefix,
        role: key.role,
        specificModels: key.specific_models,
        allowedModels: key.allowed_models,
        allowedTools: key.allowed_tools,
        allowedLocales: key.allowed_locales,
        customInstructions: key.custom_instructions,
        aiModel: key.ai_model,
        rateLimitPerMinute: key.rate_limit_per_minute,
        monthlyMessageLimit: key.monthly_message_limit,
        monthlyUsage: usageMap[String(key.id)] ?? 0,
        lastUsedAt: key.last_used_at,
        createdAt: key.created_at,
        revokedAt: key.revoked_at,
      }))
    },

    async createProjectConversationKey(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const body = await readBody<{
        name: string
        role?: 'viewer' | 'editor' | 'admin'
        specificModels?: boolean
        allowedModels?: string[]
        allowedTools?: string[]
        allowedLocales?: string[]
        customInstructions?: string
        aiModel?: string
        rateLimitPerMinute?: number
        monthlyMessageLimit?: number
      }>(event)

      if (!workspaceId || !projectId)
        throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

      if (!body.name?.trim())
        throw createError({ statusCode: 400, message: errorMessage('conversation.key_name_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')

      if (!project)
        throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

      const workspace = await db.getWorkspaceById(workspaceId, 'plan')

      const plan = getWorkspacePlan(workspace ?? {})
      if (!hasFeature(plan, 'api.conversation'))
        throw createError({ statusCode: 403, message: errorMessage('conversation.upgrade') })

      const keyLimit = getPlanLimit(plan, 'api.conversation_keys')
      const count = await db.countActiveConversationKeys(projectId, workspaceId)

      if (count >= keyLimit)
        throw createError({ statusCode: 403, message: errorMessage('conversation.key_limit') })

      const validRoles = ['viewer', 'editor', 'admin']
      const role = validRoles.includes(body.role ?? '') ? body.role : 'editor'

      const validModels = ['claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001']
      const aiModel = validModels.includes(body.aiModel ?? '') ? body.aiModel : 'claude-sonnet-4-5'

      const rateLimitPerMinute = Math.max(1, Math.min(body.rateLimitPerMinute ?? 10, 60))
      const monthlyMessageLimit = Math.max(1, Math.min(body.monthlyMessageLimit ?? 1000, getPlanLimit(plan, 'api.messages_per_month')))
      const customInstructions = body.customInstructions ? body.customInstructions.substring(0, 2000) : null
      const { key, keyHash, keyPrefix } = generateConversationKey()

      const data = await db.createConversationKey({
        project_id: projectId,
        workspace_id: workspaceId,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: body.name.trim(),
        role,
        specific_models: body.specificModels ?? false,
        allowed_models: body.allowedModels ?? [],
        allowed_tools: body.allowedTools ?? [],
        allowed_locales: body.allowedLocales ?? [],
        custom_instructions: customInstructions,
        ai_model: aiModel,
        rate_limit_per_minute: rateLimitPerMinute,
        monthly_message_limit: monthlyMessageLimit,
      })

      return { ...data, key }
    },

    async updateProjectConversationKey(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const keyId = getRouterParam(event, 'keyId')
      const body = await readBody<{
        name?: string
        role?: 'viewer' | 'editor' | 'admin'
        specificModels?: boolean
        allowedModels?: string[]
        allowedTools?: string[]
        allowedLocales?: string[]
        customInstructions?: string | null
        aiModel?: string
        rateLimitPerMinute?: number
        monthlyMessageLimit?: number
      }>(event)

      if (!workspaceId || !projectId || !keyId)
        throw createError({ statusCode: 400, message: errorMessage('api.key_id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      if (body.customInstructions !== undefined) {
        const workspace = await db.getWorkspaceById(workspaceId, 'plan')

        const plan = getWorkspacePlan(workspace ?? {})
        if (!hasFeature(plan, 'api.custom_instructions') && body.customInstructions)
          throw createError({ statusCode: 403, message: errorMessage('conversation.upgrade') })
      }

      const validRoles = ['viewer', 'editor', 'admin']
      const validModels = ['claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001']

      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) updates.name = body.name.trim()
      if (body.role !== undefined && validRoles.includes(body.role)) updates.role = body.role
      if (body.specificModels !== undefined) updates.specific_models = body.specificModels
      if (body.allowedModels !== undefined) updates.allowed_models = body.allowedModels
      if (body.allowedTools !== undefined) updates.allowed_tools = body.allowedTools
      if (body.allowedLocales !== undefined) updates.allowed_locales = body.allowedLocales
      if (body.customInstructions !== undefined) updates.custom_instructions = body.customInstructions ? body.customInstructions.substring(0, 2000) : body.customInstructions
      if (body.aiModel !== undefined && validModels.includes(body.aiModel)) updates.ai_model = body.aiModel
      if (body.rateLimitPerMinute !== undefined) updates.rate_limit_per_minute = Math.max(1, Math.min(body.rateLimitPerMinute, 60))
      if (body.monthlyMessageLimit !== undefined) updates.monthly_message_limit = Math.max(1, Math.min(body.monthlyMessageLimit, 100_000))

      if (Object.keys(updates).length === 0)
        throw createError({ statusCode: 400, message: errorMessage('validation.no_fields_to_update') })

      const data = await db.updateConversationKey(keyId, projectId, workspaceId, updates)

      if (!data)
        throw createError({ statusCode: 404, message: errorMessage('conversation.key_not_found') })

      return data
    },

    async deleteProjectConversationKey(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const keyId = getRouterParam(event, 'keyId')

      if (!workspaceId || !projectId || !keyId)
        throw createError({ statusCode: 400, message: errorMessage('api.key_id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      await db.revokeConversationKey(keyId, projectId, workspaceId)

      return { revoked: true }
    },
  }
}
