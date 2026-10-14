// Cockpit's live plan: from the newest calls, what shows large as "now" (as
// if watching over Claude's shoulder) and what folds into the history below.
// Pure: the render hook reads the state, this decides, the views draw.
import type { CockpitAgent, CockpitChange, CockpitEvent, CockpitScreen, CockpitWorkflow } from '../types'

export type Moment =
  | { kind: 'screen' }
  | { kind: 'call'; ev: CockpitEvent }
  | { kind: 'file'; ev: CockpitEvent; change?: CockpitChange; isNew: boolean }
  | { kind: 'agent'; ev: CockpitEvent; agent?: CockpitAgent }
  | { kind: 'workflow'; ev: CockpitEvent; wf?: CockpitWorkflow; agents: CockpitAgent[] }
  | {
      kind: 'agentLive'
      agent: CockpitAgent
      /** The call it runs now, drawn large under its card. */
      current?: CockpitEvent
      /** Its latest calls, newest first, as lines in its card. */
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
  screen: CockpitScreen
  /** The change each edit made, by event id. */
  changes: ReadonlyMap<string, CockpitChange>
  now: number
}

/** A screen frame stays "now" this long after the last screen action. */
export const SCREEN_FRESH_MS = 90_000
/** A subagent's edit is shown large this long after it landed. */
export const EDIT_FRESH_MS = 20_000
/** History keeps this many moments. */
export const HISTORY_MOMENTS = 14
/** Lines of recent activity in a live agent's card. */
export const AGENT_RECENT = 5
/** Agents shown live at once: loose ones, and per workflow run. */
export const LIVE_AGENTS = 3
export const LIVE_AGENTS_PER_RUN = 2

const isAgentTool = (ev: CockpitEvent): boolean => ev.tool === 'Agent' || ev.tool === 'Task'
const isWorkflowTool = (ev: CockpitEvent): boolean => ev.tool === 'Workflow'

const momentOf = (ev: CockpitEvent, d: LiveInput): Moment => {
  if (ev.cat === 'edit' && ev.filePath !== undefined) {
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
  const edit = own.find(ev => ev.cat === 'edit' && ev.filePath !== undefined && d.now - (ev.endedAt ?? ev.startedAt) < EDIT_FRESH_MS)
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
const isMajor = (ev: CockpitEvent): boolean =>
  (ev.cat === 'edit' && ev.filePath !== undefined) || isAgentTool(ev) || isWorkflowTool(ev)

export const planLive = (d: LiveInput): LivePlan => {
  const now: Moment[] = []
  const used = new Set<string>()
  const main = d.events.filter(ev => ev.agentId === undefined)

  // The screen, while it is what Claude is working on.
  const lastScreen = d.events.find(ev => ev.cat === 'browser')
  const recentMain = main.slice(0, 6)
  // A device or window frame comes from a capture the person asked for, Live
  // or a watch: fresh, it is what they want to see.
  const isCapture = d.screen.source === 'ios' || d.screen.source === 'android' || d.screen.source === 'window'
  const isFreshCapture = isCapture && d.screen.at !== undefined && d.now - d.screen.at < SCREEN_FRESH_MS
  const isRecent = (ev: CockpitEvent): boolean =>
    ev.status === 'running' || d.now - (ev.endedAt ?? ev.startedAt) < SCREEN_FRESH_MS
  // The call that produced the frame (an image in its result, a file it
  // wrote, the app it drove), while it is among the newest calls.
  const tied = d.screen.eventId !== undefined ? d.events.slice(0, 8).find(ev => ev.id === d.screen.eventId) : undefined
  const isTiedNow = tied !== undefined && isRecent(tied) && (tied.agentId !== undefined || recentMain.some(ev => ev.id === tied.id))
  const isScreenActionNow =
    lastScreen !== undefined && (lastScreen.status === 'running' || (isRecent(lastScreen) && recentMain.some(ev => ev.id === lastScreen.id)))
  const screenIsNow = d.screen.b64 !== undefined && (d.screen.isLive || isFreshCapture || isTiedNow || isScreenActionNow)
  if (screenIsNow) {
    now.push({ kind: 'screen' })
    if (lastScreen !== undefined) used.add(lastScreen.id)
    // The frame is what that call did; a command keeps its terminal too.
    if (isTiedNow && tied !== undefined && tied.cat !== 'shell') used.add(tied.id)
  }

  // Subagents at work, live: what each runs now and just did (a background
  // agent runs on after its Agent call returned, so this goes by the agent).
  const looseLive = d.agents.filter(a => a.status === 'running' && a.runId === undefined).sort(byActivity)
  for (const a of looseLive.slice(0, LIVE_AGENTS)) {
    now.push(agentLive(a, d, used))
    if (a.toolUseId !== undefined) used.add(a.toolUseId)
  }
  // Workflow runs at work: the run's card, then its busiest agents live.
  for (const ev of main) {
    if (ev.status !== 'running' || !isWorkflowTool(ev)) continue
    const m = momentOf(ev, d)
    now.push(m)
    used.add(ev.id)
    if (m.kind !== 'workflow') continue
    for (const a of m.agents.filter(one => one.status === 'running').sort(byActivity).slice(0, LIVE_AGENTS_PER_RUN))
      now.push(agentLive(a, d, used))
  }
  // An Agent call whose agent is not known yet (just spawned): its card.
  for (const ev of main) {
    if (ev.status !== 'running' || !isAgentTool(ev) || used.has(ev.id)) continue
    now.push(momentOf(ev, d))
    used.add(ev.id)
  }
  // The main loop's other running calls.
  const runningMain = main.filter(ev => ev.status === 'running' && !used.has(ev.id))
  for (const ev of runningMain) {
    if (ev.cat === 'browser' && screenIsNow) {
      used.add(ev.id)
      continue
    }
    now.push(momentOf(ev, d))
    used.add(ev.id)
  }
  // Nothing of the main loop runs: what it just did stays in view.
  if (runningMain.length === 0) {
    const last = main.find(ev => !used.has(ev.id))
    if (last !== undefined && !(last.cat === 'browser' && screenIsNow)) {
      now.push(momentOf(last, d))
      used.add(last.id)
    }
  }
  // A fresh edit anywhere (a subagent's too) is always seen.
  const freshEdit = d.events.find(
    ev => ev.cat === 'edit' && ev.filePath !== undefined && !used.has(ev.id) && d.now - (ev.endedAt ?? ev.startedAt) < EDIT_FRESH_MS,
  )
  if (freshEdit !== undefined && !now.some(m => m.kind === 'file')) {
    now.push(momentOf(freshEdit, d))
    used.add(freshEdit.id)
  }

  // History: everything else, newest first, small calls folded into runs.
  const history: Moment[] = []
  let run: CockpitEvent[] = []
  const flush = () => {
    if (run.length > 0) history.push({ kind: 'run', events: run })
    run = []
  }
  for (const ev of d.events) {
    if (used.has(ev.id)) continue
    if (history.length >= HISTORY_MOMENTS) break
    if (isMajor(ev)) {
      flush()
      history.push(momentOf(ev, d))
    } else run.push(ev)
  }
  flush()
  return { now, history: history.slice(0, HISTORY_MOMENTS) }
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
