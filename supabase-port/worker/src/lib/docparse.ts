import { unzipSync, strFromU8 } from 'fflate'
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf'
import { extractText as extractPlainText } from './chunking'

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

function parseDocx(bytes: Uint8Array): string {
  const files = unzipSync(bytes)
  const doc = files['word/document.xml']
  if (!doc) throw new Error('invalid docx: missing word/document.xml')
  const xml = strFromU8(doc)
  const paragraphs = xml
    .split(/<\/w:p>/)
    .map((p) =>
      (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
        .map((m) => decodeXml(m.replace(/<[^>]+>/g, '')))
        .join('')
    )
    .filter((t) => t.trim())
  return paragraphs.join('\n\n')
}

function parseXlsx(bytes: Uint8Array): string {
  const files = unzipSync(bytes)
  const sharedXml = files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : ''
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml(m[1].replace(/<[^>]+>/g, ''))
  )
  const sheetNames = Object.keys(files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort()
  const lines: string[] = []
  for (const name of sheetNames) {
    const xml = strFromU8(files[name])
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1]
        const inner = cell[2]
        const value =
          inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? ''
        cells.push(/t="s"/.test(attrs) ? (shared[Number(value)] ?? '') : decodeXml(value))
      }
      if (cells.some((c) => c.trim())) lines.push(cells.join('\t'))
    }
  }
  return lines.join('\n')
}

async function parsePdf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractPdfText(pdf, { mergePages: true })
  return text
}

// Format-aware extraction: pdf/docx/xlsx are parsed natively at the edge
// (replaces the original Python parser + OCR sidecar for text content).
export async function parseDocument(bytes: Uint8Array, filename: string): Promise<string> {
  if (/\.pdf$/i.test(filename)) return parsePdf(bytes)
  if (/\.docx$/i.test(filename)) return parseDocx(bytes)
  if (/\.xlsx$/i.test(filename)) return parseXlsx(bytes)
  return extractPlainText(new TextDecoder().decode(bytes), filename)
}
