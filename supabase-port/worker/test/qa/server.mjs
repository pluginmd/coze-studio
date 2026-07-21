// Mock backend for browser QA: serves the real console/share HTML plus
// fixture API responses (including a streaming SSE chat) so the full UI can
// be exercised in Chromium without live Supabase/OpenAI.
// Run with: npx tsx test/qa/server.mjs
import { createServer } from 'node:http'
import { consoleHtml } from '../../src/console/index'
import { sharePageHtml } from '../../src/routes/sharepage'

const WID = '11111111-1111-1111-1111-111111111111'
const AID = '22222222-2222-2222-2222-222222222222'
const WFID = '33333333-3333-3333-3333-333333333333'
const DSID = '44444444-4444-4444-4444-444444444444'
const PID = '55555555-5555-5555-5555-555555555555'
const DBID = '66666666-6666-6666-6666-666666666666'

const agent = {
  id: AID, name: 'Trợ lý CSKH', description: 'Trả lời khách hàng dựa trên FAQ', status: 'published',
  updated_at: '2026-07-21T09:00:00Z', prompt: 'Bạn là trợ lý thân thiện của {{sys.agent_name}}.',
  model: { model: 'gpt-4o-mini', temperature: 0.7, history_rounds: 10 },
  welcome_message: 'Xin chào! Mình giúp gì được?', suggested_questions: ['Chính sách đổi trả?', 'Phí ship?'],
  dataset_ids: [DSID], plugin_tool_ids: [], workflow_ids: [], database_ids: [DBID],
  variables: { brand: 'CozeShop' }, shortcuts: [], knowledge: { top_k: 4, search_type: 'hybrid' },
  suggest_reply: { mode: 'auto' }, onboarding: { mode: 'manual' }, multi_agent: {},
  share_token: 'qa-share-token',
}
const graph = {
  nodes: [
    { id: 'start', type: 'start', data: { inputs: [{ name: 'question' }] } },
    { id: 'recall', type: 'knowledge_retrieve', data: { query: '{{input.question}}', top_k: 4 } },
    { id: 'answer', type: 'llm', data: { system: 'Trả lời dựa trên context', prompt: '{{recall.text}}\n\n{{input.question}}' } },
    { id: 'check', type: 'condition', data: { left: '{{answer.text}}', op: 'not_empty', right: '' } },
    { id: 'fallback', type: 'template', data: { template: 'Xin lỗi, chưa có thông tin.' } },
    { id: 'end', type: 'end', data: { template: '{{answer.text}}{{fallback.text}}' } },
  ],
  edges: [
    { source: 'start', target: 'recall' },
    { source: 'recall', target: 'answer' },
    { source: 'answer', target: 'check' },
    { source: 'check', target: 'end', label: 'true' },
    { source: 'check', target: 'fallback', label: 'false' },
    { source: 'fallback', target: 'end' },
  ],
}

const fixtures = {
  'GET /v1/workspaces': [{ id: WID, name: 'QA Workspace', role: 'owner' }],
  ['GET /v1/workspaces/' + WID + '/agents']: [agent, { id: 'a2', name: 'Dịch thuật viên', description: 'Chuyên dịch đa ngôn ngữ', status: 'draft', updated_at: '2026-07-20T08:00:00Z' }],
  ['GET /v1/workspaces/' + WID + '/agents/' + AID]: agent,
  ['GET /v1/workspaces/' + WID + '/datasets']: [{ id: DSID, name: 'FAQ', description: 'Câu hỏi thường gặp', updated_at: '2026-07-21T07:00:00Z' }],
  ['GET /v1/workspaces/' + WID + '/datasets/' + DSID + '/documents']: [
    { id: 'd1', name: 'chinh-sach.pdf', status: 'ready', chunk_count: 24, created_at: '2026-07-21' },
    { id: 'd2', name: 'bang-gia.xlsx', status: 'processing', chunk_count: 0, created_at: '2026-07-21' },
    { id: 'd3', name: 'loi.docx', status: 'failed', error: 'document produced no text chunks', chunk_count: 0 },
  ],
  ['GET /v1/workspaces/' + WID + '/datasets/' + DSID + '/documents/d1/chunks']: [
    { id: 1, seq: 0, content: 'Khách hàng được đổi trả trong 30 ngày kể từ ngày nhận hàng với hóa đơn gốc.', enabled: true },
    { id: 2, seq: 1, content: 'Phí vận chuyển toàn quốc đồng giá 30.000đ, miễn phí cho đơn từ 500.000đ.', enabled: false },
  ],
  ['GET /v1/workspaces/' + WID + '/workflows']: [{ id: WFID, name: 'tra-loi-faq', description: 'RAG + fallback', status: 'published', updated_at: '2026-07-21T06:00:00Z' }],
  ['GET /v1/workspaces/' + WID + '/workflows/' + WFID]: { id: WFID, name: 'tra-loi-faq', status: 'published', graph },
  ['GET /v1/workspaces/' + WID + '/plugins']: [
    { id: PID, name: 'Open-Meteo Weather', base_url: 'https://api.open-meteo.com', kind: 'http' },
    { id: 'p2', name: 'Docs MCP', base_url: 'https://mcp.example.dev/mcp', kind: 'mcp' },
  ],
  ['GET /v1/workspaces/' + WID + '/plugins/' + PID]: { id: PID, name: 'Open-Meteo Weather', description: 'Thời tiết', base_url: 'https://api.open-meteo.com', auth: { type: 'none' } },
  ['GET /v1/workspaces/' + WID + '/plugins/' + PID + '/tools']: [
    { id: 't1', name: 'get_forecast', description: 'Dự báo theo tọa độ', method: 'GET', path: '/v1/forecast', debug_status: 'passed', parameters: [ { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } }, { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } } ] },
  ],
  ['GET /v1/workspaces/' + WID + '/plugins/p2/tools']: [
    { id: 't2', name: 'search-docs', description: 'Tìm tài liệu', method: 'POST', path: 'search-docs', debug_status: 'waiting', parameters: [{ name: 'query', in: 'body', required: true, schema: { type: 'string' } }] },
  ],
  ['GET /v1/workspaces/' + WID + '/databases']: [{ id: DBID, name: 'orders', rw_mode: 'per_user', columns: [ { name: 'title', type: 'text', required: true }, { name: 'qty', type: 'number' }, { name: 'done', type: 'boolean' } ] }],
  ['GET /v1/workspaces/' + WID + '/apps']: [{ id: 'app1', name: 'CSKH Suite', description: 'Bundle CSKH', updated_at: '2026-07-21' }],
  ['GET /v1/workspaces/' + WID + '/apps/app1']: { id: 'app1', name: 'CSKH Suite', agent_ids: [AID], workflow_ids: [WFID], dataset_ids: [DSID], database_ids: [], plugin_ids: [] },
  ['GET /v1/workspaces/' + WID + '/apps/app1/releases']: [{ id: 'r1', version: 1, created_at: '2026-07-21T05:00:00Z' }],
  ['GET /v1/workspaces/' + WID + '/prompts']: [{ id: 'pr1', name: 'Tông giọng thân thiện', description: 'Persona chuẩn CSKH' }],
  ['GET /v1/workspaces/' + WID + '/api-keys']: [
    { id: 'k1', name: 'production', prefix: 'czk_a1b2c3', last_used_at: '2026-07-21T02:00:00Z', revoked_at: null },
    { id: 'k2', name: 'old-key', prefix: 'czk_zz9910', last_used_at: null, revoked_at: '2026-07-01' },
  ],
  ['GET /v1/workspaces/' + WID + '/usage']: { since: '2026-06-21', totals: [
    { kind: 'chat', model: 'gpt-4o-mini', prompt_tokens: 182000, completion_tokens: 64000, events: 412 },
    { kind: 'embedding', model: 'jina-embeddings-v3', prompt_tokens: 90000, completion_tokens: 0, events: 38 },
    { kind: 'workflow', model: 'gpt-4o-mini', prompt_tokens: 21000, completion_tokens: 9000, events: 17 },
  ] },
  ['GET /v1/workspaces/' + WID + '/admin/perf']: { note: 'instance-wide', queries: [
    { query: 'select * from chunks where workspace_id = $1 order by embedding <=> $2 limit $3', calls: 812, total_ms: 5200, mean_ms: 6.4, rows_returned: 6496 },
    { query: 'insert into messages (conversation_id, workspace_id, role, content) values ($1, $2, $3, $4)', calls: 1650, total_ms: 900, mean_ms: 0.5, rows_returned: 1650 },
  ] },
  ['GET /v1/workspaces/' + WID + '/templates']: [
    { id: 'support-agent', name: 'Trợ lý CSKH + FAQ', description: 'Agent + KB mẫu' },
    { id: 'translator', name: 'Workflow dịch thuật', description: 'Dịch đa ngôn ngữ' },
    { id: 'plugin-weather', name: 'Plugin thời tiết', description: 'Open-Meteo, không cần key' },
  ],
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let i = 0
  const timer = setInterval(() => {
    if (i >= events.length) { clearInterval(timer); res.end(); return }
    const [event, data] = events[i++]
    res.write('event: ' + event + '\n')
    res.write('data: ' + JSON.stringify(data) + '\n\n')
  }, 60)
}

const chatReply = 'Chào bạn! Theo **chính sách đổi trả**, bạn có thể:\n\n- Đổi trả trong vòng `30 ngày`\n- Cần giữ hóa đơn gốc\n\n```js\nconst refund = order.total * 1.0\n```\n\nXem thêm tại [trang chính sách](https://example.dev/policy).'

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const key = req.method + ' ' + url.pathname

  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(consoleHtml); return }
  if (url.pathname.startsWith('/share/') && req.method === 'GET' && !url.pathname.endsWith('/info')) {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(sharePageHtml); return
  }
  if (url.pathname.endsWith('/info')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: agent.name, description: agent.description, welcome_message: agent.welcome_message, suggested_questions: agent.suggested_questions }))
    return
  }
  if (req.method === 'POST' && (url.pathname.endsWith('/chat') && !url.pathname.includes('/workflows/'))) {
    const deltas = chatReply.match(/[\s\S]{1,14}/g).map((chunk) => ['delta', { type: 'delta', content: chunk }])
    sse(res, [
      ['start', { conversation_id: 'conv-1' }],
      ['tool_call', { type: 'tool_call', name: 'search_knowledge', args: { query: 'đổi trả' } }],
      ['tool_result', { type: 'tool_result', name: 'search_knowledge', output: '[{"content":"Đổi trả 30 ngày"}]' }],
      ...deltas,
      ['suggestion', { suggestions: ['Điều kiện đổi trả?', 'Hoàn tiền mất bao lâu?', 'Đổi size thế nào?'] }],
      ['done', { conversation_id: 'conv-1', usage: { prompt_tokens: 320, completion_tokens: 96 } }],
    ])
    return
  }
  if (req.method === 'POST' && url.pathname.includes('/workflows/') && url.pathname.endsWith('/run')) {
    sse(res, [
      ['node_start', { node_id: 'start', node_type: 'start' }],
      ['node_finish', { node_id: 'start', node_type: 'start', result: '{"question":"phí ship"}' }],
      ['node_start', { node_id: 'recall', node_type: 'knowledge_retrieve' }],
      ['node_finish', { node_id: 'recall', node_type: 'knowledge_retrieve', result: '{"chunks":2}' }],
      ['node_start', { node_id: 'answer', node_type: 'llm' }],
      ['node_delta', { node_id: 'answer', content: 'Phí ship đồng giá ' }],
      ['node_delta', { node_id: 'answer', content: '30.000đ toàn quốc.' }],
      ['node_finish', { node_id: 'answer', node_type: 'llm', result: '{"text":"Phí ship đồng giá 30.000đ"}' }],
      ['succeeded', { run_id: 'run-1', status: 'succeeded', output: { text: 'Phí ship đồng giá 30.000đ toàn quốc.' } }],
    ])
    return
  }

  if (key in fixtures) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(fixtures[key]))
    return
  }
  if (req.method !== 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, id: 'mock-id', version: 1, key: 'czk_mocked_key_value', url: 'http://localhost/share/qa-share-token', tools_imported: 3, warnings: [], inserted: 5, skipped: 0, invited: true, created: {}, packed: {} }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify([]))
})

server.listen(4599, () => console.log('QA server on http://localhost:4599'))
