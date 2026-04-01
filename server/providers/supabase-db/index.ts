/**
 * Supabase implementation of DatabaseProvider.
 *
 * Split by domain — each file under 400 lines:
 *   helpers.ts       — shared client getters, validators, cross-domain helpers
 *   workspaces.ts    — workspace CRUD + github installation + storage
 *   members.ts       — workspace members + AI keys + project/webhook queries
 *   conversations.ts — conversations, messages, agent usage
 *   media.ts         — media assets + media usage
 *   forms.ts         — form submissions
 *   projects.ts      — projects + project members
 *   cdn.ts           — CDN keys, builds, usage + conversation key validation
 *   webhooks.ts      — webhooks, deliveries, conversation key CRUD
 */
import type { DatabaseProvider } from '../database'
import { cdnMethods } from './cdn'
import { conversationMethods } from './conversations'
import { formMethods } from './forms'
import { mediaMethods } from './media'
import { memberMethods } from './members'
import { profileMethods } from './profiles'
import { projectMethods } from './projects'
import { webhookMethods } from './webhooks'
import { workspaceMethods } from './workspaces'

export { createSupabaseAdminClient, createSupabaseUserClient } from '../supabase-client'

export function createSupabaseDatabaseProvider(): DatabaseProvider {
  return {
    ...profileMethods(),
    ...workspaceMethods(),
    ...memberMethods(),
    ...conversationMethods(),
    ...mediaMethods(),
    ...formMethods(),
    ...projectMethods(),
    ...cdnMethods(),
    ...webhookMethods(),
  }
}
