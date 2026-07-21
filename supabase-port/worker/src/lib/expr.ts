import jsep from 'jsep'

// Safe expression evaluator for the workflow `code` node. Cloudflare Workers
// forbid eval/new Function, so expressions are parsed to an AST (jsep) and
// interpreted against a whitelist — no prototype access, no arbitrary calls.

type Fn = (...args: any[]) => unknown

const FUNCTIONS: Record<string, Fn> = {
  abs: (n) => Math.abs(Number(n)),
  min: (...ns) => Math.min(...ns.map(Number)),
  max: (...ns) => Math.max(...ns.map(Number)),
  round: (n, d = 0) => Math.round(Number(n) * 10 ** Number(d)) / 10 ** Number(d),
  floor: (n) => Math.floor(Number(n)),
  ceil: (n) => Math.ceil(Number(n)),
  number: (v) => Number(v),
  string: (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')),
  boolean: (v) => Boolean(v),
  len: (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : Object.keys(v ?? {}).length),
  upper: (s) => String(s ?? '').toUpperCase(),
  lower: (s) => String(s ?? '').toLowerCase(),
  trim: (s) => String(s ?? '').trim(),
  split: (s, sep) => String(s ?? '').split(String(sep ?? ',')),
  join: (arr, sep) => (Array.isArray(arr) ? arr : []).join(String(sep ?? ',')),
  replace: (s, a, b) => String(s ?? '').replaceAll(String(a), String(b ?? '')),
  includes: (v, x) =>
    Array.isArray(v) ? v.includes(x) : String(v ?? '').includes(String(x ?? '')),
  slice: (v, a, b) =>
    (Array.isArray(v) ? v : String(v ?? '')).slice(Number(a ?? 0), b == null ? undefined : Number(b)),
  first: (arr) => (Array.isArray(arr) ? arr[0] : undefined),
  last: (arr) => (Array.isArray(arr) ? arr[arr.length - 1] : undefined),
  sum: (arr) => (Array.isArray(arr) ? arr.reduce((a, b) => a + Number(b ?? 0), 0) : 0),
  count: (arr) => (Array.isArray(arr) ? arr.length : 0),
  unique: (arr) => (Array.isArray(arr) ? [...new Set(arr)] : []),
  flatten: (arr) => (Array.isArray(arr) ? arr.flat() : []),
  reverse: (arr) => (Array.isArray(arr) ? [...arr].reverse() : []),
  sort: (arr) => (Array.isArray(arr) ? [...arr].sort() : []),
  range: (n) => Array.from({ length: Math.min(Number(n) || 0, 10_000) }, (_, i) => i),
  keys: (o) => Object.keys(o ?? {}),
  values: (o) => Object.values(o ?? {}),
  get: (o, path) =>
    String(path ?? '')
      .split('.')
      .reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as any)[k]), o),
  pluck: (arr, key) => (Array.isArray(arr) ? arr.map((x) => (x == null ? undefined : x[key])) : []),
  coalesce: (...vs) => vs.find((v) => v !== null && v !== undefined),
  json_parse: (s) => JSON.parse(String(s)),
  json_stringify: (v) => JSON.stringify(v ?? null),
}

const FORBIDDEN_PROPS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_EXPR_LENGTH = 5000

export function evalExpression(src: string, vars: Record<string, unknown>): unknown {
  if (src.length > MAX_EXPR_LENGTH) throw new Error('expression too long')
  const ast = jsep(src) as any
  let ops = 0

  const ev = (node: any): unknown => {
    if (++ops > 10_000) throw new Error('expression too complex')
    switch (node.type) {
      case 'Literal':
        return node.value
      case 'Identifier': {
        if (node.name in vars) return vars[node.name]
        if (node.name === 'true') return true
        if (node.name === 'false') return false
        if (node.name === 'null') return null
        throw new Error(`unknown identifier: ${node.name}`)
      }
      case 'MemberExpression': {
        const obj = ev(node.object)
        const prop = node.computed ? ev(node.property) : node.property.name
        if (obj == null) return undefined
        if (typeof prop === 'string' && FORBIDDEN_PROPS.has(prop)) {
          throw new Error(`forbidden property: ${prop}`)
        }
        if (typeof obj !== 'object') return undefined // no string/number method access
        return (obj as any)[prop as any]
      }
      case 'UnaryExpression': {
        const v = ev(node.argument)
        switch (node.operator) {
          case '!': return !v
          case '-': return -Number(v)
          case '+': return +Number(v)
          default: throw new Error(`unsupported unary operator: ${node.operator}`)
        }
      }
      case 'BinaryExpression': {
        const l = ev(node.left) as any
        const r = ev(node.right) as any
        switch (node.operator) {
          case '+': return l + r
          case '-': return Number(l) - Number(r)
          case '*': return Number(l) * Number(r)
          case '/': return Number(l) / Number(r)
          case '%': return Number(l) % Number(r)
          case '==': case '===': return l === r
          case '!=': case '!==': return l !== r
          case '>': return l > r
          case '<': return l < r
          case '>=': return l >= r
          case '<=': return l <= r
          default: throw new Error(`unsupported operator: ${node.operator}`)
        }
      }
      case 'LogicalExpression': {
        if (node.operator === '&&') return ev(node.left) && ev(node.right)
        if (node.operator === '||') return ev(node.left) || ev(node.right)
        throw new Error(`unsupported logical operator: ${node.operator}`)
      }
      case 'ConditionalExpression':
        return ev(node.test) ? ev(node.consequent) : ev(node.alternate)
      case 'ArrayExpression':
        return node.elements.map(ev)
      case 'CallExpression': {
        if (node.callee.type !== 'Identifier') {
          throw new Error('only built-in function calls are allowed')
        }
        const fn = FUNCTIONS[node.callee.name]
        if (!fn) throw new Error(`unknown function: ${node.callee.name}`)
        return fn(...node.arguments.map(ev))
      }
      default:
        throw new Error(`unsupported syntax: ${node.type}`)
    }
  }

  return ev(ast)
}
