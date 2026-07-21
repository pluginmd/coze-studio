-- ============================================================================
-- Coze Studio — Supabase Port: multi-agent routing + MCP plugins.
-- ============================================================================

-- multi-agent host config: { enabled, sub_agents: [{agent_id, description}] }
alter table public.agents
  add column if not exists multi_agent jsonb not null default '{}'::jsonb;

-- plugin kind: classic HTTP tools vs MCP (Model Context Protocol) servers
alter table public.plugins
  add column if not exists kind text not null default 'http'
    check (kind in ('http', 'mcp'));
