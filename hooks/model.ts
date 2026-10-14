// Cockpit: state atoms, bounds, palette and formatting helpers.
import type {
  CockpitCategory,
  CockpitScreen,
  CockpitStats,
  CockpitStatus,
  CockpitAgentStatus,
  CockpitUi,
} from '../types'

// ---------------------------------------------------------------- bounds
export const MAX_EVENTS = 300
export const MAX_FILES = 200
export const MAX_CHANGES_PER_FILE = 12
export const MAX_AGENTS = 150
export const MAX_WORKFLOWS = 20
export const MAX_OUTPUT = 4000
export const MAX_INPUT = 2000
export const MAX_DIFF = 12000
/** Feed rows drawn at once: a page, so the tree stays far under the text budget. */
export const FEED_PAGE = 40
export const SPARK_MS = 15_000
export const SPARK_LEN = 24
export const PANE = 'cockpit'
/** Svg sources are capped at 131072 characters; keep the picture under this. */
export const MAX_SVG_B64 = 120_000

// ---------------------------------------------------------------- initial values
export const EMPTY_STATS: CockpitStats = {
  startedAt: 0,
  calls: 0,
  commands: 0,
  errors: 0,
  denied: 0,
  added: 0,
  removed: 0,
  running: 0,
  streak: 0,
  bestStreak: 0,
  turns: 0,
  isWorking: false,
  spark: [],
  sparkAt: 0,
  milestones: [],
}

export const EMPTY_UI: CockpitUi = {
  tab: 'feed',
  filter: 'all',
  expanded: null,
  file: null,
  agent: null,
  limit: FEED_PAGE,
  offset: 0,
  openRuns: [],
  showAllAgents: false,
  autoOpened: false,
}

export const EMPTY_SCREEN: CockpitScreen = {
  isLive: false,
  source: 'none',
  label: '',
  generation: 0,
}

// ---------------------------------------------------------------- palette
/** One hue per category: saturated enough to read on light and dark themes. */
export const CAT_COLOR: Record<CockpitCategory, string> = {
  shell: '#f59e0b',
  edit: '#22c55e',
  read: '#3b82f6',
  search: '#6366f1',
  web: '#8b5cf6',
  agent: '#ec4899',
  browser: '#06b6d4',
  mcp: '#14b8a6',
  task: '#f97316',
  other: '#94a3b8',
}

export const CAT_LABEL: Record<CockpitCategory, string> = {
  shell: 'SHELL',
  edit: 'EDIT',
  read: 'READ',
  search: 'FIND',
  web: 'WEB',
  agent: 'AGENT',
  browser: 'SCREEN',
  mcp: 'MCP',
  task: 'TASK',
  other: 'TOOL',
}

export const STATUS_COLOR: Record<CockpitStatus, string> = {
  running: '#38bdf8',
  ok: '#22c55e',
  error: '#ef4444',
  denied: '#f97316',
}

export const AGENT_COLOR: Record<CockpitAgentStatus, string> = {
  running: '#38bdf8',
  idle: '#a78bfa',
  done: '#22c55e',
  failed: '#ef4444',
  killed: '#f97316',
}

export const ACCENT = '#a855f7'
export const ADDED = '#22c55e'
export const REMOVED = '#ef4444'
export const MUTED = '#94a3b8'
/** Text drawn on a saturated chip background. */
export const ON_CHIP = '#0b1020'

/** A small stable palette for agent tags, picked by a hash of the id. */
const AGENT_TAGS = ['#f472b6', '#c084fc', '#60a5fa', '#34d399', '#fbbf24', '#fb7185', '#2dd4bf', '#a3e635']
export const agentHue = (id: string): string => {
  let n = 0
  for (let i = 0; i < id.length; i += 1) n = (n * 31 + id.charCodeAt(i)) >>> 0
  return AGENT_TAGS[n % AGENT_TAGS.length] ?? '#f472b6'
}

const SPINNER = ['◐', '◓', '◑', '◒']
export const statusGlyph = (status: CockpitStatus, now: number): string => {
  if (status === 'running') return SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? '◐'
  if (status === 'ok') return '✓'
  if (status === 'error') return '✗'
  return '⛔'
}

export const agentGlyph = (status: CockpitAgentStatus, now: number): string => {
  if (status === 'running') return SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? '◐'
  if (status === 'idle') return '◌'
  if (status === 'done') return '✓'
  if (status === 'failed') return '✗'
  return '■'
}

// ---------------------------------------------------------------- categories
const BROWSER_RE = /browser|chrome|computer|simulator|emulator|playwright|puppeteer|screenshot|android|ios_|xcode/i

export const categorize = (tool: string): CockpitCategory => {
  switch (tool) {
    case 'Bash':
    case 'Monitor':
    case 'TaskStop':
    case 'KillShell':
    case 'BashOutput':
      return 'shell'
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Read':
    case 'LSP':
    case 'ReadMcpResourceTool':
    case 'ReadMcpResourceDirTool':
    case 'ListMcpResourcesTool':
      return 'read'
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
    case 'SearchPlugins':
    case 'SearchSkills':
    case 'SearchMcpRegistry':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Agent':
    case 'Task':
    case 'Workflow':
    case 'SendMessage':
    case 'GetTask':
    case 'ListAgents':
    case 'FetchInboxMessage':
      return 'agent'
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
    case 'ScheduleWakeup':
      return 'task'
    case 'request_computer':
      return 'browser'
  }
  if (tool.startsWith('mcp__')) return BROWSER_RE.test(tool) ? 'browser' : 'mcp'
  return 'other'
}

/** Tools whose screenshots belong on the Screen tab. */
export const isScreenTool = (tool: string): boolean =>
  tool.startsWith('mcp__') ? BROWSER_RE.test(tool) : tool === 'request_computer'

// ---------------------------------------------------------------- text
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// eslint-disable-next-line no-control-regex
const HAS_CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/**
 * Text from a tool made safe to draw: the engine refuses a whole tree whose
 * text holds a control character (an ANSI colour, a BEL), so escape
 * sequences go, `\r\n` becomes `\n`, a carriage-return overwrite keeps what
 * was written last, and only tab and newline survive.
 */
export const clean = (text: string): string => {
  if (!HAS_CTRL_RE.test(text)) return text
  let out = text.replace(ANSI_RE, '').replace(/\r\n/g, '\n')
  if (out.includes('\r'))
    out = out
      .split('\n')
      .map(line => {
        const parts = line.split('\r')
        for (let i = parts.length - 1; i >= 0; i -= 1) if ((parts[i] ?? '') !== '') return parts[i] ?? ''
        return ''
      })
      .join('\n')
  return out.replace(CTRL_RE, '')
}

export const clip =(text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** Keeps the head and the tail of a long output, the middle elided. */
export const excerpt = (text: string, max: number): string => {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.3)
  const tail = max - head - 40
  const cut = text.length - head - tail
  return `${text.slice(0, head)}\n… ${cut} characters omitted …\n${text.slice(text.length - tail)}`
}

export const firstLine = (text: string): string => {
  const line = text.split('\n').find(one => one.trim() !== '') ?? ''
  return line.trim()
}

/** Pretty, capped JSON of a tool input (envelope keys dropped). */
export const prettyInput = (input: Record<string, unknown>): string => {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'tool' || key === 'tool_use_id' || key === 'agentId' || key === 'requestMeta') continue
    rest[key] = typeof value === 'string' ? clip(value, 600) : value
  }
  let text: string
  try {
    text = JSON.stringify(rest, null, 2) ?? '{}'
  } catch {
    text = '{}'
  }
  return clip(text, MAX_INPUT)
}

export const fmtDur = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}`
  const hours = Math.floor(m / 60)
  return `${hours}h${String(m % 60).padStart(2, '0')}`
}

export const fmtAgo = (at: number | undefined, now: number): string => {
  if (at === undefined || at === 0 || now === 0) return ''
  const ms = Math.max(0, now - at)
  if (ms < 5000) return 'now'
  return fmtDur(ms)
}

/** A file size: `812 B`, `14 KB`, `3.2 MB`. */
export const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export const fmtCount = (n: number): string =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** `1 call`, `2 calls`: the count (as `shown` when given) and its noun. */
export const plural = (n: number, noun: string, shown: string = String(n)): string =>
  `${shown} ${noun}${n === 1 ? '' : 's'}`

/** A path shown relative to the session's folder, the rest kept short. */
export const shortPath = (path: string, cwd: string, max: number): string => {
  let p = path
  if (cwd !== '' && p.startsWith(`${cwd}/`)) p = p.slice(cwd.length + 1)
  if (p.length <= max) return p
  const parts = p.split('/')
  const base = parts.pop() ?? p
  if (base.length >= max - 2) return clip(base, max)
  let out = base
  while (parts.length > 0) {
    const next = `${parts.pop()}/${out}`
    if (next.length + 2 > max) break
    out = next
  }
  return `…/${out}`
}

export const basename = (path: string): string => path.split('/').pop() ?? path
export const dirname = (path: string): string => {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
/** One block per bucket; an empty bucket is the baseline, so the strip reads as a chart. */
export const sparkText = (values: readonly number[]): string => {
  const max = Math.max(1, ...values)
  return values.map(v => (v === 0 ? '▁' : BLOCKS[1 + Math.min(6, Math.floor((v / max) * 6.999))] ?? '▂')).join('')
}

/** The spark buckets as of `now`, shifted so the last one is the current. */
export const sparkSeries = (stats: CockpitStats, now: number): number[] => {
  const bucket = Math.floor(now / SPARK_MS)
  const shift = Math.max(0, bucket - stats.sparkAt)
  const series = [...stats.spark, ...new Array<number>(Math.min(SPARK_LEN, shift)).fill(0)]
  const out = series.slice(-SPARK_LEN)
  while (out.length < SPARK_LEN) out.unshift(0)
  return out
}

export const TEST_RE =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test|npx\s+(jest|vitest|playwright)|jest|vitest|pytest|go\s+test|cargo\s+test|swift\s+test|xcodebuild\b[^\n]*\btest\b|gradlew?\s+\S*test|mvn\s+test|rspec|phpunit|mix\s+test|deno\s+test|claude\s+plugin\s+test|ctest|tox)\b/i
