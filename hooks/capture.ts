// Cockpit: the pure half of the observers: what a tool call is called, what
// its result says, which files it changed, how the counters move. The hooks
// themselves live in register.tsx, where `$` lives.
import type { ToolCallResult } from 'claude-code'

import type { CockpitAgent, CockpitAgentStatus, CockpitStats } from '../types'
import { createdHunks, diffTexts, fromStructuredPatch, lineOf } from './diff'
import type { Hunk } from './diff'
import { basename, clean, clip, excerpt, firstLine, fmtCount, MAX_AGENTS, MAX_OUTPUT, plural, SPARK_LEN, SPARK_MS, TEST_RE } from './model'



export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

// ---------------------------------------------------------------- describing a call
type Described = { title: string; detail?: string; filePath?: string; isTest?: boolean; isBackground?: boolean }

const hostOf = (url: string): string => {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}

/** A short human title for a call, from its arguments alone. */
export const describe = (input: Record<string, unknown>): Described => {
  const tool = String(input.tool)
  const a = input
  switch (tool) {
    case 'Bash': {
      const command = str(a.command) ?? ''
      const desc = str(a.description)
      return {
        title: desc !== undefined && desc !== '' ? desc : firstLine(command),
        detail: `$ ${clip(command.replace(/\s*\n\s*/g, ' ⏎ '), 400)}`,
        isTest: TEST_RE.test(command),
        isBackground: a.run_in_background === true,
      }
    }
    case 'Monitor':
      return { title: str(a.description) ?? 'Monitor', detail: str(a.command) }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Read': {
      const path = str(a.file_path) ?? ''
      const range =
        tool === 'Read' && num(a.offset) !== undefined
          ? ` :${num(a.offset)}${num(a.limit) !== undefined ? `+${num(a.limit)}` : ''}`
          : ''
      return { title: `${basename(path)}${range}`, detail: path, filePath: tool === 'Read' ? undefined : path }
    }
    case 'NotebookEdit': {
      const path = str(a.notebook_path) ?? ''
      return { title: `${basename(path)} · ${str(a.edit_mode) ?? 'replace'}`, detail: path, filePath: path }
    }
    case 'Grep':
      return { title: `/${str(a.pattern) ?? ''}/`, detail: str(a.path) ?? str(a.glob) }
    case 'Glob':
      return { title: str(a.pattern) ?? 'glob', detail: str(a.path) }
    case 'WebFetch':
      return { title: hostOf(str(a.url) ?? ''), detail: clip(str(a.prompt) ?? '', 200) }
    case 'WebSearch':
      return { title: `“${str(a.query) ?? ''}”` }
    case 'Agent':
    case 'Task':
      return {
        title: str(a.description) ?? 'agent',
        detail: `${str(a.subagent_type) ?? 'general-purpose'}${a.run_in_background === true ? ' · background' : ''}`,
        isBackground: a.run_in_background === true,
      }
    case 'Workflow':
      return {
        title: str(a.title) ?? str(a.name) ?? str(a.description) ?? 'workflow',
        detail: str(a.description) ?? str(a.scriptPath),
      }
    case 'Skill':
      return { title: `/${str(a.skill) ?? 'skill'}`, detail: str(a.args) }
    case 'TodoWrite':
      return { title: 'Todo list' }
    case 'ToolSearch':
      return { title: str(a.query) ?? 'tool search' }
    case 'SendMessage':
      return { title: `→ ${str(a.to) ?? '?'}`, detail: clip(str(a.message) ?? '', 200) }
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    const pretty = server.replace(/^Claude_/, '').replace(/_/g, ' ')
    const key =
      str(a.action) ?? str(a.url) ?? str(a.command) ?? str(a.query) ?? str(a.text) ?? str(a.path) ?? str(a.name)
    const hasBatch = Array.isArray(a.actions)
    return {
      title: `${name.replace(/_/g, ' ')}${key !== undefined ? ` · ${clip(key, 80)}` : hasBatch ? ` · ${plural((a.actions as unknown[]).length, 'action')}` : ''}`,
      detail: pretty,
    }
  }
  for (const k of ['description', 'title', 'name', 'query', 'path', 'file_path', 'url', 'command']) {
    const v = str(a[k])
    if (v !== undefined && v !== '') return { title: clip(v, 120) }
  }
  return { title: tool }
}

// ---------------------------------------------------------------- results
export const outputOf = (tool: string, r: ToolCallResult): { output?: string; exitCode?: number } => {
  if (r.deny !== undefined) return { output: excerpt(clean(r.deny), MAX_OUTPUT) }
  if (r.isError === true) {
    const text = clean(r.text ?? (typeof r.result === 'string' ? r.result : ''))
    const code = /exit code[:\s]+(-?\d+)/i.exec(text)
    return { output: excerpt(text, MAX_OUTPUT), exitCode: code !== null ? Number(code[1]) : tool === 'Bash' ? 1 : undefined }
  }
  const res = obj(r.result)
  if (tool === 'Bash') {
    const stdout = str(res.stdout) ?? ''
    const stderr = str(res.stderr) ?? ''
    const joined = [stdout.trimEnd(), stderr.trim() !== '' ? `── stderr ──\n${stderr.trimEnd()}` : '']
      .filter(Boolean)
      .join('\n')
    const bg = str(res.backgroundTaskId)
    const text = clean(joined !== '' ? joined : bg !== undefined ? `(in background · ${bg})` : r.text ?? '')
    return { output: excerpt(text, MAX_OUTPUT), exitCode: res.interrupted === true ? 130 : 0 }
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return { output: r.text !== undefined ? excerpt(clean(r.text), 600) : undefined }
  }
  return { output: r.text !== undefined ? excerpt(clean(r.text), MAX_OUTPUT) : undefined }
}

/**
 * One file a call changed. `isTooLarge`: the result carried no diff (the old
 * content was too large), `added` / `removed` then what it counted, if anything.
 */
export type FileChange = {
  path: string
  hunks: Hunk[]
  isCreated?: boolean
  isTooLarge?: boolean
  added?: number
  removed?: number
  /** A binary asset: no diff, its size instead. */
  isBinary?: boolean
  size?: number
}

/** The file changes a finished call made, from what its result carries. */
export const changesOf = (e: Record<string, unknown>, r: ToolCallResult): FileChange[] => {
  if (r.deny !== undefined || r.isError === true) return []
  const tool = String(e.tool)
  const res = obj(r.result)
  // Held for the machine owner to review: the file is unchanged.
  if (res.staged === true) return []
  if (tool === 'Edit' || tool === 'MultiEdit') {
    const path = str(res.filePath) ?? str(e.file_path) ?? ''
    const patch = fromStructuredPatch(res.structuredPatch)
    if (patch !== undefined && patch.length > 0) return [{ path, hunks: patch }]
    const original = str(res.originalFile) ?? null
    if (tool === 'Edit') {
      const before = str(e.old_string) ?? ''
      const after = str(e.new_string) ?? ''
      return [{ path, hunks: diffTexts(before, after, lineOf(original, before)) }]
    }
    const edits = Array.isArray(e.edits) ? e.edits : []
    const hunks: Hunk[] = []
    for (const one of edits) {
      const o = obj(one)
      const before = str(o.old_string) ?? ''
      hunks.push(...diffTexts(before, str(o.new_string) ?? '', lineOf(original, before)))
    }
    return [{ path, hunks }]
  }
  if (tool === 'Write') {
    const path = str(res.filePath) ?? str(e.file_path) ?? ''
    const content = str(res.content) ?? str(e.content) ?? ''
    const original = res.originalFile
    if (res.type === 'create') return [{ path, hunks: createdHunks(content), isCreated: true }]
    const patch = fromStructuredPatch(res.structuredPatch)
    if (patch !== undefined && patch.length > 0) return [{ path, hunks: patch }]
    if (original === null) {
      // An update whose old content was too large to include: no diff to show.
      const git = obj(res.gitDiff)
      return [{ path, hunks: [], isTooLarge: true, added: num(git.additions) ?? 0, removed: num(git.deletions) ?? 0 }]
    }
    return [{ path, hunks: diffTexts(str(original) ?? '', content) }]
  }
  if (tool === 'NotebookEdit') {
    const path = str(res.notebook_path) ?? str(e.notebook_path) ?? ''
    return [{ path, hunks: diffTexts(str(res.old_source) ?? '', str(res.new_source) ?? str(e.new_source) ?? '') }]
  }
  if (tool === 'Bash') {
    const bed = obj(res.bashEditDiff)
    if (!Array.isArray(bed.files)) return []
    const out: FileChange[] = []
    for (const f of bed.files) {
      const one = obj(f)
      const path = str(one.filePath)
      const hunks = fromStructuredPatch(one.hunks)
      if (path !== undefined && hunks !== undefined && hunks.length > 0)
        out.push({ path, hunks, isCreated: one.created === true })
    }
    return out
  }
  return []
}

// ---------------------------------------------------------------- counters
export const bumpSpark = (s: CockpitStats, now: number): Pick<CockpitStats, 'spark' | 'sparkAt'> => {
  const bucket = Math.floor(now / SPARK_MS)
  let spark = [...s.spark]
  if (s.sparkAt === 0 || bucket - s.sparkAt >= SPARK_LEN) spark = []
  else for (let i = s.sparkAt; i < bucket; i += 1) spark.push(0)
  if (spark.length === 0) spark.push(0)
  spark[spark.length - 1] = (spark[spark.length - 1] ?? 0) + 1
  return { spark: spark.slice(-SPARK_LEN), sparkAt: bucket }
}

export const placeholderAgent = (id: string, now: number): CockpitAgent => ({
  id,
  description: `agent ${id.slice(0, 8)}`,
  type: 'agent',
  status: 'running',
  startedAt: now,
  tools: 0,
  errors: 0,
})

/** Changes one agent of the list, adding a placeholder when it is unknown. */
export const upsertAgent = (
  list: readonly CockpitAgent[],
  id: string,
  now: number,
  change: (a: CockpitAgent) => CockpitAgent,
): CockpitAgent[] => {
  const at = list.findIndex(a => a.id === id)
  if (at < 0) return [...list, change(placeholderAgent(id, now))].slice(-MAX_AGENTS)
  const next = [...list]
  next[at] = change(list[at] ?? placeholderAgent(id, now))
  return next
}

/** `$.agent.list()` statuses in the cockpit's words. */
export const AGENT_STATUS: Record<string, CockpitAgentStatus | undefined> = {
  pending: 'running',
  running: 'running',
  waiting: 'running',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

export const agentStatusOf = (reason: string): CockpitAgentStatus =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'killed' : 'failed'

export const tokensOf = (usage: unknown): number => {
  const u = obj(usage)
  return (
    (num(u.input_tokens) ?? 0) +
    (num(u.output_tokens) ?? 0) +
    (num(u.cache_read_input_tokens) ?? 0) +
    (num(u.cache_creation_input_tokens) ?? 0)
  )
}

/** The text of a completed Agent result (`content` text blocks). */
export const agentAnswer = (result: Record<string, unknown>): string => {
  const content = Array.isArray(result.content) ? result.content : []
  return clean(content.map(c => str(obj(c).text) ?? '').join('\n'))
}

/**
 * The footer chip that opens the pane: the call count, and the agents at
 * work when there are some. Short on purpose: it sits beside the modes.
 */
export const footerChip = (stats: CockpitStats, agents: readonly CockpitAgent[]): string => {
  if (stats.calls === 0) return '◆ Cockpit'
  const running = agents.filter(a => a.status === 'running').length
  return `◆ ${fmtCount(stats.calls)}${running > 0 ? ` · ${plural(running, 'agent')}` : ''}`
}

/** The one line under the prompt. */
export const statusLine = (stats: CockpitStats, files: number, agents: readonly CockpitAgent[]): string => {
  const running = agents.filter(a => a.status === 'running').length
  const parts = [`◆ ${plural(stats.calls, 'call', fmtCount(stats.calls))}`]
  if (files > 0) parts.push(`✎ ${plural(files, 'file')} +${fmtCount(stats.added)} −${fmtCount(stats.removed)}`)
  if (agents.length > 0) parts.push(`🤖 ${running} running / ${agents.length}`)
  if (stats.errors > 0) parts.push(`✗ ${stats.errors}`)
  if (stats.streak >= 5) parts.push(`🔥 ×${stats.streak}`)
  return parts.join(' · ')
}

export type Milestone = { key: string; text: string }

/** Milestones reached and not yet celebrated. */
export const dueMilestones = (stats: CockpitStats, agents: number, files: number): Milestone[] => {
  const all: { key: string; ok: boolean; text: string }[] = [
    { key: 'calls-100', ok: stats.calls >= 100, text: '⚡ 100 tool calls — heating up!' },
    { key: 'calls-500', ok: stats.calls >= 500, text: '🚀 500 tool calls. Marathon mode.' },
    { key: 'combo-25', ok: stats.streak >= 25, text: '🔥 Combo ×25 without a single error' },
    { key: 'combo-100', ok: stats.streak >= 100, text: '🌟 Combo ×100 — flawless' },
    { key: 'agents-10', ok: agents >= 10, text: '🤖 10 agents launched' },
    { key: 'agents-25', ok: agents >= 25, text: '🛸 25 agents launched — a whole squadron' },
    { key: 'agents-50', ok: agents >= 50, text: '🌌 50 agents launched' },
    { key: 'files-10', ok: files >= 10, text: '📚 10 files changed' },
  ]
  return all.filter(m => m.ok && !stats.milestones.includes(m.key)).map(({ key, text }) => ({ key, text }))
}

/** Whether a finished call drove the simulator or emulator. */
export const touchesDevice = (tool: string, command: string): boolean =>
  tool.startsWith('mcp__Claude_Code_iOS_Simulator') || (tool === 'Bash' && /\b(simctl|adb)\b/.test(command))

