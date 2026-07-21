import type { Env } from '../env'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
}

export interface ChatOptions {
  model?: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  max_tokens?: number
}

export interface ChatResult {
  message: ChatMessage
  finishReason: string
  usage: Usage | null
}

function baseUrl(env: Env): string {
  return (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
}

function buildBody(env: Env, opts: ChatOptions, stream: boolean): Record<string, unknown> {
  return {
    model: opts.model || env.CHAT_MODEL || 'gpt-4o-mini',
    messages: opts.messages,
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.max_tokens != null ? { max_tokens: opts.max_tokens } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  }
}

async function request(env: Env, opts: ChatOptions, stream: boolean): Promise<Response> {
  const res = await fetch(`${baseUrl(env)}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(buildBody(env, opts, stream)),
  })
  if (!res.ok) {
    throw new Error(`openai chat failed: ${res.status} ${(await res.text()).slice(0, 500)}`)
  }
  return res
}

export async function chatComplete(env: Env, opts: ChatOptions): Promise<ChatResult> {
  const res = await request(env, opts, false)
  const json = (await res.json()) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[]
    usage?: Usage
  }
  const choice = json.choices?.[0]
  return {
    message: choice?.message ?? { role: 'assistant', content: '' },
    finishReason: choice?.finish_reason ?? 'stop',
    usage: json.usage ?? null,
  }
}

// Vision-based OCR (replaces the ppocr/veocr sidecars): sends the image to an
// OpenAI-compatible vision model and returns the transcribed text.
export async function ocrImage(env: Env, bytes: Uint8Array, mime: string): Promise<string> {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  const dataUrl = `data:${mime};base64,${btoa(binary)}`
  const res = await fetch(`${baseUrl(env)}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.CHAT_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Transcribe ALL text visible in this image verbatim, preserving reading order ' +
                'and line breaks. Output only the transcribed text, nothing else.',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error(`ocr failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return json.choices?.[0]?.message?.content ?? ''
}

export type StreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; result: ChatResult }

// Streams token deltas, then yields the fully accumulated message (including
// tool calls assembled from deltas) as the final event.
export async function* chatStream(env: Env, opts: ChatOptions): AsyncGenerator<StreamEvent> {
  const res = await request(env, opts, true)
  if (!res.body) throw new Error('openai returned no stream body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason = 'stop'
  let usage: Usage | null = null
  const toolCalls: ToolCall[] = []

  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') break outer
      let json: any
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      if (json.usage) usage = json.usage
      const choice = json.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta ?? {}
      if (delta.content) {
        content += delta.content
        yield { type: 'delta', content: delta.content }
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx: number = tc.index ?? 0
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } }
        }
        if (tc.id) toolCalls[idx].id = tc.id
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
      }
    }
  }

  const assembled = toolCalls.filter(Boolean)
  const message: ChatMessage = {
    role: 'assistant',
    content: content || null,
    ...(assembled.length ? { tool_calls: assembled } : {}),
  }
  yield { type: 'done', result: { message, finishReason, usage } }
}
