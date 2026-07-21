import type { Env } from '../env'
import {
  chatComplete,
  chatStream,
  contentText,
  type ChatResult,
  type Usage,
  type ChatMessage,
  type ToolDef,
} from './openai'

// A tool an agent can call: OpenAI function definition + an executor.
// Built from HTTP plugin tools, agent databases, and workflows alike.
export interface AgentTool {
  def: ToolDef
  execute: (args: Record<string, unknown>) => Promise<string>
}

export interface AgentLoopOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  responseFormat?: 'text' | 'json'
  messages: ChatMessage[]
  tools: AgentTool[]
  maxRounds?: number
}

export interface ToolLogEntry {
  name: string
  arguments: string
  output: string
}

export interface AgentLoopResult {
  content: string
  toolLog: ToolLogEntry[]
  usage: Usage
}

export type EmitFn = (event: Record<string, unknown>) => Promise<void>

// The core agent runtime: chat completion with a tool execution loop.
export async function runAgentLoop(
  env: Env,
  opts: AgentLoopOptions,
  emit?: EmitFn
): Promise<AgentLoopResult> {
  const messages = [...opts.messages]
  const toolsByName = new Map(opts.tools.map((t) => [t.def.function.name, t]))
  const toolDefs = opts.tools.map((t) => t.def)
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 }
  const toolLog: ToolLogEntry[] = []
  const maxRounds = opts.maxRounds ?? 5

  for (let round = 0; round < maxRounds; round++) {
    const chatOpts = {
      model: opts.model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      top_p: opts.topP,
      frequency_penalty: opts.frequencyPenalty,
      presence_penalty: opts.presencePenalty,
      response_format: opts.responseFormat,
      messages,
      tools: toolDefs,
    }

    let result: ChatResult
    if (emit) {
      let final: ChatResult | null = null
      for await (const ev of chatStream(env, chatOpts)) {
        if (ev.type === 'delta') await emit({ type: 'delta', content: ev.content })
        else final = ev.result
      }
      if (!final) throw new Error('stream ended without a final message')
      result = final
    } else {
      result = await chatComplete(env, chatOpts)
    }

    if (result.usage) {
      usage.prompt_tokens += result.usage.prompt_tokens ?? 0
      usage.completion_tokens += result.usage.completion_tokens ?? 0
    }

    const toolCalls = result.message.tool_calls ?? []
    if (result.finishReason !== 'tool_calls' || !toolCalls.length) {
      return { content: contentText(result.message.content), toolLog, usage }
    }

    messages.push(result.message)
    for (const call of toolCalls) {
      const tool = toolsByName.get(call.function.name)
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        // model produced malformed JSON — invoke with no args
      }
      if (emit) await emit({ type: 'tool_call', name: call.function.name, args })
      let output: string
      if (!tool) {
        output = JSON.stringify({ error: `unknown tool: ${call.function.name}` })
      } else {
        try {
          output = await tool.execute(args)
        } catch (e) {
          output = JSON.stringify({ error: String(e).slice(0, 500) })
        }
      }
      if (emit) {
        await emit({ type: 'tool_result', name: call.function.name, output: output.slice(0, 2000) })
      }
      toolLog.push({
        name: call.function.name,
        arguments: call.function.arguments,
        output: output.slice(0, 8000),
      })
      messages.push({ role: 'tool', content: output, tool_call_id: call.id })
    }
  }

  return { content: 'Tool call limit reached without a final answer.', toolLog, usage }
}
