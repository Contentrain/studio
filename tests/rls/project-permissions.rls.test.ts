import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertDbReachable, executeSql, queryAsUserJson, queryJson, resetDatabase } from './helpers'

const ids = {
  owner: '00000000-0000-0000-0000-000000000001',
  member: '00000000-0000-0000-0000-000000000002',
  outsider: '00000000-0000-0000-0000-000000000003',
  workspace: '10000000-0000-0000-0000-000000000001',
  projectAssigned: '20000000-0000-0000-0000-000000000001',
  projectHidden: '20000000-0000-0000-0000-000000000002',
  conversationOwner: '30000000-0000-0000-0000-000000000001',
  conversationMember: '30000000-0000-0000-0000-000000000002',
  commentAssigned: '40000000-0000-0000-0000-000000000001',
  commentHidden: '40000000-0000-0000-0000-000000000002',
}

beforeAll(() => {
  assertDbReachable()
})

beforeEach(() => {
  resetDatabase()
  seedFixtures()
})

describe('rls contracts (request.jwt.claim.sub GUC — Supabase local + plain PG)', () => {
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

  it('lets workspace members read comments and comment threads, keeps outsiders out, and reserves moderation for owner/admin', () => {
    const memberComments = queryAsUserJson<{ id: string }>(ids.member, `
      select id
      from public.comments
      order by id
    `)
    const memberThreads = queryAsUserJson<{ entry_id: string }>(ids.member, `
      select entry_id
      from public.comment_threads
      order by entry_id
    `)
    const outsiderComments = queryAsUserJson<{ id: string }>(ids.outsider, `
      select id
      from public.comments
      order by id
    `)
    // UPDATE is policy-filtered to owner/admin: a plain member's update touches zero rows.
    executeSql(`
begin;
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '${ids.member}';
update public.comments set status = 'approved' where id = '${ids.commentAssigned}';
commit;
`)
    const afterMemberUpdate = queryJson<{ status: string }>(`
      select status from public.comments where id = '${ids.commentAssigned}'
    `)

    expect(memberComments).toEqual([
      { id: ids.commentAssigned },
      { id: ids.commentHidden },
    ])
    expect(memberThreads).toEqual([{ entry_id: 'entry-1' }])
    expect(outsiderComments).toEqual([])
    expect(afterMemberUpdate).toEqual([{ status: 'pending' }])
  })
})

function seedFixtures() {
  // auth.users INSERT sticks to the columns both schemas share (GoTrue's
  // table on Supabase, the auth shim's on plain PG) — id, email,
  // raw_user_meta_data. Triggers are suppressed so the fixtures below stay
  // exact instead of racing handle_new_user's auto-bootstrap; superuser is
  // guaranteed on both backends (supabase local + throwaway/CI postgres).
  executeSql(`
set session_replication_role = replica;
insert into auth.users (id, email, raw_user_meta_data) values
  ('${ids.owner}', 'owner@example.com', '{}'),
  ('${ids.member}', 'member@example.com', '{}'),
  ('${ids.outsider}', 'outsider@example.com', '{}');
set session_replication_role = origin;

insert into public.profiles (id, display_name, email) values
  ('${ids.owner}', 'Owner', 'owner@example.com'),
  ('${ids.member}', 'Member', 'member@example.com'),
  ('${ids.outsider}', 'Outsider', 'outsider@example.com');

insert into public.workspaces (id, name, slug, type, owner_id, plan) values
  ('${ids.workspace}', 'Studio', 'studio', 'primary', '${ids.owner}', 'pro');

insert into public.workspace_members (workspace_id, user_id, role, accepted_at) values
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

insert into public.comments (id, project_id, workspace_id, model_id, entry_id, author_name, body, status) values
  ('${ids.commentAssigned}', '${ids.projectAssigned}', '${ids.workspace}', 'posts', 'entry-1', 'Ada', 'assigned comment', 'pending'),
  ('${ids.commentHidden}', '${ids.projectHidden}', '${ids.workspace}', 'posts', 'entry-2', 'Bob', 'hidden comment', 'approved');

insert into public.comment_threads (project_id, workspace_id, model_id, entry_id, closed_at) values
  ('${ids.projectAssigned}', '${ids.workspace}', 'posts', 'entry-1', now());
`)
}
