// Migration verification on a real Postgres (PGlite/WASM with pgvector):
// stubs the Supabase-managed schemas (auth, storage), applies every
// migration in order, then exercises the schema functionally.
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations')
const db = new PGlite({ extensions: { vector } })

// --- Supabase-managed schema stubs ------------------------------------------
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid());
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (
    id uuid default gen_random_uuid(),
    bucket_id text,
    name text
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1] $$;
`)

// --- apply all migrations in order ------------------------------------------
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
assert(files.length >= 6, 'expected at least 6 migrations, found ' + files.length)
for (const file of files) {
  let sql = readFileSync(join(migrationsDir, file), 'utf8')
  // pgcrypto is not bundled in PGlite; gen_random_uuid() is core since PG13
  sql = sql.replace(/create extension if not exists pgcrypto;\s*/g, '')
  try {
    await db.exec(sql)
  } catch (e: any) {
    throw new Error(`migration ${file} failed: ${e.message}`)
  }
  console.log('applied', file)
}

// --- structural checks -------------------------------------------------------
const { rows: tables } = await db.query<{ table_name: string }>(
  `select table_name from information_schema.tables where table_schema = 'public' order by table_name`
)
const tableNames = tables.map((t) => t.table_name)
for (const expected of [
  'workspaces', 'workspace_members', 'agents', 'agent_releases', 'conversations', 'messages',
  'datasets', 'documents', 'chunks', 'workflows', 'workflow_runs', 'workflow_releases',
  'plugins', 'plugin_tools', 'plugin_releases', 'plugin_user_tokens', 'api_keys',
  'usage_events', 'agent_databases', 'agent_database_rows', 'user_variables',
  'prompt_resources', 'apps', 'app_releases',
]) {
  assert(tableNames.includes(expected), `missing table: ${expected} (have: ${tableNames.join(', ')})`)
}

// --- triggers: workspace owner auto-membership + updated_at ------------------
const { rows: [user] } = await db.query<{ id: string }>(`insert into auth.users default values returning id`)
const { rows: [ws] } = await db.query<{ id: string }>(
  `insert into public.workspaces (name, slug, owner_id) values ('T', 'team-x', $1) returning id`,
  [user.id]
)
const { rows: members } = await db.query(
  `select role from public.workspace_members where workspace_id = $1 and user_id = $2`,
  [ws.id, user.id]
)
assert.strictEqual((members[0] as any)?.role, 'owner', 'owner trigger created membership')

const { rows: [agent] } = await db.query<{ id: string; updated_at: string }>(
  `insert into public.agents (workspace_id, name) values ($1, 'A') returning id, updated_at`,
  [ws.id]
)
await new Promise((r) => setTimeout(r, 20))
const { rows: [agent2] } = await db.query<{ updated_at: string }>(
  `update public.agents set name = 'A2' where id = $1 returning updated_at`,
  [agent.id]
)
assert(new Date(agent2.updated_at) > new Date(agent.updated_at), 'updated_at trigger fired')

// --- knowledge: chunks + hybrid match_chunks --------------------------------
const { rows: [ds] } = await db.query<{ id: string }>(
  `insert into public.datasets (workspace_id, name) values ($1, 'kb') returning id`,
  [ws.id]
)
const { rows: [doc] } = await db.query<{ id: string }>(
  `insert into public.documents (dataset_id, workspace_id, name) values ($1, $2, 'd.txt') returning id`,
  [ds.id, ws.id]
)
function vec(seed: number): string {
  const parts = new Array(1024).fill(0).map((_, i) => (i === seed ? 1 : 0))
  return '[' + parts.join(',') + ']'
}
const chunkRows = [
  { seq: 0, content: 'Hướng dẫn đổi trả hàng trong 30 ngày', e: vec(1) },
  { seq: 1, content: 'Chính sách giao hàng nhanh toàn quốc', e: vec(2) },
  { seq: 2, content: 'Payment methods: visa, mastercard, cod', e: vec(3) },
]
for (const cr of chunkRows) {
  await db.query(
    `insert into public.chunks (document_id, dataset_id, workspace_id, seq, content, embedding)
     values ($1, $2, $3, $4, $5, $6::vector(1024))`,
    [doc.id, ds.id, ws.id, cr.seq, cr.content, cr.e]
  )
}

async function match(searchType: string, query: string, embedding: string, minScore = 0) {
  const { rows } = await db.query(
    `select content, score, similarity from public.match_chunks(
       $1::uuid, array[$2]::uuid[], $3, $4::vector(1024), 5, $5, $6)`,
    [ws.id, ds.id, query, embedding, searchType, minScore]
  )
  return rows as { content: string; score: number; similarity: number }[]
}

const semantic = await match('semantic', 'anything', vec(2))
assert(semantic[0].content.includes('giao hàng'), 'semantic top hit by vector: ' + semantic[0]?.content)
assert(Math.abs(semantic[0].similarity - 1) < 1e-6, 'exact vector similarity = 1')

const fulltext = await match('fulltext', 'mastercard', vec(1))
assert.strictEqual(fulltext.length, 1, 'fulltext matches keyword only')
assert(fulltext[0].content.includes('visa'), 'fulltext hit: ' + fulltext[0]?.content)

const hybrid = await match('hybrid', 'mastercard', vec(3))
assert(hybrid[0].content.includes('visa'), 'hybrid RRF fuses vector+keyword winner')

const thresholded = await match('semantic', 'x', vec(2), 0.9)
assert.strictEqual(thresholded.length, 1, 'min_score filters non-matching vectors')

// disabled chunks are excluded
await db.query(`update public.chunks set enabled = false where seq = 1`)
const afterDisable = await match('semantic', 'x', vec(2))
assert(!afterDisable.length || !afterDisable[0].content.includes('giao hàng'), 'disabled chunk excluded')

// --- user_variables: unique nulls not distinct -------------------------------
await db.query(
  `insert into public.user_variables (workspace_id, agent_id, user_key, name, value)
   values ($1, null, 'u1', 'lang', '"vi"'::jsonb)`,
  [ws.id]
)
let dupFailed = false
try {
  await db.query(
    `insert into public.user_variables (workspace_id, agent_id, user_key, name, value)
     values ($1, null, 'u1', 'lang', '"en"'::jsonb)`,
    [ws.id]
  )
} catch {
  dupFailed = true
}
assert(dupFailed, 'nulls-not-distinct unique enforced for agent_id null')

// --- workflow_runs status constraint incl. suspended -------------------------
const { rows: [wf] } = await db.query<{ id: string }>(
  `insert into public.workflows (workspace_id, name) values ($1, 'w') returning id`,
  [ws.id]
)
await db.query(
  `insert into public.workflow_runs (workflow_id, workspace_id, status) values ($1, $2, 'suspended')`,
  [wf.id, ws.id]
)
let badStatus = false
try {
  await db.query(
    `insert into public.workflow_runs (workflow_id, workspace_id, status) values ($1, $2, 'bogus')`,
    [wf.id, ws.id]
  )
} catch {
  badStatus = true
}
assert(badStatus, 'workflow_runs status check constraint enforced')

// --- storage buckets seeded --------------------------------------------------
const { rows: buckets } = await db.query(`select id from storage.buckets order by id`)
assert.deepStrictEqual(buckets.map((b: any) => b.id), ['files', 'knowledge'], 'both buckets created')

console.log('ALL MIGRATION TESTS PASSED (' + files.length + ' migrations applied on PGlite)')
