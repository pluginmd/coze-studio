import { unzipSync, strFromU8 } from 'fflate'
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf'
import type { Env } from '../env'
import { extractText as extractPlainText } from './chunking'
import { ocrImage } from './openai'

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

export function xlsxRows(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes)
  const sharedXml = files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : ''
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml(m[1].replace(/<[^>]+>/g, ''))
  )
  const sheetNames = Object.keys(files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort()
  const rows: string[][] = []
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
      if (cells.some((c) => c.trim())) rows.push(cells)
    }
  }
  return rows
}

export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/\r\n/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      if (row.some((c) => c.trim())) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

// Tabular extraction for database import (table-mode knowledge).
export function parseTable(bytes: Uint8Array, filename: string): string[][] {
  if (/\.xlsx$/i.test(filename)) return xlsxRows(bytes)
  if (/\.(csv|tsv)$/i.test(filename)) {
    const text = new TextDecoder().decode(bytes)
    if (/\.tsv$/i.test(filename)) {
      return text
        .split('\n')
        .map((l) => l.replace(/\r$/, '').split('\t'))
        .filter((r) => r.some((c) => c.trim()))
    }
    return csvRows(text)
  }
  throw new Error('table import supports xlsx, csv, tsv')
}

async function parsePdf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractPdfText(pdf, { mergePages: true })
  return text
}

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

// Format-aware extraction: pdf/docx/xlsx parsed natively at the edge; images
// are OCR'd via the OpenAI vision model (replaces the ppocr/veocr sidecars).
export async function parseDocument(bytes: Uint8Array, filename: string, env?: Env): Promise<string> {
  if (/\.pdf$/i.test(filename)) return parsePdf(bytes)
  if (/\.docx$/i.test(filename)) return parseDocx(bytes)
  if (/\.xlsx$/i.test(filename)) {
    return xlsxRows(bytes)
      .map((r) => r.join('\t'))
      .join('\n')
  }
  const imageExt = filename.match(/\.(\w+)$/)?.[1]?.toLowerCase()
  if (imageExt && IMAGE_MIMES[imageExt]) {
    if (!env) throw new Error('image OCR requires model access')
    return ocrImage(env, bytes, IMAGE_MIMES[imageExt])
  }
  return extractPlainText(new TextDecoder().decode(bytes), filename)
}
