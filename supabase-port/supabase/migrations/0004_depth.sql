-- ============================================================================
-- Coze Studio — Supabase Port: depth batch (P0/P1 gap closure).
-- Covers: chunk management, retrieval config, workflow lifecycle + suspension,
-- plugin lifecycle, database rw modes, list variables, app packaging, files.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- knowledge: chunk enable/disable + per-dataset chunking strategy
-- ---------------------------------------------------------------------------
alter table public.chunks
  add column if not exists enabled boolean not null default true;

alter table public.datasets
  add column if not exists chunk_strategy jsonb not null default '{}'::jsonb;
  -- { mode: 'auto'|'separator'|'heading', separators: string[], trim_url_email: bool }

-- per-agent knowledge recall config
alter table public.agents
  add column if not exists knowledge jsonb not null default '{}'::jsonb;
  -- { top_k, min_score, search_type: 'semantic'|'fulltext'|'hybrid', auto: bool }

-- suggest-reply + onboarding config
alter table public.agents
  add column if not exists suggest_reply jsonb not null default '{}'::jsonb,
  -- { mode: 'off'|'auto'|'custom', prompt }
  add column if not exists onboarding jsonb not null default '{}'::jsonb;
  -- { mode: 'manual'|'llm', prompt }

-- match_chunks v2: search-type variants, min-score threshold, enabled filter
drop function if exists public.match_chunks(uuid, uuid[], text, vector, int);
create or replace function public.match_chunks(
  p_workspace_id uuid,
  p_dataset_ids  uuid[],
  p_query        text,
  p_embedding    vector(1024),
  p_limit        int default 8,
  p_search_type  text default 'hybrid',
  p_min_score    double precision default 0
)
returns table (
  chunk_id    bigint,
  document_id uuid,
  dataset_id  uuid,
  content     text,
  score       double precision,
  similarity  double precision
)
language sql stable set search_path = public as $$
  with vec as (
    select c.id, c.document_id, c.dataset_id, c.content,
           1 - (c.embedding <=> p_embedding) as sim,
           row_number() over (order by c.embedding <=> p_embedding) as vrank
    from public.chunks c
    where c.workspace_id = p_workspace_id
      and c.dataset_id = any (p_dataset_ids)
      and c.enabled
      and c.embedding is not null
      and p_search_type in ('hybrid', 'semantic')
    order by c.embedding <=> p_embedding
    limit greatest(p_limit * 4, 24)
  ),
  kw as (
    select c.id, c.document_id, c.dataset_id, c.content,
           ts_rank_cd(c.fts, websearch_to_tsquery('simple', p_query)) as krank_score,
           row_number() over (
             order by ts_rank_cd(c.fts, websearch_to_tsquery('simple', p_query)) desc
           ) as krank
    from public.chunks c
    where c.workspace_id = p_workspace_id
      and c.dataset_id = any (p_dataset_ids)
      and c.enabled
      and p_search_type in ('hybrid', 'fulltext')
      and c.fts @@ websearch_to_tsquery('simple', p_query)
    limit greatest(p_limit * 4, 24)
  ),
  fused as (
    select coalesce(v.id, k.id) as id,
           coalesce(v.document_id, k.document_id) as document_id,
           coalesce(v.dataset_id, k.dataset_id) as dataset_id,
           coalesce(v.content, k.content) as content,
           case p_search_type
             when 'semantic' then v.sim
             when 'fulltext' then k.krank_score
             else coalesce(1.0 / (60 + v.vrank), 0) + coalesce(1.0 / (60 + k.krank), 0)
           end as score,
           coalesce(v.sim, 0) as similarity
    from vec v
    full outer join kw k on k.id = v.id
  )
  select id, document_id, dataset_id, content, score, similarity
  from fused
  where p_min_score <= 0
     or (p_search_type = 'fulltext')
     or similarity >= p_min_score
  order by score desc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- workflow: releases + suspended/queued runs
-- ---------------------------------------------------------------------------
create table public.workflow_releases (
  id           uuid primary key default gen_random_uuid(),
  workflow_id  uuid not null references public.workflows (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version      int not null,
  graph        jsonb not null,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (workflow_id, version)
);

alter table public.workflow_runs
  drop constraint if exists workflow_runs_status_check;
alter table public.workflow_runs
  add constraint workflow_runs_status_check
  check (status in ('queued', 'running', 'succeeded', 'failed', 'suspended', 'cancelled'));
alter table public.workflow_runs
  add column if not exists suspended jsonb, -- { node_id, question, options, results, input }
  add column if not exists version int;     -- release version used (null = draft)

-- ---------------------------------------------------------------------------
-- plugin: tool debug lifecycle + releases
-- ---------------------------------------------------------------------------
alter table public.plugin_tools
  add column if not exists debug_status text not null default 'waiting'
    check (debug_status in ('waiting', 'passed'));

create table public.plugin_releases (
  id           uuid primary key default gen_random_uuid(),
  plugin_id    uuid not null references public.plugins (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version      int not null,
  snapshot     jsonb not null, -- { plugin, tools }
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (plugin_id, version)
);

-- ---------------------------------------------------------------------------
-- memory: database read/write modes + list variables
-- ---------------------------------------------------------------------------
alter table public.agent_databases
  add column if not exists rw_mode text not null default 'unlimited'
    check (rw_mode in ('unlimited', 'read_only', 'per_user'));

alter table public.user_variables
  add column if not exists var_type text not null default 'kv'
    check (var_type in ('kv', 'list'));

-- ---------------------------------------------------------------------------
-- apps: multi-resource packaging with versioned releases
-- ---------------------------------------------------------------------------
create table public.apps (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  description  text not null default '',
  icon_url     text,
  agent_ids    uuid[] not null default '{}',
  workflow_ids uuid[] not null default '{}',
  dataset_ids  uuid[] not null default '{}',
  database_ids uuid[] not null default '{}',
  plugin_ids   uuid[] not null default '{}',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index apps_ws_idx on public.apps (workspace_id, updated_at desc);

create trigger trg_apps_updated
  before update on public.apps
  for each row execute function public.set_updated_at();

create table public.app_releases (
  id           uuid primary key default gen_random_uuid(),
  app_id       uuid not null references public.apps (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version      int not null,
  snapshot     jsonb not null, -- { app, agents, workflows, plugins, tools, databases, datasets }
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (app_id, version)
);

-- ---------------------------------------------------------------------------
-- files: general-purpose upload bucket (icons, chat attachments)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

create policy files_member_read on storage.objects
  for select using (
    bucket_id = 'files'
    and public.is_ws_member(((storage.foldername(name))[1])::uuid)
  );
create policy files_member_write on storage.objects
  for insert with check (
    bucket_id = 'files'
    and public.is_ws_member(((storage.foldername(name))[1])::uuid)
  );
create policy files_member_delete on storage.objects
  for delete using (
    bucket_id = 'files'
    and public.is_ws_member(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------------
-- RLS for new tables
-- ---------------------------------------------------------------------------
alter table public.workflow_releases enable row level security;
alter table public.plugin_releases   enable row level security;
alter table public.apps              enable row level security;
alter table public.app_releases      enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['workflow_releases', 'plugin_releases', 'apps', 'app_releases']
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
