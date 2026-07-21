export interface ChunkStrategy {
  mode?: 'auto' | 'separator' | 'heading'
  separators?: string[]
  size?: number
  overlap?: number
  trim_url_email?: boolean
}

// Chunking strategies mirroring the original knowledge domain:
//  - auto: paragraph-aware greedy packing with overlap tail
//  - separator: split by custom separators (in order), then greedy pack
//  - heading: split markdown by headings, prefix each chunk with its title path
export function chunkText(text: string, strategy: ChunkStrategy = {}): string[] {
  const size = Math.max(200, strategy.size ?? 1000)
  const overlap = Math.min(Math.max(0, strategy.overlap ?? 150), Math.floor(size / 2))

  let clean = text.replace(/\r\n/g, '\n').trim()
  if (strategy.trim_url_email) {
    clean = clean
      .replace(/https?:\/\/[^\s)>\]]+/g, ' ')
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ')
  }
  if (!clean) return []

  if (strategy.mode === 'heading') return chunkByHeading(clean, size)

  let blocks: string[]
  if (strategy.mode === 'separator' && strategy.separators?.length) {
    blocks = [clean]
    for (const sep of strategy.separators) {
      blocks = blocks.flatMap((b) => b.split(sep))
    }
    blocks = blocks.map((b) => b.trim()).filter(Boolean)
  } else {
    blocks = clean
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
  }
  blocks = blocks.flatMap((b) => (b.length <= size ? [b] : hardSplit(b, size)))

  const chunks: string[] = []
  let current = ''
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > size) {
      chunks.push(current)
      const tail = overlap > 0 ? current.slice(-overlap) : ''
      current = tail ? `${tail}\n\n${block}` : block
    } else {
      current = current ? `${current}\n\n${block}` : block
    }
  }
  if (current) chunks.push(current)
  return chunks
}

// Markdown-heading segmentation: each section carries its heading path
// ("H1 > H2") so retrieval keeps hierarchical context (leveled chunking).
function chunkByHeading(text: string, size: number): string[] {
  const lines = text.split('\n')
  const sections: { path: string[]; body: string[] }[] = []
  let current: { path: string[]; body: string[] } = { path: [], body: [] }
  const stack: { level: number; title: string }[] = []

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m) {
      if (current.body.some((l) => l.trim())) sections.push(current)
      const level = m[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, title: m[2].trim() })
      current = { path: stack.map((s) => s.title), body: [] }
    } else {
      current.body.push(line)
    }
  }
  if (current.body.some((l) => l.trim())) sections.push(current)

  const chunks: string[] = []
  for (const section of sections) {
    const prefix = section.path.length ? section.path.join(' > ') + '\n\n' : ''
    const body = section.body.join('\n').trim()
    if (!body) continue
    const bodySize = Math.max(200, size - prefix.length)
    for (const part of body.length <= bodySize ? [body] : hardSplit(body, bodySize)) {
      chunks.push(prefix + part)
    }
  }
  return chunks
}

function hardSplit(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

export function extractText(raw: string, filename: string): string {
  if (/\.(html?|xhtml)$/i.test(filename)) {
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{3,}/g, '\n\n')
  }
  if (/\.json$/i.test(filename)) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 1)
    } catch {
      return raw
    }
  }
  return raw
}
