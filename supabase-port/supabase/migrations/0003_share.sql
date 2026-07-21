-- ============================================================================
-- Coze Studio — Supabase Port: public agent sharing (connector domain).
-- A share token publishes an agent to an unauthenticated hosted chat page.
-- ============================================================================

alter table public.agents
  add column if not exists share_token uuid unique;

create index if not exists agents_share_token_idx
  on public.agents (share_token)
  where share_token is not null;
