-- ============================================================================
-- Coze Studio — Supabase Port: initial schema
--
-- Replaces the original middleware stack with pure Supabase primitives:
--   MySQL          -> Postgres
--   Milvus         -> pgvector (hnsw, cosine)
--   Elasticsearch  -> Postgres full-text search (tsvector + RRF hybrid)
--   MinIO          -> Supabase Storage (bucket: knowledge)
--   Casbin/session -> Supabase Auth + RLS (workspace-based multi-tenancy)
-- ============================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- tenants: workspaces + membership
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  plan       text not null default 'free',
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

create or replace function public.is_ws_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_ws_admin(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

-- creator automatically becomes owner member
create or replace function public.handle_workspace_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end $$;

create trigger trg_workspaces_owner
  after insert on public.workspaces
  for each row execute function public.handle_workspace_insert();

create trigger trg_workspaces_updated
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- agents (bots)
-- ---------------------------------------------------------------------------
create table public.agents (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  name                text not null,
  description         text not null default '',
  icon_url            text,
  prompt              text not null default '',
  model               jsonb not null default '{}'::jsonb, -- { model, temperature, max_tokens }
  welcome_message     text not null default '',
  suggested_questions jsonb not null default '[]'::jsonb,
  dataset_ids         uuid[] not null default '{}',
  plugin_tool_ids     uuid[] not null default '{}',
  workflow_ids        uuid[] not null default '{}',
  variables           jsonb not null default '{}'::jsonb,
  status              text not null default 'draft' check (status in ('draft', 'published')),
  published_at        timestamptz,
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index agents_ws_idx on public.agents (workspace_id, updated_at desc);

create trigger trg_agents_updated
  before update on public.agents
  for each row execute function public.set_updated_at();

create table public.agent_releases (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references public.agents (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version    int not null,
  snapshot   jsonb not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (agent_id, version)
);

-- ---------------------------------------------------------------------------
-- conversations + messages
-- ---------------------------------------------------------------------------
create table public.conversations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id     uuid not null references public.agents (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null,
  title        text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index conversations_ws_agent_idx on public.conversations (workspace_id, agent_id, updated_at desc);

create trigger trg_conversations_updated
  before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  role            text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content         text not null default '',
  tool_calls      jsonb,
  meta            jsonb not null default '{}'::jsonb, -- usage, retrieval refs, tool log
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- knowledge: datasets -> documents -> chunks (pgvector + FTS)
-- ---------------------------------------------------------------------------
create table public.datasets (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  name           text not null,
  description    text not null default '',
  embedding_model text not null default 'jina-embeddings-v3',
  chunk_size     int not null default 1000,
  chunk_overlap  int not null default 150,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index datasets_ws_idx on public.datasets (workspace_id);

create trigger trg_datasets_updated
  before update on public.datasets
  for each row execute function public.set_updated_at();

create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  dataset_id   uuid not null references public.datasets (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  source_type  text not null default 'upload' check (source_type in ('upload', 'text', 'url')),
  storage_path text,
  size_bytes   bigint not null default 0,
  status       text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error        text,
  chunk_count  int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index documents_dataset_idx on public.documents (dataset_id, created_at desc);

create trigger trg_documents_updated
  before update on public.documents
  for each row execute function public.set_updated_at();

create table public.chunks (
  id           bigint generated always as identity primary key,
  document_id  uuid not null references public.documents (id) on delete cascade,
  dataset_id   uuid not null references public.datasets (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  seq          int not null default 0,
  content      text not null,
  embedding    vector(1024),
  fts          tsvector generated always as (to_tsvector('simple', content)) stored,
  meta         jsonb not null default '{}'::jsonb
);

create index chunks_dataset_idx on public.chunks (workspace_id, dataset_id);
create index chunks_document_idx on public.chunks (document_id);
create index chunks_embedding_idx on public.chunks using hnsw (embedding vector_cosine_ops);
create index chunks_fts_idx on public.chunks using gin (fts);

-- Hybrid retrieval: vector similarity + keyword FTS fused with Reciprocal Rank
-- Fusion. This replaces the Milvus + Elasticsearch retrieval pipeline.
create or replace function public.match_chunks(
  p_workspace_id uuid,
  p_dataset_ids  uuid[],
  p_query        text,
  p_embedding    vector(1024),
  p_limit        int default 8
)
returns table (
  chunk_id    bigint,
  document_id uuid,
  dataset_id  uuid,
  content     text,
  score       double precision
)
language sql stable set search_path = public as $$
  with vec as (
    select c.id, c.document_id, c.dataset_id, c.content,
           row_number() over (order by c.embedding <=> p_embedding) as vrank
    from public.chunks c
    where c.workspace_id = p_workspace_id
      and c.dataset_id = any (p_dataset_ids)
      and c.embedding is not null
    order by c.embedding <=> p_embedding
    limit greatest(p_limit * 4, 24)
  ),
  kw as (
    select c.id,
           row_number() over (
             order by ts_rank_cd(c.fts, websearch_to_tsquery('simple', p_query)) desc
           ) as krank
    from public.chunks c
    where c.workspace_id = p_workspace_id
      and c.dataset_id = any (p_dataset_ids)
      and c.fts @@ websearch_to_tsquery('simple', p_query)
    limit greatest(p_limit * 4, 24)
  )
  select v.id, v.document_id, v.dataset_id, v.content,
         coalesce(1.0 / (60 + v.vrank), 0) + coalesce(1.0 / (60 + k.krank), 0) as score
  from vec v
  left join kw k on k.id = v.id
  order by score desc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- workflows
-- ---------------------------------------------------------------------------
create table public.workflows (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  description  text not null default '',
  graph        jsonb not null default '{"nodes": [], "edges": []}'::jsonb,
  status       text not null default 'draft' check (status in ('draft', 'published')),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index workflows_ws_idx on public.workflows (workspace_id, updated_at desc);

create trigger trg_workflows_updated
  before update on public.workflows
  for each row execute function public.set_updated_at();

create table public.workflow_runs (
  id           uuid primary key default gen_random_uuid(),
  workflow_id  uuid not null references public.workflows (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  status       text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  input        jsonb not null default '{}'::jsonb,
  output       jsonb,
  node_results jsonb,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index workflow_runs_wf_idx on public.workflow_runs (workflow_id, started_at desc);

-- ---------------------------------------------------------------------------
-- plugins: HTTP tools callable by agents/workflows
-- ---------------------------------------------------------------------------
create table public.plugins (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  description  text not null default '',
  base_url     text not null,
  auth         jsonb not null default '{"type": "none"}'::jsonb, -- {type, in, name, value}
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index plugins_ws_idx on public.plugins (workspace_id);

create trigger trg_plugins_updated
  before update on public.plugins
  for each row execute function public.set_updated_at();

create table public.plugin_tools (
  id           uuid primary key default gen_random_uuid(),
  plugin_id    uuid not null references public.plugins (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  description  text not null default '',
  method       text not null default 'GET' check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path         text not null default '/',
  parameters   jsonb not null default '[]'::jsonb, -- [{name, in: query|path|body, required, schema, description}]
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index plugin_tools_plugin_idx on public.plugin_tools (plugin_id);
create index plugin_tools_ws_idx on public.plugin_tools (workspace_id);

create trigger trg_plugin_tools_updated
  before update on public.plugin_tools
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- api keys (workspace-scoped programmatic access, `czk_...`)
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  prefix       text not null,             -- first 10 chars, for display
  key_hash     text not null unique,      -- sha-256 hex of the full key
  created_by   uuid references auth.users (id) on delete set null,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index api_keys_ws_idx on public.api_keys (workspace_id);

-- ---------------------------------------------------------------------------
-- usage metering (per-tenant token accounting)
-- ---------------------------------------------------------------------------
create table public.usage_events (
  id                bigint generated always as identity primary key,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  kind              text not null check (kind in ('chat', 'embedding', 'workflow')),
  model             text not null default '',
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  meta              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index usage_events_ws_idx on public.usage_events (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — hard multi-tenant isolation.
-- The Worker uses the service role and re-checks membership in middleware;
-- these policies protect any direct PostgREST/Realtime access from clients.
-- ---------------------------------------------------------------------------
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.agents            enable row level security;
alter table public.agent_releases    enable row level security;
alter table public.conversations     enable row level security;
alter table public.messages          enable row level security;
alter table public.datasets          enable row level security;
alter table public.documents         enable row level security;
alter table public.chunks            enable row level security;
alter table public.workflows         enable row level security;
alter table public.workflow_runs     enable row level security;
alter table public.plugins           enable row level security;
alter table public.plugin_tools      enable row level security;
alter table public.api_keys          enable row level security;
alter table public.usage_events      enable row level security;

create policy workspaces_select on public.workspaces
  for select using (public.is_ws_member(id));
create policy workspaces_insert on public.workspaces
  for insert with check (owner_id = auth.uid());
create policy workspaces_update on public.workspaces
  for update using (public.is_ws_admin(id));
create policy workspaces_delete on public.workspaces
  for delete using (owner_id = auth.uid());

create policy members_select on public.workspace_members
  for select using (public.is_ws_member(workspace_id));
create policy members_write on public.workspace_members
  for all using (public.is_ws_admin(workspace_id))
  with check (public.is_ws_admin(workspace_id));

-- generic member policies for tenant-scoped resources
do $$
declare
  t text;
begin
  foreach t in array array[
    'agents', 'agent_releases', 'conversations', 'messages',
    'datasets', 'documents', 'chunks', 'workflows', 'workflow_runs',
    'plugins', 'plugin_tools'
  ]
  loop
    execute format(
      'create policy %I_member_select on public.%I for select using (public.is_ws_member(workspace_id));',
      t, t
    );
    execute format(
      'create policy %I_member_write on public.%I for all using (public.is_ws_member(workspace_id)) with check (public.is_ws_member(workspace_id));',
      t, t
    );
  end loop;
end $$;

create policy api_keys_admin on public.api_keys
  for all using (public.is_ws_admin(workspace_id))
  with check (public.is_ws_admin(workspace_id));

create policy usage_select on public.usage_events
  for select using (public.is_ws_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Storage: knowledge bucket (object keys are `<workspace_id>/<dataset_id>/...`)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('knowledge', 'knowledge', false)
on conflict (id) do nothing;

create policy knowledge_member_read on storage.objects
  for select using (
    bucket_id = 'knowledge'
    and public.is_ws_member(((storage.foldername(name))[1])::uuid)
  );

create policy knowledge_member_write on storage.objects
  for insert with check (
    bucket_id = 'knowledge'
    and public.is_ws_member(((storage.foldername(name))[1])::uuid)
  );

create policy knowledge_member_delete on storage.objects
  for delete using (
    bucket_id = 'knowledge'
    and public.is_ws_member(((storage.foldername(name))[1])::uuid)
  );
