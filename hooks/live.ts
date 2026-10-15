// Cockpit's live plan: from the newest calls, what is happening right now
// (drawn large, as if watching over Claude's shoulder) and what folds into the
// history below. Pure: the render hook reads the state, this decides, the
// views draw.
import type { CockpitAgent, CockpitChange, CockpitEvent, CockpitFrame, CockpitWorkflow } from '../types'
import { clean } from './model'

export type Moment =
  /** A screen: large under NOW, a smaller card in the history. */
  | { kind: 'frame'; frame: CockpitFrame }
  /** Live screen is on and no simulator or emulator answers yet. */
  | { kind: 'liveWait' }
  | { kind: 'call'; ev: CockpitEvent }
  | { kind: 'file'; ev: CockpitEvent; change?: CockpitChange; isNew: boolean }
  | { kind: 'agent'; ev: CockpitEvent; agent?: CockpitAgent }
  /** A workflow run; `ev` is its Workflow call, when it is among the newest calls. */
  | { kind: 'workflow'; ev?: CockpitEvent; wf?: CockpitWorkflow; agents: CockpitAgent[] }
  | {
      kind: 'agentLive'
      agent: CockpitAgent
      /** The call it runs now: its row first, and large under its card. */
      current?: CockpitEvent
      /** Its latest calls, newest first, as rows under its card. */
      recent: CockpitEvent[]
      /** The file it just changed, with its diff. */
      edit?: { ev: CockpitEvent; change?: CockpitChange; isNew: boolean }
    }
  | { kind: 'run'; events: CockpitEvent[] }

export type LivePlan = { now: Moment[]; history: Moment[] }

export type LiveInput = {
  /** Newest first. */
  events: readonly CockpitEvent[]
  agents: readonly CockpitAgent[]
  workflows: readonly CockpitWorkflow[]
  /** The frames kept, newest first. */
  frames: readonly CockpitFrame[]
  /** The change each edit made, by event id. */
  changes: ReadonlyMap<string, CockpitChange>
  now: number
  /** Live screen is on: the simulators' and emulators' frames are now. */
  isLive: boolean
  /** The app whose window is watched (`/cockpit watch`). */
  watch?: string
  /** Claude's turn is still at work. */
  isWorking: boolean
}

/** A frame a call made stays now this long while Claude's turn works. */
export const FRAME_FRESH_MS = 60_000
/** A subagent's edit is shown large under its card this long after it landed. */
export const EDIT_FRESH_MS = 20_000
/** History keeps this many moments. */
export const HISTORY_MOMENTS = 14
/** Rows of recent activity under a live agent's card. */
export const AGENT_RECENT = 5
/** Agents shown live at once: loose ones, and per workflow run. */
export const LIVE_AGENTS = 3
export const LIVE_AGENTS_PER_RUN = 2
/** Frames kept at once. */
export const MAX_FRAMES = 6
/** Things the person can keep unfolded at once. */
export const MAX_OPEN = 40

const isAgentTool = (ev: CockpitEvent): boolean => ev.tool === 'Agent' || ev.tool === 'Task'
const isWorkflowTool = (ev: CockpitEvent): boolean => ev.tool === 'Workflow'
const isEdit = (ev: CockpitEvent): boolean => ev.cat === 'edit' && ev.filePath !== undefined
const isRunning = (a: CockpitAgent): boolean => a.status === 'running'
export const isDeviceFrame = (f: CockpitFrame): boolean => f.source === 'ios' || f.source === 'android'

/**
 * Whether a frame is what is happening now: a simulator or emulator while
 * Live is on, the watched window, a frame a call made while that call runs
 * or while Claude's turn works and the frame is fresh, a capture the person
 * asked for while it is fresh.
 */
export const isFrameNow = (f: CockpitFrame, d: Pick<LiveInput, 'events' | 'now' | 'isLive' | 'watch' | 'isWorking'>): boolean => {
  if (isDeviceFrame(f) && d.isLive) return true
  if (f.source === 'window' && d.watch !== undefined && f.key === `window:${d.watch}`) return true
  const isFresh = d.now - f.at < FRAME_FRESH_MS
  if (f.eventId !== undefined) {
    if (d.events.some(ev => ev.id === f.eventId && ev.status === 'running')) return true
    return d.isWorking && isFresh
  }
  return f.isManual === true && isFresh
}

const momentOf = (ev: CockpitEvent, d: LiveInput): Moment => {
  if (isEdit(ev)) {
    const change = d.changes.get(ev.id)
    const isNew = ev.tool === 'Write' && (ev.removed ?? 0) === 0 && change !== undefined && !change.diff.includes('\n ')
    return { kind: 'file', ev, change, isNew }
  }
  if (isWorkflowTool(ev)) {
    const wf = d.workflows.find(w => w.toolUseId === ev.id)
    return { kind: 'workflow', ev, wf, agents: wf !== undefined ? d.agents.filter(a => a.runId === wf.runId) : [] }
  }
  if (isAgentTool(ev)) return { kind: 'agent', ev, agent: d.agents.find(a => a.toolUseId === ev.id) }
  return { kind: 'call', ev }
}

/** A running agent, live: its current call, its latest ones, its fresh edit. */
const agentLive = (agent: CockpitAgent, d: LiveInput, used: Set<string>): Moment => {
  const own = d.events.filter(ev => ev.agentId === agent.id)
  const current = own.find(ev => ev.status === 'running')
  const edit = own.find(ev => isEdit(ev) && ev.status !== 'running' && d.now - (ev.endedAt ?? ev.startedAt) < EDIT_FRESH_MS)
  const recent = own.filter(ev => ev.id !== current?.id).slice(0, AGENT_RECENT)
  for (const ev of [current, edit, ...recent]) if (ev !== undefined) used.add(ev.id)
  const m = edit !== undefined ? momentOf(edit, d) : undefined
  return {
    kind: 'agentLive',
    agent,
    current,
    recent,
    edit: m !== undefined && m.kind === 'file' ? { ev: m.ev, change: m.change, isNew: m.isNew } : undefined,
  }
}

const byActivity = (a: CockpitAgent, b: CockpitAgent): number => (b.lastAt ?? b.startedAt) - (a.lastAt ?? a.startedAt)

/** Calls that make a moment of their own; the rest fold into runs. */
const isMajor = (ev: CockpitEvent): boolean => isEdit(ev) || isAgentTool(ev) || isWorkflowTool(ev)

/**
 * NOW is only what is happening: the screens in view, the subagents and
 * workflow runs at work, the main loop's running calls. Whatever ended goes
 * straight to the top of the history, where the main loop's last command
 * keeps its terminal and an edit its diff; small calls fold into runs.
 */
export const planLive = (d: LiveInput): LivePlan => {
  const now: Moment[] = []
  const used = new Set<string>()
  const main = d.events.filter(ev => ev.agentId === undefined)

  // The screens first, newest first.
  const nowFrames = d.frames.filter(f => isFrameNow(f, d))
  for (const frame of nowFrames) now.push({ kind: 'frame', frame })
  if (d.isLive && !d.frames.some(isDeviceFrame)) now.push({ kind: 'liveWait' })

  // Subagents at work, live: what each runs now and just did (a background
  // agent runs on after its Agent call returned, so this goes by the agent).
  const looseLive = d.agents.filter(a => isRunning(a) && a.runId === undefined).sort(byActivity)
  for (const a of looseLive.slice(0, LIVE_AGENTS)) {
    now.push(agentLive(a, d, used))
    if (a.toolUseId !== undefined) used.add(a.toolUseId)
  }
  // Workflow runs at work, newest first: the run's card, then its busiest agents live.
  for (const wf of [...d.workflows].reverse()) {
    const agents = d.agents.filter(a => a.runId === wf.runId)
    const ev = wf.toolUseId !== undefined ? d.events.find(one => one.id === wf.toolUseId) : undefined
    if (!agents.some(isRunning) && ev?.status !== 'running') continue
    now.push({ kind: 'workflow', ev, wf, agents })
    if (ev !== undefined) used.add(ev.id)
    for (const a of agents.filter(isRunning).sort(byActivity).slice(0, LIVE_AGENTS_PER_RUN)) now.push(agentLive(a, d, used))
  }
  // A Workflow or Agent call still running whose run or agent is not live yet: its card.
  for (const ev of main) {
    if (ev.status !== 'running' || used.has(ev.id) || !(isWorkflowTool(ev) || isAgentTool(ev))) continue
    now.push(momentOf(ev, d))
    used.add(ev.id)
  }
  // The main loop's other running calls: a terminal, a card, a file being edited.
  for (const ev of main) {
    if (ev.status !== 'running' || used.has(ev.id)) continue
    now.push(momentOf(ev, d))
    used.add(ev.id)
  }

  // History: everything else, newest first. A frame no longer now sits at
  // the place of the call that made it; small calls fold into runs.
  const nowKeys = new Set(nowFrames.map(f => f.key))
  const shotsOf = new Map<string, CockpitFrame[]>()
  for (const f of d.frames) {
    if (nowKeys.has(f.key) || f.eventId === undefined) continue
    shotsOf.set(f.eventId, [...(shotsOf.get(f.eventId) ?? []), f])
  }
  // The main loop's last command keeps its terminal: its output stays legible.
  const lastCommand = main.find(ev => ev.tool === 'Bash' && ev.cat === 'shell' && ev.status !== 'running' && !used.has(ev.id))
  const history: Moment[] = []
  let run: CockpitEvent[] = []
  const flush = () => {
    if (run.length > 0) history.push({ kind: 'run', events: run })
    run = []
  }
  for (const ev of d.events) {
    if (used.has(ev.id)) continue
    if (history.length >= HISTORY_MOMENTS) break
    const shots = shotsOf.get(ev.id)
    if (shots !== undefined) {
      flush()
      for (const frame of shots) history.push({ kind: 'frame', frame })
    }
    if (isMajor(ev) || ev.id === lastCommand?.id) {
      flush()
      history.push(momentOf(ev, d))
    } else run.push(ev)
  }
  flush()
  return { now, history: history.slice(0, HISTORY_MOMENTS) }
}

/**
 * A moment's key, from ids alone so a moment keeps it from one drawing to
 * the next: a run is named by its oldest call, since a run grows at its
 * newest end.
 */
export const momentKey = (m: Moment): string => {
  switch (m.kind) {
    case 'frame':
      return `frame:${m.frame.key}`
    case 'liveWait':
      return 'live-wait'
    case 'call':
      return `call:${m.ev.id}`
    case 'file':
      return `file:${m.ev.id}`
    case 'agent':
      return `agent:${m.agent?.id ?? m.ev.id}`
    case 'agentLive':
      return `agent:${m.agent.id}`
    case 'workflow':
      return `wf:${m.wf?.runId ?? m.ev?.id ?? 'run'}`
    case 'run':
      return `run:${m.events[m.events.length - 1]?.id ?? 'empty'}`
  }
}

/** The open keys with `key` folded or unfolded; the oldest go past MAX_OPEN. */
export const toggleOpen = (open: readonly string[] | undefined, key: string): string[] => {
  const list = open ?? []
  return list.includes(key) ? list.filter(one => one !== key) : [...list, key].slice(-MAX_OPEN)
}

/**
 * The frame keys with `key` first when it is new (a known key keeps its
 * place, so a frame updating in place does not jump); past `max`, the oldest
 * key `isKept` does not hold goes, else the oldest.
 */
export const addFrameKey = (
  keys: readonly string[],
  key: string,
  isKept: (key: string) => boolean = () => false,
  max = MAX_FRAMES,
): { keys: string[]; evicted: string[] } => {
  if (keys.includes(key)) return { keys: [...keys], evicted: [] }
  const next = [key, ...keys]
  const evicted: string[] = []
  while (next.length > Math.max(1, max)) {
    let at = next.length - 1
    for (let i = next.length - 1; i > 0; i -= 1) {
      if (!isKept(next[i] ?? '')) {
        at = i
        break
      }
    }
    evicted.push(...next.splice(at, 1))
  }
  return { keys: next, evicted }
}

/** A Bash call's whole command, as kept in its input; else as its row says it. */
export const fullCommand = (ev: CockpitEvent): string => {
  try {
    const input = JSON.parse(ev.input) as { command?: unknown }
    if (typeof input.command === 'string' && input.command.trim() !== '') return clean(input.command)
  } catch {
    // an input cut short is no JSON: the row's own words
  }
  return (ev.detail ?? ev.title).replace(/^\$ /, '').replace(/ ⏎ /g, '\n')
}

/**
 * The first `maxLines` lines of a unified diff, still a valid one: whole
 * hunks while they fit, then the next hunk cut with its header recounted.
 */
export const trimDiff = (diff: string, maxLines: number): { diff: string; hidden: number } => {
  // The diff's closing newline ends its last line; it is no line of its own.
  const lines = (diff.endsWith('\n') ? diff.slice(0, -1) : diff).split('\n')
  if (lines.length <= maxLines) return { diff, hidden: 0 }
  const out: string[] = []
  let i = 0
  while (i < lines.length && out.length < maxLines) {
    const head = lines[i] ?? ''
    if (!head.startsWith('@@')) {
      // File headers and anything before the first hunk pass through.
      out.push(head)
      i += 1
      continue
    }
    let j = i + 1
    while (j < lines.length && !(lines[j] ?? '').startsWith('@@')) j += 1
    const body = lines.slice(i + 1, j)
    if (out.length + 1 + body.length <= maxLines) {
      out.push(head, ...body)
      i = j
      continue
    }
    // No room for a header and a line: stop at the whole hunks (unless none).
    const room = maxLines - out.length - 1
    if (room < 1 && out.some(l => l.startsWith('@@'))) break
    const cut = body.slice(0, Math.max(1, room))
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(head)
    if (m !== null) {
      const oldN = cut.filter(l => !l.startsWith('+')).length
      const newN = cut.filter(l => !l.startsWith('-')).length
      out.push(`@@ -${m[1]},${oldN} +${m[2]},${newN} @@${m[3] ?? ''}`, ...cut)
    }
    break
  }
  const shownBody = out.filter(l => !l.startsWith('@@')).length
  const totalBody = lines.filter(l => !l.startsWith('@@')).length
  return { diff: `${out.join('\n')}\n`, hidden: Math.max(0, totalBody - shownBody) }
}
