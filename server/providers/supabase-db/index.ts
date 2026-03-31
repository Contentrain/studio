/**
 * Supabase implementation of DatabaseProvider.
 *
 * Split by domain:
 *   helpers.ts    — shared client getters, validators, cross-domain helpers
 *   workspaces.ts — workspace CRUD + github installation + storage
 *   members.ts    — workspace members + AI keys + project/webhook queries
 *   stubs.ts      — not-yet-implemented methods (shrinks as domains are added)
 *
 * Future domain files: conversations.ts, media.ts, forms.ts, projects.ts
 */
import type { DatabaseProvider } from '../database'
import { cdnMethods } from './cdn'
import { conversationMethods } from './conversations'
import { formMethods } from './forms'
import { getAdmin, getUser } from './helpers'
import { mediaMethods } from './media'
import { memberMethods } from './members'
import { projectMethods } from './projects'
import { stubMethods } from './stubs'
import { workspaceMethods } from './workspaces'

export { createSupabaseAdminClient, createSupabaseUserClient } from '../supabase-client'

export function createSupabaseDatabaseProvider(): DatabaseProvider {
  return {
    getAdminClient: getAdmin,
    getUserClient: getUser,
    ...workspaceMethods(),
    ...memberMethods(),
    ...conversationMethods(),
    ...mediaMethods(),
    ...formMethods(),
    ...projectMethods(),
    ...cdnMethods(),
    ...stubMethods(),
  }
}
