-- ============================================================================
-- Coze Studio — Supabase Port: memory domain, OAuth plugins, prompt library,
-- shortcuts, and agent-attached databases/workflows.
-- ============================================================================

-- agents gain: attached databases, shortcut commands
alter table public.agents
  add column if not exists database_ids uuid[] not null default '{}',
  add column if not exists shortcuts jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- memory: agent databases (schemaless rows validated against declared columns)
-- ---------------------------------------------------------------------------
create table public.agent_databases (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  description  text not null default '',
  columns      jsonb not null default '[]'::jsonb, -- [{name, type: text|number|boolean|date, required, description}]
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index agent_databases_ws_idx on public.agent_databases (workspace_id);

create trigger trg_agent_databases_updated
  before update on public.agent_databases
  for each row execute function public.set_updated_at();

create table public.agent_database_rows (
  id           uuid primary key default gen_random_uuid(),
  database_id  uuid not null references public.agent_databases (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  data         jsonb not null default '{}'::jsonb,
  created_by   text not null default '', -- auth uid or api-key principal
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index agent_database_rows_db_idx on public.agent_database_rows (database_id, created_at desc);
create index agent_database_rows_data_idx on public.agent_database_rows using gin (data);

create trigger trg_agent_database_rows_updated
  before update on public.agent_database_rows
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- memory: long-term user variables (per workspace / optional agent / user key)
-- ---------------------------------------------------------------------------
create table public.user_variables (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id     uuid references public.agents (id) on delete cascade,
  user_key     text not null, -- auth uid or external end-user id
  name         text not null,
  value        jsonb not null default 'null'::jsonb,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique nulls not distinct (workspace_id, agent_id, user_key, name)
);

create index user_variables_lookup_idx on public.user_variables (workspace_id, agent_id, user_key);

create trigger trg_user_variables_updated
  before update on public.user_variables
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- prompt library
-- ---------------------------------------------------------------------------
create table public.prompt_resources (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null,
  description  text not null default '',
  prompt       text not null default '',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index prompt_resources_ws_idx on public.prompt_resources (workspace_id, updated_at desc);

create trigger trg_prompt_resources_updated
  before update on public.prompt_resources
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- plugin OAuth2 (authorization-code): per-user tokens
-- plugins.auth for oauth2:
--   {type:'oauth2', client_id, client_secret, auth_url, token_url, scopes}
-- ---------------------------------------------------------------------------
create table public.plugin_user_tokens (
  id            uuid primary key default gen_random_uuid(),
  plugin_id     uuid not null references public.plugins (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_key      text not null,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (plugin_id, user_key)
);

create index plugin_user_tokens_lookup_idx on public.plugin_user_tokens (plugin_id, user_key);

create trigger trg_plugin_user_tokens_updated
  before update on public.plugin_user_tokens
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.agent_databases     enable row level security;
alter table public.agent_database_rows enable row level security;
alter table public.user_variables      enable row level security;
alter table public.prompt_resources    enable row level security;
alter table public.plugin_user_tokens  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'agent_databases', 'agent_database_rows', 'user_variables', 'prompt_resources'
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

-- OAuth tokens hold third-party credentials: admin-only via direct PostgREST;
-- normal access flows through the Worker (service role).
create policy plugin_user_tokens_admin on public.plugin_user_tokens
  for all using (public.is_ws_admin(workspace_id))
  with check (public.is_ws_admin(workspace_id));
