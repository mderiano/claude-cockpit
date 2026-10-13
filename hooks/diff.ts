// Cockpit: unified diffs the `Code` element's `format: 'diff'` parses.
// A diff here is hunks only: `@@ -a,b +c,d @@` then ' ', '+', '-' lines.
import { clean } from './model'

export type Hunk = {
  oldStart: number
  newStart: number
  lines: string[]
}

export type DiffText = {
  diff: string
  added: number
  removed: number
  isTruncated: boolean
}

const header = (h: Hunk): string => {
  let oldLines = 0
  let newLines = 0
  for (const line of h.lines) {
    const c = line[0]
    if (c === '+') newLines += 1
    else if (c === '-') oldLines += 1
    else if (c === '\\') continue
    else {
      oldLines += 1
      newLines += 1
    }
  }
  // An empty side starts one line before where it would be (unified diff).
  const oldStart = oldLines === 0 ? Math.max(0, h.oldStart - 1) : h.oldStart
  const newStart = newLines === 0 ? Math.max(0, h.newStart - 1) : h.newStart
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
}

/** Hunks to text, cut at `max` characters on a line boundary, counts kept right. */
export const renderHunks = (hunks: readonly Hunk[], max: number): DiffText => {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line[0] === '+') added += 1
      else if (line[0] === '-') removed += 1
    }
  }
  const out: string[] = []
  let size = 0
  let isTruncated = false
  for (const h of hunks) {
    const head = header(h)
    if (size + head.length + 1 > max) {
      isTruncated = true
      break
    }
    const kept: string[] = []
    let used = head.length + 1
    for (const raw of h.lines) {
      const safe = clean(raw)
      const line = safe.length > 400 ? `${safe.slice(0, 399)}…` : safe
      if (size + used + line.length + 1 > max) {
        isTruncated = true
        break
      }
      kept.push(line)
      used += line.length + 1
    }
    if (kept.length === 0) break
    const cut: Hunk = { oldStart: h.oldStart, newStart: h.newStart, lines: kept }
    out.push(header(cut), ...kept)
    size += used
    if (isTruncated) break
  }
  return { diff: out.length === 0 ? '' : `${out.join('\n')}\n`, added, removed, isTruncated }
}

/** Splits into lines, a trailing newline making no empty last line. */
export const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = { kind: ' ' | '+' | '-'; text: string }

/** Past these sizes a diff is one plain replace: bounded time and memory. */
const MAX_DIFF_LINES = 20_000
const MAX_DIFF_CELLS = 4_000_000
const MAX_DIFF_STEPS = 1000

/**
 * A line diff (Myers, O((N+M)D) time), falling back to a plain replace when
 * the inputs are too large to diff cheaply. Each step keeps only the live
 * window of its diagonals (2d+3 entries), so memory is O(D²) with D capped,
 * never a full copy of the frontier per step.
 */
export const diffLines = (a: readonly string[], b: readonly string[]): Op[] => {
  // Trim the common head and tail first: most edits are local.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const head: Op[] = a.slice(0, start).map(text => ({ kind: ' ', text }))
  const tail: Op[] = a.slice(endA).map(text => ({ kind: ' ', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  const replace = (): Op[] => [
    ...midA.map(text => ({ kind: '-' as const, text })),
    ...midB.map(text => ({ kind: '+' as const, text })),
  ]
  if (n === 0 || m === 0 || n + m > MAX_DIFF_LINES || n * m > MAX_DIFF_CELLS) return [...head, ...replace(), ...tail]

  const maxD = Math.min(n + m, MAX_DIFF_STEPS)
  // Diagonal k lives at v[offset + k]; one cell of slack on each side.
  const offset = maxD + 1
  const v = new Int32Array(2 * maxD + 3)
  // trace[d]: the frontier before step d, diagonals -(d+1)..(d+1).
  const trace: Int32Array[] = []
  let last = -1
  for (let d = 0; d <= maxD; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0
      else x = (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && midA[x] === midB[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        last = d
        break
      }
    }
    if (last >= 0) break
  }
  if (last < 0) return [...head, ...replace(), ...tail]

  // Walk back through the trace.
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = last; d >= 0; d -= 1) {
    const vd = trace[d]
    const at = (k: number): number => vd?.[k + d + 1] ?? 0
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1
    else prevK = k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', text: midA[x - 1] ?? '' })
      x -= 1
      y -= 1
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', text: midB[y - 1] ?? '' })
      else ops.push({ kind: '-', text: midA[x - 1] ?? '' })
    }
    x = prevX
    y = prevY
  }
  ops.reverse()
  return [...head, ...ops, ...tail]
}

/** Groups diff ops into hunks with `context` lines around each change. */
export const opsToHunks = (ops: readonly Op[], context = 3, firstLine = 1): Hunk[] => {
  const hunks: Hunk[] = []
  let oldNo = firstLine
  let newNo = firstLine
  let current: Hunk | null = null
  let lastChange = -Infinity
  const pos: { old: number; new: number }[] = []
  for (const op of ops) {
    pos.push({ old: oldNo, new: newNo })
    if (op.kind !== '+') oldNo += 1
    if (op.kind !== '-') newNo += 1
  }
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op === undefined || op.kind === ' ') continue
    if (current === null || i - lastChange > context * 2) {
      if (current !== null) {
        for (let j = lastChange + 1; j <= Math.min(ops.length - 1, lastChange + context); j += 1)
          current.lines.push(` ${ops[j]?.text ?? ''}`)
      }
      const from = Math.max(0, i - context)
      const at = pos[from] ?? { old: firstLine, new: firstLine }
      current = { oldStart: at.old, newStart: at.new, lines: [] }
      hunks.push(current)
      for (let j = from; j < i; j += 1) current.lines.push(` ${ops[j]?.text ?? ''}`)
    } else {
      for (let j = lastChange + 1; j < i; j += 1) current.lines.push(` ${ops[j]?.text ?? ''}`)
    }
    current.lines.push(`${op.kind}${op.text}`)
    lastChange = i
  }
  if (current !== null) {
    for (let j = lastChange + 1; j <= Math.min(ops.length - 1, lastChange + context); j += 1)
      current.lines.push(` ${ops[j]?.text ?? ''}`)
  }
  return hunks
}

/** A diff of two texts, as hunks with 3 lines of context. */
export const diffTexts = (before: string, after: string, firstLine = 1): Hunk[] =>
  opsToHunks(diffLines(splitLines(before), splitLines(after)), 3, firstLine)

/** A whole new file: one hunk of added lines. */
export const createdHunks = (content: string): Hunk[] => {
  const lines = splitLines(content)
  if (lines.length === 0) return []
  return [{ oldStart: 1, newStart: 1, lines: lines.map(line => `+${line}`) }]
}

/** A structuredPatch (jsdiff hunks) as the tools record it, read defensively. */
export const fromStructuredPatch = (patch: unknown): Hunk[] | undefined => {
  if (!Array.isArray(patch)) return undefined
  const hunks: Hunk[] = []
  for (const raw of patch) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as { oldStart?: unknown; newStart?: unknown; lines?: unknown }
    if (typeof one.oldStart !== 'number' || typeof one.newStart !== 'number' || !Array.isArray(one.lines)) continue
    hunks.push({
      oldStart: one.oldStart,
      newStart: one.newStart,
      lines: one.lines.filter((line): line is string => typeof line === 'string'),
    })
  }
  return hunks
}

/** The 1-based line where `needle` starts in `haystack`, or 1. */
export const lineOf = (haystack: string | null | undefined, needle: string): number => {
  if (haystack === null || haystack === undefined || needle === '') return 1
  const at = haystack.indexOf(needle)
  if (at < 0) return 1
  let line = 1
  for (let i = 0; i < at; i += 1) if (haystack.charCodeAt(i) === 10) line += 1
  return line
}
