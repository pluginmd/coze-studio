import { Hono } from 'hono'
import type { AppEnv } from '../env'

// Built-in starter templates (template domain, lean): list + one-click
// install into the current workspace.
interface Template {
  id: string
  name: string
  description: string
  agent?: Record<string, unknown>
  workflow?: { name: string; description: string; graph: Record<string, unknown> }
  dataset?: { name: string; description: string }
}

const TEMPLATES: Template[] = [
  {
    id: 'support-agent',
    name: 'Trợ lý CSKH + FAQ',
    description: 'Agent chăm sóc khách hàng kèm knowledge base FAQ và follow-up suggestions.',
    agent: {
      name: 'Trợ lý CSKH',
      description: 'Trả lời khách hàng dựa trên FAQ',
      prompt:
        'Bạn là trợ lý chăm sóc khách hàng thân thiện. Trả lời ngắn gọn, chính xác dựa trên ' +
        'tài liệu FAQ được cung cấp. Nếu không chắc, hãy nói bạn sẽ chuyển cho nhân viên.',
      welcome_message: 'Xin chào! Mình có thể giúp gì cho bạn hôm nay?',
      suggested_questions: ['Chính sách đổi trả thế nào?', 'Thời gian giao hàng bao lâu?'],
      suggest_reply: { mode: 'auto' },
      knowledge: { top_k: 4, min_score: 0.3 },
    },
    dataset: { name: 'FAQ', description: 'Câu hỏi thường gặp — upload tài liệu của bạn vào đây' },
  },
  {
    id: 'translator',
    name: 'Workflow dịch thuật',
    description: 'Workflow dịch văn bản sang ngôn ngữ đích, dùng được như tool cho agent.',
    workflow: {
      name: 'translate',
      description: 'Translate text into a target language',
      graph: {
        nodes: [
          {
            id: 'start',
            type: 'start',
            data: {
              inputs: [
                { name: 'text', type: 'string', description: 'text to translate', required: true },
                { name: 'target', type: 'string', description: 'target language, e.g. English' },
              ],
            },
          },
          {
            id: 'llm',
            type: 'llm',
            data: {
              system: 'You are a professional translator. Output only the translation.',
              prompt: 'Translate into {{input.target}}:\n\n{{input.text}}',
              temperature: 0.2,
            },
          },
          { id: 'end', type: 'end', data: { outputs: { translation: '{{llm.text}}' } } },
        ],
        edges: [
          { source: 'start', target: 'llm' },
          { source: 'llm', target: 'end' },
        ],
      },
    },
  },
  {
    id: 'web-summarizer',
    name: 'Workflow tóm tắt trang web',
    description: 'Fetch một URL, làm sạch nội dung và tóm tắt bằng LLM (có error branch).',
    workflow: {
      name: 'summarize_url',
      description: 'Fetch a web page and summarize it',
      graph: {
        nodes: [
          {
            id: 'start',
            type: 'start',
            data: { inputs: [{ name: 'url', type: 'string', required: true }] },
          },
          {
            id: 'fetch',
            type: 'http',
            data: {
              url: '{{input.url}}',
              method: 'GET',
              timeout_ms: 15000,
              on_error: { strategy: 'branch', retry: 1 },
            },
          },
          {
            id: 'summarize',
            type: 'llm',
            data: {
              system: 'Summarize the page content in 5 concise bullet points, same language as the content.',
              prompt: '{{fetch.body}}',
              max_tokens: 600,
            },
          },
          { id: 'fail', type: 'template', data: { template: 'Không tải được trang: {{fetch.error}}' } },
          { id: 'end', type: 'end', data: { template: '{{summarize.text}}{{fail.text}}' } },
        ],
        edges: [
          { source: 'start', target: 'fetch' },
          { source: 'fetch', target: 'summarize' },
          { source: 'fetch', target: 'fail', label: 'error' },
          { source: 'summarize', target: 'end' },
          { source: 'fail', target: 'end' },
        ],
      },
    },
  },
]

export const templates = new Hono<AppEnv>()

templates.get('/', (c) =>
  c.json(TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })))
)

templates.post('/:tid/install', async (c) => {
  const template = TEMPLATES.find((t) => t.id === c.req.param('tid'))
  if (!template) return c.json({ error: 'template not found' }, 404)
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const createdBy = c.get('authKind') === 'user' ? c.get('userId') : null
  const created: Record<string, string> = {}

  let datasetId: string | null = null
  if (template.dataset) {
    const { data, error } = await supabase
      .from('datasets')
      .insert({ ...template.dataset, workspace_id: wid })
      .select('id')
      .single()
    if (error) return c.json({ error: error.message }, 500)
    datasetId = data.id
    created.dataset_id = data.id
  }
  if (template.workflow) {
    const { data, error } = await supabase
      .from('workflows')
      .insert({ ...template.workflow, workspace_id: wid, created_by: createdBy })
      .select('id')
      .single()
    if (error) return c.json({ error: error.message }, 500)
    created.workflow_id = data.id
  }
  if (template.agent) {
    const { data, error } = await supabase
      .from('agents')
      .insert({
        ...template.agent,
        ...(datasetId ? { dataset_ids: [datasetId] } : {}),
        workspace_id: wid,
        created_by: createdBy,
      })
      .select('id')
      .single()
    if (error) return c.json({ error: error.message }, 500)
    created.agent_id = data.id
  }
  return c.json({ ok: true, template: template.id, created }, 201)
})
