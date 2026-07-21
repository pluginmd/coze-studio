import assert from 'node:assert'
import { zipSync, strToU8 } from 'fflate'
import { chunkText } from '../src/lib/chunking'
import { validateRow, applyFilters, type DbRow } from '../src/lib/database'
import { parseDocument } from '../src/lib/docparse'
import {
  renderTemplate,
  resolvePath,
  runWorkflow,
  type WfGraph,
} from '../src/engine/workflow'

// --- chunking ---------------------------------------------------------------
const chunks = chunkText('a'.repeat(2500) + '\n\n' + 'b'.repeat(600), { size: 1000, overlap: 100 })
assert(chunks.length >= 3, 'chunking should split long text')
assert(chunks.every((c) => c.length <= 1200), 'chunks respect size bound')

// --- database ---------------------------------------------------------------
const cols = [
  { name: 'title', type: 'text' as const, required: true },
  { name: 'qty', type: 'number' as const },
]
const row = validateRow(cols, { title: 'x', qty: '5' })
assert.strictEqual(row.qty, 5, 'number coercion')
assert.throws(() => validateRow(cols, { qty: 1 }), /required/, 'required check')
assert.throws(() => validateRow(cols, { nope: 1 }), /unknown column/, 'unknown column check')
const rows: DbRow[] = [
  { id: '1', data: { title: 'Alpha', qty: 3 }, created_by: '', created_at: '', updated_at: '' },
  { id: '2', data: { title: 'Beta', qty: 10 }, created_by: '', created_at: '', updated_at: '' },
]
assert.strictEqual(applyFilters(rows, [{ column: 'qty', op: 'gt', value: 5 }]).length, 1)
assert.strictEqual(applyFilters(rows, [{ column: 'title', op: 'contains', value: 'alp' }]).length, 1)

// --- docx / xlsx parsing ----------------------------------------------------
const docxBytes = zipSync({
  'word/document.xml': strToU8(
    '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Đoạn hai &amp; ba</w:t></w:r></w:p></w:body></w:document>'
  ),
})
const docxText = await parseDocument(docxBytes, 'test.docx')
assert(docxText.includes('Hello world'), 'docx paragraph join')
assert(docxText.includes('Đoạn hai & ba'), 'docx entity decode: ' + docxText)

const xlsxBytes = zipSync({
  'xl/sharedStrings.xml': strToU8('<sst><si><t>Name</t></si><si><t>Giá</t></si></sst>'),
  'xl/worksheets/sheet1.xml': strToU8(
    '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
      '<row><c><v>42</v></c><c><v>99</v></c></row></sheetData></worksheet>'
  ),
})
const xlsxText = await parseDocument(xlsxBytes, 'test.xlsx')
assert(xlsxText.includes('Name\tGiá'), 'xlsx shared strings row: ' + xlsxText)
assert(xlsxText.includes('42\t99'), 'xlsx numeric row')

// --- templating -------------------------------------------------------------
const scope = { input: { name: 'An' }, n1: { list: [1, 2], obj: { k: 'v' } } }
assert.strictEqual(renderTemplate('Hi {{input.name}}!', scope), 'Hi An!')
assert.strictEqual(renderTemplate('{{n1.obj.k}}/{{missing.x}}', scope), 'v/')
assert.deepStrictEqual(resolvePath(scope, 'n1.list'), [1, 2])

// --- workflow engine: branching DAG ----------------------------------------
const graph: WfGraph = {
  nodes: [
    { id: 'start', type: 'start', data: {} },
    { id: 'cond', type: 'condition', data: { left: '{{input.lang}}', op: 'eq', right: 'vi' } },
    { id: 'vi', type: 'template', data: { template: 'Xin chào {{input.name}}' } },
    { id: 'en', type: 'template', data: { template: 'Hello {{input.name}}' } },
    { id: 'agg', type: 'variable_aggregator', data: { values: { vi: '{{vi.text}}', en: '{{en.text}}' } } },
    { id: 'end', type: 'end', data: { template: '{{agg.vi}}{{agg.en}}' } },
  ],
  edges: [
    { source: 'start', target: 'cond' },
    { source: 'cond', target: 'vi', label: 'true' },
    { source: 'cond', target: 'en', label: 'false' },
    { source: 'vi', target: 'agg' },
    { source: 'en', target: 'agg' },
    { source: 'agg', target: 'end' },
  ],
}
const fakeEnv = {} as any
const fakeSupabase = {} as any
const r1 = await runWorkflow(fakeEnv, fakeSupabase, 'ws', graph, { lang: 'vi', name: 'An' })
assert.strictEqual((r1.output as any).text, 'Xin chào An', 'vi branch: ' + JSON.stringify(r1.output))
assert.strictEqual(r1.nodeResults['en'], undefined, 'en branch pruned')
const r2 = await runWorkflow(fakeEnv, fakeSupabase, 'ws', graph, { lang: 'en', name: 'Bob' })
assert.strictEqual((r2.output as any).text, 'Hello Bob', 'en branch')

// --- workflow engine: selector + text/json nodes ----------------------------
const graph2: WfGraph = {
  nodes: [
    { id: 'start', type: 'start', data: {} },
    { id: 'sel', type: 'selector', data: { branches: [
      { label: 'big', left: '{{input.n}}', op: 'gt', right: '10' },
      { label: 'small', left: '{{input.n}}', op: 'lt', right: '5' },
    ], default: 'mid' } },
    { id: 'big', type: 'template', data: { template: 'BIG' } },
    { id: 'small', type: 'template', data: { template: 'SMALL' } },
    { id: 'mid', type: 'json_stringify', data: { path: 'input' } },
    { id: 'proc', type: 'text_processor', data: { operation: 'concat', texts: ['{{big.text}}{{small.text}}{{mid.text}}', '!'], separator: '' } },
    { id: 'end', type: 'end', data: { outputs: { result: '{{proc.text}}' } } },
  ],
  edges: [
    { source: 'start', target: 'sel' },
    { source: 'sel', target: 'big', label: 'big' },
    { source: 'sel', target: 'small', label: 'small' },
    { source: 'sel', target: 'mid', label: 'mid' },
    { source: 'big', target: 'proc' },
    { source: 'small', target: 'proc' },
    { source: 'mid', target: 'proc' },
    { source: 'proc', target: 'end' },
  ],
}
const r3 = await runWorkflow(fakeEnv, fakeSupabase, 'ws', graph2, { n: 7 })
assert.strictEqual((r3.output as any).result, '{"n":7}!', 'selector default branch: ' + JSON.stringify(r3.output))
const r4 = await runWorkflow(fakeEnv, fakeSupabase, 'ws', graph2, { n: 50 })
assert.strictEqual((r4.output as any).result, 'BIG!', 'selector gt branch')

// --- workflow engine: failure carries nodeResults ---------------------------
const badGraph: WfGraph = {
  nodes: [
    { id: 'start', type: 'start', data: {} },
    { id: 'boom', type: 'json_parse', data: { text: 'not-json' } },
  ],
  edges: [{ source: 'start', target: 'boom' }],
}
try {
  await runWorkflow(fakeEnv, fakeSupabase, 'ws', badGraph, {})
  assert.fail('should have thrown')
} catch (e: any) {
  assert(/boom.*json_parse.*failed/.test(e.message), 'error names node: ' + e.message)
  assert(e.nodeResults?.start, 'nodeResults attached to error')
}

console.log('ALL SMOKE TESTS PASSED')
