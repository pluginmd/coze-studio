# Coze Studio — Supabase + Cloudflare Workers Port

Bản port tinh gọn của Coze Studio, chạy **hoàn toàn** trên Supabase + Cloudflare
Workers — không MySQL, không Redis, không Elasticsearch, không Milvus, không
MinIO, không NSQ, không etcd, không backend Go. Multi-tenant theo workspace,
serverless toàn phần, chi phí vận hành gần bằng 0 khi idle.

## Ánh xạ tech stack

| Coze Studio gốc | Bản port | Ghi chú |
|---|---|---|
| Go + Hertz (backend) | **Cloudflare Worker** (Hono + TypeScript) | 1 Worker duy nhất, edge-deployed |
| MySQL 8 | **Supabase Postgres** | schema + migration trong `supabase/migrations/` |
| Milvus (vector DB) | **pgvector** (HNSW, cosine) | cột `chunks.embedding vector(1024)` |
| Elasticsearch | **Postgres FTS** (`tsvector` + GIN) | hybrid search RRF trong RPC `match_chunks` |
| MinIO | **Supabase Storage** (bucket `knowledge`) | key theo prefix `workspace_id/` |
| NSQ (message queue) | **Cloudflare Queues** | fallback `ctx.waitUntil()` cho free plan |
| Python parser sidecar (PDF/DOCX) | **Parse tại edge**: `unpdf` (PDF), `fflate` (DOCX/XLSX) | không cần sidecar |
| OCR sidecar (ppocr/veocr) | **OpenAI vision** | ảnh png/jpg/webp/gif OCR khi index |
| Frontend IDE (259 packages) | **Admin console 1 file** tại `/` + trang chat public `/share/:token` | JSON editor thay drag-drop |
| Redis | *(bỏ)* | Worker stateless; Postgres đủ nhanh cho quy mô này |
| etcd | *(bỏ)* | config qua `wrangler.toml` + secrets |
| Casbin / session | **Supabase Auth + RLS** | JWT verify tại edge, RLS chặn cross-tenant |
| Embedding tự host | **Jina AI** (`jina-embeddings-v3`, 1024 dim) | task-aware: `retrieval.passage` / `retrieval.query` |
| Multi-provider LLM | **OpenAI** (hoặc bất kỳ endpoint OpenAI-compatible) | `OPENAI_BASE_URL` tùy chỉnh được |

## Kiến trúc

```mermaid
flowchart LR
  Client[Client / Frontend / API key] -->|HTTPS + SSE| W[Cloudflare Worker\nHono router]
  W -->|service role| PG[(Supabase Postgres\npgvector + FTS + RLS)]
  W --> ST[(Supabase Storage\nbucket: knowledge)]
  W -->|enqueue| Q[[Cloudflare Queue\ndoc-index]]
  Q -->|consumer| W
  W -->|chat + tools| OAI[OpenAI API]
  W -->|embeddings| JINA[Jina AI]
  W -->|HTTP tools + OAuth2| EXT[Plugin endpoints]
  Auth[Supabase Auth] -.->|JWT| Client
```

### Multi-tenant

- Tenant = **workspace**. Mọi bảng nghiệp vụ đều có `workspace_id`.
- Người dùng đăng nhập qua **Supabase Auth**; Worker verify JWT (HS256, local,
  không round-trip) rồi check membership ở middleware `requireWorkspace`.
- **RLS bật trên tất cả các bảng** — kể cả khi client gọi thẳng PostgREST/
  Realtime cũng không đọc được dữ liệu tenant khác.
- Truy cập máy-với-máy qua **API key** (`czk_...`, hash SHA-256, scope theo
  workspace, thu hồi được). API-key caller truyền `user_key` để định danh
  end-user (scope memory + OAuth theo từng người dùng cuối).
- Token usage ghi vào `usage_events` theo tenant → billing/quota.

### RAG pipeline (knowledge)

1. Upload tài liệu — **PDF, DOCX, XLSX, ảnh (OCR qua OpenAI vision)**,
   txt/md/html/json/csv — vào Supabase Storage (text hoặc `content_base64`).
2. Queue consumer (hoặc `waitUntil` trên free plan): parse theo định dạng →
   chunk (paragraph-aware, overlap) → **Jina embeddings** (batch 32) → insert
   `chunks` (pgvector).
3. Truy vấn: embed câu hỏi (`retrieval.query`) → RPC `match_chunks` chạy
   **hybrid search** (HNSW cosine + FTS keyword, trộn Reciprocal Rank Fusion)
   ngay trong Postgres — thay cả Milvus lẫn Elasticsearch bằng 1 câu SQL.

### Agent runtime

- System prompt hỗ trợ biến `{{var.x}}` = biến tĩnh của agent **+ long-term
  user variables** (memory domain) load theo `user_key`.
- Context RAG + lịch sử hội thoại + **OpenAI streaming** (SSE) với vòng lặp
  tool-calling (tối đa 5 vòng).
- Tool của agent gồm 3 loại, hợp nhất một interface:
  1. **HTTP plugin tools** — auth `none` / `api_key` / **OAuth2 per-user**
     (authorization-code + refresh token tự động);
  2. **Agent databases** — mỗi database sinh tool `query_*` / `insert_*` với
     JSON-schema từ cột đã khai báo;
  3. **Workflows** — mỗi workflow gắn vào agent thành một function
     (tham số lấy từ `inputs` của node start).
- Mọi message, tool log, usage đều persist vào Postgres.

### Workflow engine v2 — parallel DAG

Graph JSON `{nodes, edges}`, thực thi **DAG song song theo wave**: node hết
phụ thuộc chạy đồng thời; nhánh không được chọn bị prune lan truyền. Template
`{{nodeId.field}}` tham chiếu kết quả node trước (giữ nguyên kiểu dữ liệu khi
đứng một mình). Mỗi run ghi `workflow_runs` đầy đủ input/output/node_results
(kể cả khi fail), LLM usage cộng dồn vào `usage_events`.

**27 node types**:

| Nhóm | Node |
|---|---|
| Luồng | `start`, `end`, `condition`, `selector` (multi-branch), `loop` (sub-workflow/item, tuần tự), `batch` (song song, concurrency), `sub_workflow` |
| AI | `llm`, `intent` (phân loại intent, tự branch theo edge label) |
| Knowledge | `knowledge_retrieve`, `knowledge_index` (ghi text vào dataset), `knowledge_delete` |
| Database | `database_query`, `database_insert`, `database_update`, `database_delete` |
| Hội thoại | `conversation_create`, `message_create`, `message_list` |
| Tích hợp | `plugin` (kèm OAuth2), `http` (request tự do, timeout) |
| Dữ liệu | `template`, `code` (biểu thức an toàn — AST interpreter, không eval), `text_processor` (concat/split/replace/substring/case/trim), `json_parse`, `json_stringify`, `variable_aggregator` |

`code` node: Workers cấm `eval`, nên biểu thức được parse thành AST (jsep) và
thông dịch với whitelist ~30 hàm (`sum`, `pluck`, `split`, `get`, ...) — chặn
prototype access, giới hạn độ phức tạp. Không phải JS tùy ý nhưng đủ cho
transform dữ liệu thường gặp.

Giới hạn an toàn: 500 node/run, 100 waves, sub-workflow depth 3, loop/batch ≤ 100 items.

### Memory domain

- **Agent databases**: bảng dữ liệu do user khai báo cột (`text/number/boolean/
  date`, required), rows JSONB validate + coerce kiểu ở Worker. Agent
  query/insert qua tool; workflow thao tác qua 4 node database.
- **Import bảng** (table-mode knowledge): upload XLSX/CSV/TSV → header thành
  cột (tự suy kiểu number/text) → rows import theo batch (tối đa 5000).
- **User variables**: biến dài hạn theo `(workspace, agent?, user_key, name)`,
  inject vào system prompt mỗi lượt chat.

### Publish agent (connector domain)

`POST /agents/:id/share` sinh share token → trang chat công khai
`/share/<token>` (không cần đăng nhập, SSE streaming, welcome + suggested
questions). End-user được scope bằng session id (`share:<session>`) cho
memory/OAuth. Thu hồi bằng `DELETE /agents/:id/share`. *(Chưa có rate limit
per-IP — cân nhắc Cloudflare WAF rule khi chạy production.)*

### Admin console

Worker serve SPA 1 file tại `/`: đăng nhập (paste token hoặc email/password
qua Supabase Auth), quản lý agents (edit/publish/share/chat thử), knowledge
(upload + xem trạng thái index + test hybrid search), workflows (JSON editor +
run + xem kết quả), plugins (+OAuth connect, invoke thử), databases (+import
xlsx/csv, xem/sửa rows), prompts, API keys, usage, search. Các trường cấu trúc
sửa qua JSON editor — không phải visual editor kéo-thả như IDE gốc.

## Cấu trúc thư mục

```
supabase-port/
├── supabase/
│   ├── config.toml                # local dev (supabase start)
│   └── migrations/
│       ├── 0001_init.sql          # schema lõi + RLS + hybrid search RPC
│       ├── 0002_domains.sql       # memory, oauth tokens, prompts, shortcuts
│       └── 0003_share.sql         # share token (publish agent công khai)
└── worker/
    ├── wrangler.toml              # 1 Worker + 1 Queue
    ├── src/
    │   ├── index.ts               # router + queue consumer
    │   ├── indexer.ts             # pipeline embedding tài liệu
    │   ├── console.ts             # admin console SPA tại /
    │   ├── engine/workflow.ts     # DAG engine v2 (27 node types)
    │   ├── middleware/auth.ts     # JWT + API key + tenant guard
    │   ├── lib/                   # openai, jina, retrieval, plugins, oauth,
    │   │                          # database, docparse, expr, chatservice,
    │   │                          # agenttools, agentloop
    │   └── routes/                # REST + SSE chat + oauth + share public
    └── test/smoke.mts             # npm test: engine, expr, parse, db, csv
```

## Triển khai

### 1. Supabase

```bash
cd supabase-port/supabase
supabase link --project-ref <ref>
supabase db push          # chạy cả 2 migrations
```

Lấy: `SUPABASE_URL`, `service_role key`, `JWT secret` (Settings → API).

### 2. Cloudflare Worker

```bash
cd supabase-port/worker
npm install
npm test                                  # smoke tests engine/parse/db
wrangler queues create doc-index          # bỏ qua nếu free plan
                                          # (xóa block queues trong wrangler.toml)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put SUPABASE_JWT_SECRET
wrangler secret put OPENAI_API_KEY
wrangler secret put JINA_API_KEY
npm run deploy
```

### 3. Dùng thử

```bash
TOKEN=<supabase-access-token>
API=https://coze-supabase-port.<account>.workers.dev

curl -X POST $API/v1/workspaces -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name": "My Team"}'

curl -X POST $API/v1/workspaces/$WID/agents -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name": "Assistant", "prompt": "You are a helpful assistant.", "model": {"model": "gpt-4o-mini"}}'

curl -N -X POST $API/v1/workspaces/$WID/chat -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agent_id": "'$AGENT'", "message": "Xin chào!"}'
```

Hoặc mở `https://<worker-url>/` — playground chat có sẵn.

## API chính

| Method | Path | Mô tả |
|---|---|---|
| GET | `/v1/me` | user + danh sách workspace |
| GET/POST | `/v1/workspaces` | list / tạo workspace |
| GET/PATCH/DELETE | `/v1/workspaces/:wid` | chi tiết tenant |
| GET/POST/DELETE | `.../members[/:uid]` | thành viên |
| GET | `.../usage` | token usage 30 ngày (chat/embedding/workflow) |
| CRUD | `.../agents[/:id]` + `/:id/publish`, `/:id/releases` | agent (kèm shortcuts, database_ids, workflow_ids) |
| POST | `.../chat` | **chat SSE** (RAG + plugin/db/workflow tools + memory) |
| GET/DELETE | `.../conversations[/:id]` + POST `/:id/clear` | hội thoại |
| CRUD | `.../datasets[/:dsid]` + documents, reindex, search | knowledge (PDF/DOCX/XLSX/text) |
| CRUD | `.../workflows[/:id]` + `/:id/run`, `/:id/runs` | workflow DAG |
| CRUD | `.../plugins[/:pid]/tools[/:tid]` + `invoke` | HTTP tools |
| GET/DELETE | `.../plugins/:pid/oauth/url`, `/status`, `/` | OAuth2 per-user |
| GET | `/oauth/callback` | public redirect (state ký HS256) |
| CRUD | `.../databases[/:dbid]` + rows, `rows/query` | memory: bảng dữ liệu |
| POST | `.../databases/import` | import XLSX/CSV/TSV thành database |
| POST/DELETE | `.../agents/:id/share` | publish / thu hồi share link |
| GET/POST | `/share/:token[/info\|/chat]` | public: trang chat + SSE (không auth) |
| GET/PUT/DELETE | `.../variables[/:id]` | memory: user variables |
| CRUD | `.../prompts[/:id]` | thư viện prompt |
| GET | `.../search?q=` | tìm resource toàn workspace |
| GET/POST/DELETE | `.../api-keys[/:id]` | API key `czk_` |

## Phạm vi so với bản gốc

> **Audit chi tiết feature-by-feature với bản gốc (mức parity thực ~35–40%,
> danh sách sót ưu tiên P0/P1/P2): xem [AUDIT.md](./AUDIT.md).**

**Đã port** (backend ~246 routes gốc → ~80 endpoints tinh gọn): multi-tenant
workspaces, agents (prompt/model/publish/shortcuts/**share công khai**), chat
streaming + 3 loại tool, knowledge RAG (PDF/DOCX/XLSX/**ảnh OCR**/text, hybrid
search), workflow DAG engine **27/42 node types** (kèm `code` node biểu thức
an toàn), HTTP plugins + OAuth2, memory (databases + **import bảng** + user
variables), prompt library, resource search, API keys, usage metering,
auth + RLS, **admin console** + trang chat public.

**Chưa port** (chủ đích, ngoài phạm vi lean):

- Visual editor kéo-thả cho workflow/agent (console dùng JSON editor; graph
  format tương thích nếu sau này muốn gắn React Flow)
- Workflow: `question_answer` (pause/resume tương tác giữa run — engine hiện
  chạy đồng bộ), `code` node là expression subset chứ không phải JS tùy ý
  (muốn full JS cần QuickJS WASM)
- App packaging (đóng gói multi-agent app), template marketplace, datacopy;
  connector mới có web share link (chưa có Slack/Telegram/...)
- Share link chưa có rate limit per-IP (dùng Cloudflare WAF khi production)
- Plugin secret lưu plaintext trong Postgres (có RLS); nâng cấp Supabase
  Vault nếu cần mã hóa at-rest

## Dev local

```bash
supabase start                                 # Postgres + Auth + Storage local
cd worker && cp .dev.vars.example .dev.vars    # điền keys
npm install && npm test && npm run dev         # http://localhost:8787
```
