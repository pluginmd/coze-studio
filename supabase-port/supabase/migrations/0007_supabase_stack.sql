-- ============================================================================
-- Coze Studio — Supabase Port: deeper Supabase-platform exploitation.
-- Every block is GUARDED so this migration also applies cleanly on plain
-- Postgres (CI/PGlite) where Supabase-managed extensions are absent.
--
--   pgmq (Supabase Queues) -> native async doc-indexing queue (no CF Queues
--                             needed even on the Cloudflare free plan)
--   pg_cron                -> scheduled maintenance inside the database
--   supabase_vault         -> plugin auth secrets encrypted at rest
--   realtime publication   -> live document/run/message change streams
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Supabase Queues (pgmq): doc_index queue + service-role wrappers
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pgmq;
  exception when others then
    raise notice 'pgmq unavailable — queue falls back to CF Queues or inline';
  end;

  if exists (select 1 from pg_extension where extname = 'pgmq') then
    begin
      perform pgmq.create('doc_index');
    exception when others then
      null; -- queue already exists
    end;

    execute $fn$
      create or replace function public.queue_send_doc_index(p_message jsonb)
      returns bigint language sql security definer
      set search_path = public, pgmq as
      $q$ select pgmq.send('doc_index', p_message) $q$;
    $fn$;
    execute $fn$
      create or replace function public.queue_read_doc_index(p_limit int default 5)
      returns table (msg_id bigint, message jsonb)
      language sql security definer
      set search_path = public, pgmq as
      $q$ select msg_id, message from pgmq.read('doc_index', 120, p_limit) $q$;
    $fn$;
    execute $fn$
      create or replace function public.queue_delete_doc_index(p_msg_id bigint)
      returns boolean language sql security definer
      set search_path = public, pgmq as
      $q$ select pgmq.delete('doc_index', p_msg_id) $q$;
    $fn$;

    -- queue wrappers are for the Worker (service role) only
    begin
      revoke execute on function public.queue_send_doc_index(jsonb) from anon, authenticated;
      revoke execute on function public.queue_read_doc_index(int) from anon, authenticated;
      revoke execute on function public.queue_delete_doc_index(bigint) from anon, authenticated;
    exception when others then
      null; -- roles absent outside Supabase
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) pg_cron: in-database scheduled maintenance
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable — skipping scheduled maintenance';
  end;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'czp-purge-dead-plugin-tokens',
      '30 3 * * *',
      $j$delete from public.plugin_user_tokens
         where expires_at is not null
           and expires_at < now() - interval '30 days'
           and refresh_token is null$j$
    );
    perform cron.schedule(
      'czp-purge-old-workflow-runs',
      '45 3 * * *',
      $j$delete from public.workflow_runs
         where started_at < now() - interval '90 days'$j$
    );
    perform cron.schedule(
      'czp-purge-old-usage-events',
      '50 3 * * *',
      $j$delete from public.usage_events
         where created_at < now() - interval '365 days'$j$
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Supabase Vault: encrypt plugin auth secrets at rest
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'supabase_vault') then
    execute $fn$
      create or replace function public.vault_set(p_secret text)
      returns uuid language sql security definer
      set search_path = public, vault as
      $q$ select vault.create_secret(p_secret) $q$;
    $fn$;
    execute $fn$
      create or replace function public.vault_get(p_id uuid)
      returns text language sql security definer
      set search_path = public, vault as
      $q$ select decrypted_secret from vault.decrypted_secrets where id = p_id $q$;
    $fn$;
    begin
      revoke execute on function public.vault_set(text) from anon, authenticated;
      revoke execute on function public.vault_get(uuid) from anon, authenticated;
    exception when others then
      null;
    end;
  else
    raise notice 'supabase_vault unavailable — plugin secrets stay plaintext (RLS-protected)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Realtime: stream document/run/message changes to authorized clients
--    (RLS still applies — clients subscribe with their user JWT)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.documents;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.workflow_runs;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.messages;
    exception when duplicate_object then null;
    end;
  else
    raise notice 'supabase_realtime publication absent — realtime streams disabled';
  end if;
end $$;
