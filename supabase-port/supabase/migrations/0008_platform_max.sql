-- ============================================================================
-- Coze Studio — Supabase Port: maximum platform exploitation.
-- All blocks GUARDED: applies cleanly on plain Postgres (CI/PGlite) and
-- activates whatever the Supabase project has enabled.
--
--   pg_graphql          -> instant GraphQL API at /graphql/v1 (RLS applies)
--   pg_stat_statements  -> admin_query_stats() for the /admin/perf endpoint
--   pgaudit             -> DDL audit logging into Postgres logs
--   wrappers            -> foreign-data-wrapper framework pre-enabled
--   realtime.messages   -> RLS policy so workspace members can subscribe to
--                          private broadcast channels 'ws:<workspace_id>'
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) pg_graphql: zero-code GraphQL API for custom frontends (RLS enforced)
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_graphql;
  exception when others then
    raise notice 'pg_graphql unavailable — GraphQL API disabled';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2) pg_stat_statements: instance-level query performance for operators
--    (exposed via service-role RPC only; worker gates it to workspace owners)
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_stat_statements;
  exception when others then
    raise notice 'pg_stat_statements unavailable';
  end;

  if exists (select 1 from pg_extension where extname = 'pg_stat_statements') then
    execute $fn$
      create or replace function public.admin_query_stats(p_limit int default 20)
      returns table (
        query text,
        calls bigint,
        total_ms double precision,
        mean_ms double precision,
        rows_returned bigint
      )
      language sql security definer set search_path = public as
      $q$
        select left(query, 300), calls, total_exec_time, mean_exec_time, rows
        from pg_stat_statements
        where query not ilike '%pg_stat_statements%'
        order by total_exec_time desc
        limit least(greatest(p_limit, 1), 100)
      $q$;
    $fn$;
    begin
      revoke execute on function public.admin_query_stats(int) from anon, authenticated;
    exception when others then
      null;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) pgaudit: DDL/role audit trail in database logs
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pgaudit;
  exception when others then
    raise notice 'pgaudit unavailable — DDL audit logging disabled';
  end;
  if exists (select 1 from pg_extension where extname = 'pgaudit') then
    begin
      execute format('alter database %I set pgaudit.log = %L', current_database(), 'ddl, role');
    exception when others then
      raise notice 'could not set pgaudit.log (insufficient privileges)';
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) wrappers: FDW framework pre-enabled (Stripe/S3/BigQuery... foreign
--    tables can be added later without schema changes)
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists wrappers;
  exception when others then
    raise notice 'wrappers unavailable';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Realtime Broadcast authorization: workspace members may subscribe to
--    the private channel 'ws:<workspace_id>' (the Worker broadcasts document
--    indexing + workflow run status there via the service role)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('realtime.messages') is not null then
    begin
      execute $p$
        create policy czp_ws_broadcast_read on realtime.messages
        for select to authenticated
        using (
          exists (
            select 1 from public.workspace_members m
            where m.user_id = (select auth.uid())
              and realtime.topic() = 'ws:' || m.workspace_id::text
          )
        );
      $p$;
    exception when duplicate_object then null;
    when others then
      raise notice 'realtime.messages policy skipped: %', sqlerrm;
    end;
  else
    raise notice 'realtime.messages absent — broadcast auth policy skipped';
  end if;
end $$;
