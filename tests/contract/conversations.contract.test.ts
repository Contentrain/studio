import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conversationMethods } from '../../server/providers/postgres-db/conversations'
import { deleteSeededUser, getDb, mintAccessToken, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const MONTH = '2026-05'

describe('postgres-db conversations (contract)', () => {
  const methods = conversationMethods()
  let user: SeededUser
  let userToken: string
  let projectId: string
  let apiKeyId: string
  let conversationId: string

  beforeAll(async () => {
    user = await seedUser('conv')
    userToken = await mintAccessToken(user.userId)

    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/conv-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id

    const key = await sql<{ id: string }>`
      INSERT INTO public.conversation_api_keys (project_id, workspace_id, key_hash, key_prefix, name)
      VALUES (${projectId}, ${user.workspaceId}, ${randomUUID()}, 'crn_conv', 'conv-key') RETURNING id
    `.execute(getDb())
    apiKeyId = key.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('creates user + api conversations (title truncated to 100 chars)', async () => {
    conversationId = (await methods.createConversation(projectId, user.userId, 'x'.repeat(150)))!
    expect(conversationId).toBeTruthy()

    const apiConversationId = await methods.createApiConversation(projectId, apiKeyId, 'API chat')
    expect(apiConversationId).toBeTruthy()

    const titles = await sql<{ title: string, user_id: string | null, api_key_id: string | null }>`
      SELECT title, user_id, api_key_id FROM public.conversations WHERE id = ${conversationId}
    `.execute(getDb())
    expect(titles.rows[0]!.title).toHaveLength(100)
    expect(titles.rows[0]!.user_id).toBe(user.userId)

    // FK violation reads as null, never a throw
    expect(await methods.createConversation(randomUUID(), user.userId, 'ghost')).toBeNull()
  })

  it('getConversation honors actor filters; listConversations is RLS-scoped + newest-first', async () => {
    const found = await methods.getConversation(conversationId, projectId, { userId: user.userId })
    expect(found!.id).toBe(conversationId)
    expect(Object.keys(found!).sort()).toEqual(['api_key_id', 'created_at', 'id', 'title', 'updated_at', 'user_id'])

    expect(await methods.getConversation(conversationId, projectId, { apiKeyId })).toBeNull()
    expect(await methods.getConversation(conversationId, randomUUID())).toBeNull()

    const second = await methods.createConversation(projectId, user.userId, 'Later chat')
    const list = await methods.listConversations(userToken, projectId, user.userId)
    expect(list.map(c => c.id)).toEqual([second, conversationId])
    expect(Object.keys(list[0]!).sort()).toEqual(['created_at', 'id', 'title', 'updated_at'])

    await methods.deleteConversation(userToken, second!, user.userId, projectId)
    expect((await methods.listConversations(userToken, projectId, user.userId)).map(c => c.id)).toEqual([conversationId])
  })

  it('persists message batches and loads them in protocol order with field projection', async () => {
    const turnId = randomUUID()
    const base = {
      conversationId,
      turnId,
      internal: false,
      contentBlocks: null,
      toolCalls: null,
      iteration: null,
    }

    await methods.insertMessages([
      { ...base, role: 'user', content: 'Hello', turnSequence: 0 },
      { ...base, role: 'assistant', content: 'Working…', turnSequence: 1, internal: true, iteration: 1, toolCalls: [{ name: 'contentrain_status', args: {} }] },
      { ...base, role: 'assistant', content: 'Done', turnSequence: 2, contentBlocks: [{ type: 'text', text: 'Done' }], tokenCountInput: 10, tokenCountOutput: 5, model: 'claude-sonnet-5' },
    ])
    await methods.insertMessage({ ...base, role: 'user', content: 'Thanks', turnSequence: 0, turnId: randomUUID() })

    const visible = await methods.loadConversationMessages(conversationId, 20)
    expect(visible.map(m => m.content)).toEqual(['Hello', 'Done', 'Thanks'])
    expect(Object.keys(visible[0]!).sort()).toEqual(
      ['content', 'content_blocks', 'internal', 'iteration', 'role', 'tool_calls', 'turn_id', 'turn_sequence'],
    )

    const all = await methods.loadConversationMessages(conversationId, 20, 'role, content, tool_calls, internal', { includeInternal: true })
    expect(all).toHaveLength(4)
    expect(all[1]!.internal).toBe(true)
    expect(all[1]!.tool_calls).toEqual([{ name: 'contentrain_status', args: {} }])

    // jsonb round-trip: content_blocks stays a JSON array, not a pg array
    const blocks = await sql<{ content_blocks: unknown }>`
      SELECT content_blocks FROM public.messages
      WHERE conversation_id = ${conversationId} AND content = 'Done'
    `.execute(getDb())
    expect(blocks.rows[0]!.content_blocks).toEqual([{ type: 'text', text: 'Done' }])

    // limit applies after protocol ordering
    const limited = await methods.loadConversationMessages(conversationId, 2)
    expect(limited.map(m => m.content)).toEqual(['Hello', 'Done'])

    await methods.updateConversationTimestamp(conversationId)
  })

  it('agent usage: atomic quota, token accounting, revert, aggregates', async () => {
    const first = await methods.incrementAgentUsageIfAllowed({
      workspaceId: user.workspaceId,
      userId: user.userId,
      month: MONTH,
      source: 'studio',
      limit: 2,
    })
    expect(first).toEqual({ allowed: true, currentCount: 1 })

    await methods.incrementAgentUsageIfAllowed({ workspaceId: user.workspaceId, userId: user.userId, month: MONTH, source: 'studio', limit: 2 })
    const denied = await methods.incrementAgentUsageIfAllowed({ workspaceId: user.workspaceId, userId: user.userId, month: MONTH, source: 'studio', limit: 2 })
    expect(denied.allowed).toBe(false)
    expect(denied.currentCount).toBe(2)

    await methods.updateAgentUsageTokens({
      workspaceId: user.workspaceId,
      userId: user.userId,
      month: MONTH,
      source: 'studio',
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 20,
    })

    const usage = await methods.getAgentUsage(user.workspaceId, MONTH, 'studio', { userId: user.userId })
    expect(usage!.message_count).toBe(2)
    expect(usage!.input_tokens).toBe(100)
    expect(usage!.output_tokens).toBe(40)

    await methods.decrementAgentUsage({ workspaceId: user.workspaceId, userId: user.userId, month: MONTH, source: 'studio' })
    const afterRevert = await methods.getAgentUsage(user.workspaceId, MONTH, 'studio', { userId: user.userId })
    expect(afterRevert!.message_count).toBe(1)

    expect(await methods.getMonthlyUsageSummary(user.workspaceId, user.userId, MONTH)).toBe(1)
    expect(await methods.getAgentUsage(user.workspaceId, '2026-01', 'studio', { userId: user.userId })).toBeNull()
  })

  it('upsertAgentUsage accumulates and never throws', async () => {
    const input = {
      workspaceId: user.workspaceId,
      userId: user.userId,
      month: '2026-06',
      source: 'byoa' as const,
      messageCount: 3,
      inputTokens: 10,
      outputTokens: 5,
    }
    await methods.upsertAgentUsage(input)
    await methods.upsertAgentUsage(input)

    const usage = await methods.getAgentUsage(user.workspaceId, '2026-06', 'byoa', { userId: user.userId })
    expect(usage!.message_count).toBe(6)
    expect(usage!.input_tokens).toBe(20)

    // invalid workspace → swallowed, no throw
    await expect(methods.upsertAgentUsage({ ...input, workspaceId: 'not-a-uuid' })).resolves.toBeUndefined()
  })

  it('API usage: key/workspace limits with reasons, tokens, revert', async () => {
    const grant = await methods.incrementAPIUsageIfAllowed({
      workspaceId: user.workspaceId,
      apiKeyId,
      month: MONTH,
      keyLimit: 1,
      workspaceLimit: 10,
    })
    expect(grant).toEqual({ allowed: true, reason: 'ok', current: 1 })

    const keyDenied = await methods.incrementAPIUsageIfAllowed({
      workspaceId: user.workspaceId,
      apiKeyId,
      month: MONTH,
      keyLimit: 1,
      workspaceLimit: 10,
    })
    expect(keyDenied.allowed).toBe(false)
    expect(keyDenied.reason).toBe('key_limit')

    const wsDenied = await methods.incrementAPIUsageIfAllowed({
      workspaceId: user.workspaceId,
      apiKeyId,
      month: MONTH,
      keyLimit: 10,
      workspaceLimit: 1,
    })
    expect(wsDenied.reason).toBe('workspace_limit')

    await methods.updateAPIUsageTokens({
      workspaceId: user.workspaceId,
      apiKeyId,
      month: MONTH,
      inputTokens: 50,
      outputTokens: 25,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    })
    const row = await sql<{ message_count: number, input_tokens: number }>`
      SELECT message_count, input_tokens FROM public.api_message_usage
      WHERE workspace_id = ${user.workspaceId} AND api_key_id = ${apiKeyId} AND month = ${MONTH}
    `.execute(getDb())
    expect(row.rows[0]!.message_count).toBe(1)
    expect(row.rows[0]!.input_tokens).toBe(50)

    await methods.decrementAPIUsage({ workspaceId: user.workspaceId, apiKeyId, month: MONTH })
    const reverted = await sql<{ message_count: number }>`
      SELECT message_count FROM public.api_message_usage
      WHERE workspace_id = ${user.workspaceId} AND api_key_id = ${apiKeyId} AND month = ${MONTH}
    `.execute(getDb())
    expect(reverted.rows[0]!.message_count).toBe(0)
  })

  it('getBYOAKey returns the caller\'s anthropic key ciphertext under RLS', async () => {
    expect(await methods.getBYOAKey(userToken, user.workspaceId, user.userId)).toBeNull()

    await sql`
      INSERT INTO public.ai_keys (workspace_id, user_id, provider, encrypted_key, key_hint)
      VALUES (${user.workspaceId}, ${user.userId}, 'anthropic', 'v1:byoa-cipher', '…hint')
    `.execute(getDb())

    expect(await methods.getBYOAKey(userToken, user.workspaceId, user.userId)).toBe('v1:byoa-cipher')
    expect(await methods.getBYOAKey('broken-token', user.workspaceId, user.userId)).toBeNull()
  })
})
