-- ============================================================================
-- Coze Studio — Supabase Port: conversation sections (context boundaries).
-- "Clear context" starts a new section instead of deleting history; the LLM
-- only sees messages from the current section, the full log is preserved.
-- ============================================================================

alter table public.conversations
  add column if not exists section_id uuid not null default gen_random_uuid();

alter table public.messages
  add column if not exists section_id uuid;

create index if not exists messages_section_idx
  on public.messages (conversation_id, section_id, created_at);
