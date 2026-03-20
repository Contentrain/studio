-- Phase 2: Chat Engine tables
-- conversations, messages, ai_keys, agent_usage

-- ============================================================
-- CONVERSATIONS
-- Per-project chat threads. Each user has their own conversations.
-- ============================================================

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- MESSAGES
-- Individual chat messages within a conversation.
-- role: user | assistant | system
-- tool_calls: JSON array of { id, name, input, result } for agent tool usage
-- ============================================================

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  tool_calls jsonb,
  token_count_input integer default 0,
  token_count_output integer default 0,
  model text,
  created_at timestamptz default now()
);

-- ============================================================
-- AI KEYS (BYOA)
-- Encrypted API keys for user's own AI providers.
-- encrypted_key: AES-256-GCM encrypted, base64 encoded
-- key_hint: last 4 chars for display ("...abcd")
-- ============================================================

create table if not exists public.ai_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai')),
  encrypted_key text not null,
  key_hint text,
  created_at timestamptz default now(),
  unique(workspace_id, user_id, provider)
);

-- ============================================================
-- AGENT USAGE
-- Monthly usage tracking per user per workspace.
-- source: 'studio' (Studio-hosted key) | 'byoa' (user's own key)
-- ============================================================

create table if not exists public.agent_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  month text not null,
  message_count integer default 0,
  input_tokens bigint default 0,
  output_tokens bigint default 0,
  source text not null default 'studio' check (source in ('studio', 'byoa')),
  updated_at timestamptz default now(),
  unique(workspace_id, user_id, month, source)
);

-- ============================================================
-- INDEXES
-- ============================================================

create index if not exists idx_conversations_project on public.conversations(project_id);
create index if not exists idx_conversations_user on public.conversations(user_id);
create index if not exists idx_messages_conversation on public.messages(conversation_id);
create index if not exists idx_ai_keys_workspace on public.ai_keys(workspace_id);
create index if not exists idx_agent_usage_workspace_month on public.agent_usage(workspace_id, month);

-- ============================================================
-- ROW LEVEL SECURITY
-- Terminal policies — no cross-table recursion
-- ============================================================

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_keys enable row level security;
alter table public.agent_usage enable row level security;

-- Conversations: user sees own conversations
create policy "Users can view own conversations"
  on public.conversations for select
  using (user_id = auth.uid());

create policy "Users can create conversations"
  on public.conversations for insert
  with check (user_id = auth.uid());

create policy "Users can update own conversations"
  on public.conversations for update
  using (user_id = auth.uid());

-- Messages: user sees messages in own conversations (via conversation ownership)
create policy "Users can view own messages"
  on public.messages for select
  using (
    exists (
      select 1 from public.conversations
      where conversations.id = messages.conversation_id
      and conversations.user_id = auth.uid()
    )
  );

create policy "Users can insert own messages"
  on public.messages for insert
  with check (
    exists (
      select 1 from public.conversations
      where conversations.id = messages.conversation_id
      and conversations.user_id = auth.uid()
    )
  );

-- AI Keys: user manages own keys only
create policy "Users can view own AI keys"
  on public.ai_keys for select
  using (user_id = auth.uid());

create policy "Users can create AI keys"
  on public.ai_keys for insert
  with check (user_id = auth.uid());

create policy "Users can update own AI keys"
  on public.ai_keys for update
  using (user_id = auth.uid());

create policy "Users can delete own AI keys"
  on public.ai_keys for delete
  using (user_id = auth.uid());

-- Agent Usage: user sees own usage
create policy "Users can view own usage"
  on public.agent_usage for select
  using (user_id = auth.uid());
