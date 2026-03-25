import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertLocalSupabaseDb, executeSql, queryAsUserJson, resetDatabase } from './helpers'

const ids = {
  owner: '00000000-0000-0000-0000-000000000001',
  member: '00000000-0000-0000-0000-000000000002',
  outsider: '00000000-0000-0000-0000-000000000003',
  workspace: '10000000-0000-0000-0000-000000000001',
  projectAssigned: '20000000-0000-0000-0000-000000000001',
  projectHidden: '20000000-0000-0000-0000-000000000002',
  conversationOwner: '30000000-0000-0000-0000-000000000001',
  conversationMember: '30000000-0000-0000-0000-000000000002',
}

beforeAll(() => {
  assertLocalSupabaseDb()
})

beforeEach(() => {
  resetDatabase()
  seedFixtures()
})

describe('local Supabase RLS contracts', () => {
  it('allows workspace members to read only their own membership row', () => {
    const rows = queryAsUserJson<{ user_id: string, role: string }>(ids.member, `
      select user_id, role
      from public.workspace_members
      where workspace_id = '${ids.workspace}'
      order by user_id
    `)

    expect(rows).toEqual([
      { user_id: ids.member, role: 'member' },
    ])
  })

  it('limits non-admin workspace members to explicitly assigned projects', () => {
    const memberProjects = queryAsUserJson<{ id: string }>(ids.member, `
      select id
      from public.projects
      where workspace_id = '${ids.workspace}'
      order by id
    `)

    const ownerProjects = queryAsUserJson<{ id: string }>(ids.owner, `
      select id
      from public.projects
      where workspace_id = '${ids.workspace}'
      order by id
    `)

    expect(memberProjects).toEqual([
      { id: ids.projectAssigned },
    ])
    expect(ownerProjects).toEqual([
      { id: ids.projectAssigned },
      { id: ids.projectHidden },
    ])
  })

  it('scopes conversations and messages to the owning user', () => {
    const memberConversations = queryAsUserJson<{ id: string }>(ids.member, `
      select id
      from public.conversations
      order by id
    `)
    const memberMessages = queryAsUserJson<{ content: string }>(ids.member, `
      select content
      from public.messages
      order by content
    `)
    const outsiderMessages = queryAsUserJson<{ id: string }>(ids.outsider, `
      select id
      from public.messages
      order by id
    `)

    expect(memberConversations).toEqual([
      { id: ids.conversationMember },
    ])
    expect(memberMessages).toEqual([
      { content: 'member message' },
    ])
    expect(outsiderMessages).toEqual([])
  })
})

function seedFixtures() {
  executeSql(`
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '${ids.owner}', 'authenticated', 'authenticated', 'owner@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '${ids.member}', 'authenticated', 'authenticated', 'member@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '${ids.outsider}', 'authenticated', 'authenticated', 'outsider@example.com', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

insert into public.profiles (id, display_name, email) values
  ('${ids.owner}', 'Owner', 'owner@example.com'),
  ('${ids.member}', 'Member', 'member@example.com'),
  ('${ids.outsider}', 'Outsider', 'outsider@example.com');

insert into public.workspaces (id, name, slug, type, owner_id, plan) values
  ('${ids.workspace}', 'Studio', 'studio', 'primary', '${ids.owner}', 'team');

insert into public.workspace_members (workspace_id, user_id, role, accepted_at) values
  ('${ids.workspace}', '${ids.owner}', 'owner', now()),
  ('${ids.workspace}', '${ids.member}', 'member', now());

insert into public.projects (id, workspace_id, repo_full_name, default_branch, content_root, status) values
  ('${ids.projectAssigned}', '${ids.workspace}', 'contentrain/assigned', 'main', '/', 'active'),
  ('${ids.projectHidden}', '${ids.workspace}', 'contentrain/hidden', 'main', '/', 'active');

insert into public.project_members (project_id, user_id, role, accepted_at) values
  ('${ids.projectAssigned}', '${ids.member}', 'editor', now());

insert into public.conversations (id, project_id, user_id, title) values
  ('${ids.conversationOwner}', '${ids.projectHidden}', '${ids.owner}', 'Owner conversation'),
  ('${ids.conversationMember}', '${ids.projectAssigned}', '${ids.member}', 'Member conversation');

insert into public.messages (conversation_id, role, content) values
  ('${ids.conversationOwner}', 'user', 'owner message'),
  ('${ids.conversationMember}', 'user', 'member message');
`)
}
