import { renderTemplate } from '../engine/workflow'

// Shortcut commands (shortcutcmd domain): a chat message starting with the
// command trigger expands a template and/or runs a bound workflow.
// agent.shortcuts: [{ command: '/dich', description, template,
//                     components: [{name}], workflow_id? }]
export interface Shortcut {
  command: string
  description?: string
  template?: string
  components?: { name: string }[]
  workflow_id?: string
}

export interface ShortcutMatch {
  shortcut: Shortcut
  args: Record<string, string>
}

// `/cmd a | b | c` maps positionally onto components; `input` always holds
// the full remainder.
export function matchShortcut(shortcuts: Shortcut[], message: string): ShortcutMatch | null {
  const trimmed = message.trim()
  for (const shortcut of shortcuts ?? []) {
    const cmd = shortcut?.command?.trim()
    if (!cmd) continue
    if (trimmed !== cmd && !trimmed.startsWith(cmd + ' ')) continue
    const rest = trimmed.slice(cmd.length).trim()
    const args: Record<string, string> = { input: rest }
    const components = shortcut.components ?? []
    if (components.length) {
      const parts = rest.split('|').map((p) => p.trim())
      components.forEach((comp, i) => {
        if (comp?.name) args[comp.name] = parts[i] ?? ''
      })
    }
    return { shortcut, args }
  }
  return null
}

export function expandShortcut(match: ShortcutMatch): string {
  if (!match.shortcut.template?.trim()) return match.args.input
  return renderTemplate(match.shortcut.template, match.args as Record<string, unknown>)
}
