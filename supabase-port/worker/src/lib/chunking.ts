export interface ChunkOptions {
  size?: number
  overlap?: number
}

// Paragraph-aware greedy packing with a character-overlap tail. Replaces the
// original document parsing/splitting service in the knowledge domain.
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = Math.max(200, opts.size ?? 1000)
  const overlap = Math.min(Math.max(0, opts.overlap ?? 150), Math.floor(size / 2))

  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []

  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= size ? [p] : hardSplit(p, size)))

  const chunks: string[] = []
  let current = ''
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > size) {
      chunks.push(current)
      const tail = overlap > 0 ? current.slice(-overlap) : ''
      current = tail ? `${tail}\n\n${para}` : para
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }
  if (current) chunks.push(current)
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
