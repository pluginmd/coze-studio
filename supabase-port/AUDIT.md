# AUDIT — Đối chiếu bản port Supabase/Cloudflare với Coze Studio gốc

> Phương pháp: 6 lượt quét sâu toàn bộ backend gốc (703k LOC Go, 246 routes,
> IDL, conf) + frontend (259 packages) để lập inventory tính năng có dẫn chứng
> file, sau đó đối chiếu từng mục với bản port (~4.7k LOC TS/SQL, ~80
> endpoints, 20 bảng, 27 node types).
>
> Ký hiệu: ✅ có tương đương · ⚠️ có một phần / khác cơ chế · ❌ chưa có

## Kết luận tổng (đọc trước)

**Bản port đạt ~35–40% feature parity backend** (không phải "port toàn bộ").
Nó phủ đúng **luồng lõi**: multi-tenant → agent → chat RAG + tools → workflow
DAG → plugin/OAuth → memory. Phần "sót" tập trung ở: **tính tương tác
(interrupt/resume, streaming run, stop generation), cấu hình sâu (model
params, recall config, chunking strategy), lifecycle (draft/publish/version
cho workflow/plugin/database), import/marketplace, multimodal, app packaging,
và toàn bộ IDE trực quan**.

Ngược lại, có 5 điểm bản port **tốt hơn gốc**:

1. **Phân quyền**: gốc là creator-only (không share được resource, space có
   type team nhưng KHÔNG có API mời thành viên/role). Port có workspace
   members với role owner/admin/member + RLS cứng ở tầng DB.
2. **Hạ tầng**: 9 services → 2 (Supabase + 1 Worker), serverless, ~0 chi phí idle.
3. **Hybrid search** trong 1 câu SQL (pgvector + FTS + RRF) thay vì phối hợp
   Milvus + Elasticsearch.
4. **Parse tài liệu tại edge** (unpdf/fflate) — không cần Python sidecar;
   OCR ảnh bằng vision model — không cần ppocr/veocr sidecar.
5. **API key scope theo workspace** (gốc: PAT scope theo user).

---

## 1. WORKFLOW — gốc 55.5k LOC, 42 nodes, 49 endpoints → port ~27 nodes, 7 endpoints

### Node types: 27/42 (64%)

| Gốc | Port | Ghi chú |
|---|---|---|
| Entry/Exit, LLM, Plugin, HTTP, Selector, SubWorkflow, IntentDetector, Loop, Batch, TextProcessor, JsonSer/De, VariableAggregator, KnowledgeRetriever/Indexer/Deleter, DB Query/Insert/Update/Delete, CreateConversation, CreateMessage, MessageList | ✅ | tương đương chức năng |
| CodeRunner (sandbox code đầy đủ) | ⚠️ `code` | port là expression subset (AST interpreter, ~30 hàm), không phải JS/Python tùy ý |
| **QuestionAnswer** (hỏi user giữa run: choices/extract) | ❌ | cần interrupt/resume — engine port chạy đồng bộ |
| **InputReceiver** (nhận input giữa run) | ❌ | như trên |
| **Break / Continue** (điều khiển loop) | ❌ | loop port là sub-workflow/item, không break sớm được |
| **VariableAssigner** (+WithinLoop) — ghi app/user variables | ❌ | port có user_variables API nhưng không có node ghi |
| **OutputEmitter** — message trung gian streaming | ❌ | port chỉ trả kết quả cuối |
| **DatabaseCustomSQL** — raw SQL | ❌ | port chủ đích filter-based (an toàn hơn, yếu hơn) |
| ClearConversationHistory, ConversationUpdate/Delete/List, ConversationHistory, EditMessage, DeleteMessage | ❌ | port có 3/11 node hội thoại |
| Comment (chú thích canvas) | ❌ | không ảnh hưởng chạy |
| Batch-mode per-node (LLM/Plugin tự chạy batch) | ❌ | |

### Engine capabilities — phần sót NẶNG nhất

| Gốc | Port |
|---|---|
| **Streaming execution** (SSE từng node, incremental output) | ❌ chạy sync, trả JSON cuối |
| **Async/background run** + get_process polling | ❌ |
| **Interrupt / pause / resume** (QA, input, OAuth trong tool, nested) + **checkpoint store** | ❌ |
| **Cancel** mid-run | ❌ |
| **Per-node error handling**: retry times, timeout ms, exception branch / default value | ❌ (chỉ http node có timeout) |
| **Test-run vs release-run**, **single-node debug**, replay input lần trước | ❌ chỉ run nguyên workflow |
| **Draft/publish + version history** cho workflow | ❌ chỉ có cột `status` — *agent có release snapshot, workflow thì chưa* |
| Workflow references (đồ thị phụ thuộc ngược) | ❌ |
| Copy/duplicate, app↔library migration, auto-copy tài nguyên phụ thuộc | ❌ |
| Chatflow mode + chat_flow_role, conversation templates | ❌ |
| Typed I/O schema (8 kiểu + 12 file subtypes) + validate_tree | ⚠️ JSON tự do, không validate |
| Trace/spans, token collect per node | ⚠️ có node_results + usage tổng |
| Node template/example library, panel search | ❌ |
| Open API `/v1/workflow/run|stream_run|stream_resume|get_run_history` | ⚠️ có `/run` + `runs` khác shape |

## 2. KNOWLEDGE — gốc 14k LOC + parser/OCR infra → port đạt ~45%

| Nhóm | Gốc | Port |
|---|---|---|
| Nguồn | file local, custom text (KHÔNG có URL crawl — gốc cũng không) | ✅ tương đương |
| Format | pdf, txt, doc, **docx**, md, csv, **xlsx**, json, json_maps, jpg/jpeg/png | ⚠️ thiếu `.doc` cũ, json_maps; còn lại đủ + thêm html |
| Parsing engine | builtin **+ PaddleOCR ppstructure** (layout analysis, extract bảng/ảnh từ PDF, wired/wireless table→HTML) | ❌ chỉ builtin-tương-đương |
| OCR | ppocr + veocr | ✅ thay bằng OpenAI vision |
| Caption ảnh bằng LLM + sửa caption thủ công | ⚠️ OCR text, không có caption edit + photo endpoints |
| **Table knowledge** (bảng vật lý RDB + NL2SQL + semantic column) | ⚠️ port đưa vào agent_databases (filter-based, không NL2SQL, không nằm trong retrieval pipeline) |
| Chunking | auto / **custom separator** / **hierarchical (theo heading, max depth)** / overlap % / trim space / trim URL+email | ⚠️ chỉ paragraph + size + overlap |
| **Review trước khi index** (xem/duyệt chunk tree) | ❌ |
| **Slice management**: thêm/sửa/xóa/enable-disable từng chunk, keyword search slice | ❌ — port KHÔNG có API sửa chunk |
| Resegment với strategy mới | ⚠️ reindex nhưng strategy cố định theo dataset |
| Retrieval: semantic/fulltext/hybrid chọn được | ⚠️ luôn hybrid RRF |
| **Query rewrite** (multi-turn → standalone query) | ❌ |
| Rerank: RRF + **rerank model** | ⚠️ RRF only |
| **Min score threshold** | ❌ trả top-k bất kể score |
| Auto vs **on-demand recall** (recall như tool) | ❌ luôn auto |
| Progress % + remaining time, hit_count, stats, quota | ⚠️ chỉ status + chunk_count |
| Append rows vào table doc | ❌ |
| OpenAPI /v1/datasets tương thích | ❌ khác shape |

## 3. PLUGIN + OPENAUTH — gốc 18.6k+1.2k LOC → port đạt ~35%

| Gốc | Port |
|---|---|
| Tạo thủ công | ✅ |
| **Import OpenAPI 3.x / Swagger 2.x / curl / Postman** (yaml+json) | ❌ — thiếu lớn nhất, nhập plugin thực tế rất cần |
| **18 product plugins có sẵn** (Lark suite, bocha, wolfram, gaode...) | ❌ |
| MCP plugin type | ❌ (gốc cũng chỉ stub — gần parity) |
| Custom in-process plugin (Go) | ❌ (gốc cần compile — giá trị thấp) |
| SaaS marketplace search/install | ❌ |
| Auth service_http token (header/query) | ✅ |
| OAuth auth-code per-user + auto refresh | ✅ (port refresh on-demand thay vì daemon) |
| OAuth: **confirm 2 bước anti-phishing**, nonce Redis, **AES mã hóa payload**, GC token | ❌ port state JWT ký + plaintext DB |
| OAuth client credentials | ❌ (gốc dormant — parity) |
| Per-tool auth mode override (required/supported/disabled) | ❌ |
| Common params inject mọi tool | ❌ |
| Param nâng cao: default-from-variable, enum, x-disable ẩn param, **file-typed params (10 loại) + signed URL**, response trimming (raw/default/err), auto-gen response schema từ mẫu | ❌ |
| **Tool debug lifecycle** (DebugWaiting→Passed, chặn publish khi chưa debug, lưu example) | ❌ có invoke thử, không gate |
| **Draft/publish + semver + chạy theo version ghim** | ❌ luôn bản hiện tại |
| Edit locking chống sửa đè | ❌ |
| Interrupt chat khi cần OAuth (event `tool_need_oauth`) | ⚠️ port trả connect_url trong tool result (cơ chế khác, dùng được) |

## 4. AGENT + CONVERSATION — port đạt ~40%

| Gốc | Port |
|---|---|
| Model params: temperature, max_tokens | ✅ |
| **top_p, frequency/presence penalty, top_k, response_format (json), history rounds config, prefix cache, sp flags** | ❌ (dễ thêm) |
| Persona prompt + biến {{var}} | ✅ |
| Onboarding: prologue tĩnh + suggested questions | ✅ |
| **Onboarding mode LLM tự sinh opener** | ❌ |
| **Auto follow-up suggestions** (graph sinh 3 câu hỏi tiếp) | ❌ |
| Background images (web/mobile, crop, gradient) | ❌ |
| **Multi-agent mode** (host + sub-agents, jump config, independent recognize) | ❌ |
| Shortcuts: cấu trúc lệnh + **panel components + template query + tool binding runtime** | ⚠️ lưu jsonb, chưa có runtime |
| Knowledge config per agent: top_k, min_score, strategy, auto/on-demand, show source, no-recall reply | ❌ hardcode top-6 auto |
| Bind plugin/workflow/database as tools | ✅ (cách hợp nhất của port gọn hơn gốc) |
| Draft/publish + version history + duplicate | ⚠️ có publish snapshot + releases; chat luôn chạy bản draft; chưa duplicate |
| Publish connectors: WebSDK / API | ⚠️ share link ≈ WebSDK-lite; czk key ≈ API connector |
| **Multimodal chat input (ảnh/file/audio/video)** | ❌ — chat chỉ text; sót lớn |
| 11 message types + reasoning_content + card/widget | ⚠️ text + tool_log |
| **Stop/cancel generation, break message** | ❌ |
| Sections / clear context (giữ log, cắt context) | ⚠️ clear = xóa messages |
| Chat API mở /v3/chat + /v1/conversations tương thích Coze SDK | ❌ API shape riêng |
| Suggest/feedback/regenerate endpoints | ❌ (gốc cũng không có feedback/regenerate — parity một phần) |

## 5. MEMORY — port đạt ~45%

| Gốc | Port |
|---|---|
| Database: schema cột 5 kiểu + required | ✅ (thiếu kiểu Date riêng biệt? port có date ✅) |
| **Draft/online table + publish** | ❌ |
| **Bảng vật lý MySQL + raw SQL/NL2SQL trong chat** | ⚠️ JSONB + filter engine (an toàn, yếu hơn) |
| **RW mode (ReadOnly / Limited / Unlimited)** | ❌ |
| **Scope record theo end-user** (limited mode: mỗi user thấy dữ liệu của mình) | ❌ — rows chung workspace; đáng làm |
| Import file (sheet chọn, header line, progress, template xlsx export) | ⚠️ import xlsx/csv sync, không chọn sheet/progress |
| Agent tools trên DB | ⚠️ query + insert; thiếu update/delete tool |
| Variables: KV per user | ✅ |
| **List variables, channels (system/location/feishu/app), schema, versioned meta, read-only, sys_uuid mã hóa** | ❌ plain KV |

## 6. PLATFORM — port đạt ~30%

| Domain gốc | Port |
|---|---|
| **App/Project** (đóng gói workflows+plugins+KB+DB+vars, publish theo version + connector, deep-copy, resource move app↔library) | ❌ toàn bộ |
| Connector (3 built-in: ChatSDK/API/Coze) | ⚠️ share page + czk keys phủ 2/3 use case |
| Template marketplace + duplicate | ❌ |
| Search (ES index project/resource, recently-edited, favorite) | ⚠️ name-search 5 loại resource |
| Upload domain (file 200MB multipart, icon mặc định 9 loại, avatar, imagex apply/commit, /v1/files/upload) | ⚠️ chỉ upload doc knowledge |
| User: email/password + session + reset password | ✅ thay bằng Supabase Auth (mạnh hơn: confirm email, OAuth social nếu bật) |
| Spaces personal/team | ✅ workspaces + **roles thật** (gốc không có member API) — port TỐT HƠN |
| Permission creator-only | ✅ RLS + role — TỐT HƠN |
| PAT + temporary/impersonate token | ⚠️ czk keys; thiếu temp token |
| **Admin model management** (CRUD model qua /api/admin/config, multi-provider) | ❌ — port cố định OpenAI qua env (chủ đích theo yêu cầu, nhưng đổi model phải redeploy) |
| Datacopy (copy tài nguyên cross-space, idempotent ledger) | ❌ |
| Eventbus RMQ → search index | ✅ không cần (Postgres query trực tiếp) |
| Open API /v1, /v3 shape tương thích Coze | ❌ |

## 7. FRONTEND — port đạt ~5–10%

Gốc: 2 IDE (Agent IDE + Project IDE), workflow canvas kéo-thả (encapsulate,
test-run panel, log viewer, undo/redo), knowledge import wizard + slice UI +
table editor, plugin editor + import wizard + mockset/testset, model manager,
prompt library UI + AI-assist prompt, store/explore, **Web ChatApp SDK nhúng
được**, monetization, content audit, i18n, analytics.

Port: console 1 file (JSON editor, chat test, upload, run workflow, keys,
usage, search) + trang chat public. Không có visual editing, không có SDK
nhúng chính thức (share page là iframe-able nhưng không phải SDK).

---

## Danh sách "sót" ưu tiên hóa

### P0 — ảnh hưởng trực tiếp chất lượng sản phẩm chạy thật
1. **Multimodal chat** (gửi ảnh/file trong hội thoại, vision passthrough)
2. **Knowledge recall config per agent** (top_k, min_score, strategy, on-demand)
3. **Model params đầy đủ** (top_p, penalties, response_format, history rounds)
4. **Slice/chunk management API** (xem/sửa/xóa/disable chunk)
5. **Stop generation** (cancel SSE + đánh dấu broken message)
6. **Workflow draft/publish + version snapshot** (như agent_releases)
7. **Plugin import từ OpenAPI/Swagger/curl** (nhập plugin thực tế)
8. Min-score threshold + query rewrite cho retrieval

### P1 — nâng parity đáng kể
9. Streaming/async workflow run + get_process; per-node retry/timeout/error branch
10. QuestionAnswer/InputReceiver (interrupt–resume, cần bảng checkpoint)
11. Per-user record scoping + RW mode cho agent databases; update/delete tools
12. Auto follow-up suggestions + LLM onboarding
13. Custom separators + hierarchical chunking; append table rows
14. Shortcuts runtime; conversation sections đúng nghĩa
15. API shape tương thích /v3/chat + /v1 (để dùng SDK/client Coze có sẵn)
16. Variables nâng cao (list, channels, versioned meta)
17. App/project packaging + publish theo version

### P2 — hệ sinh thái, làm sau
18. Visual workflow canvas (React Flow) + IDE
19. Marketplace/template store; product plugins có sẵn (port 18 plugin YAML)
20. Multi-agent mode; chatflow roles
21. ppstructure accurate parsing; rerank model; MCP plugins
22. Mockset/testset, trace viewer, admin model management UI
23. Web ChatApp SDK đóng gói npm; monetization/audit (SaaS-specific)

---

*Sinh bởi audit tự động 6-agent + đối chiếu thủ công, 2026-07-21. Dẫn chứng
file gốc nằm trong từng inventory; hỏi lại nếu cần trace mục cụ thể.*
