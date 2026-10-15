// Cockpit on the desktop: one live view, no tabs. On top what is happening
// right now, drawn large (a command's terminal, a file being edited, the
// screens, an agent at work), shown only while something happens; under it
// the history, small calls folded into runs. Every element is keyed by the
// ids it shows, so one drawing differs from the last only where something
// changed; the drawings are plain images, and whatever unfolds (a call's
// command and output, a run's rows, a whole diff) is a native button.
import type { CodeProps, RenderElement } from 'claude-code'

import type { CockpitAgent, CockpitChange, CockpitEvent, CockpitFrame, CockpitScreen, CockpitStats, CockpitStatus } from '../../types'
import type { LivePlan, Moment } from '../live'
import { fullCommand, isDeviceFrame, momentKey, toggleOpen, trimDiff } from '../live'
import { basename, clip, dirname, fmtAgoCoarse, fmtDur, shortPath } from '../model'
import { agentColor, PX_PER_CELL } from '../svg/base'
import type { SvgOut } from '../svg/base'
import { agentName } from '../svg/feed'
import { headerSvg } from '../svg/header'
import { frameCardSvg, frameColor, isPortrait, sourceDetail, sourceName } from '../svg/screen'
import { agentCardSvg, agentHeadSvg, COMPACT_ROWS, fileHeadSvg, nowCallSvg, runSummarySvg, sectionSvg, terminalHasMore, workflowCardSvg } from '../svg/stream'
import { appBadge } from './kit'
import type { Kit } from './kit'

export type LiveData = {
  plan: LivePlan
  stats: CockpitStats
  agents: readonly CockpitAgent[]
  files: number
  series: readonly number[]
  screen: CockpitScreen
  /** Body width in CSS pixels. */
  px: number
  /** The pane's height in CSS pixels, for the screens' height. */
  roomPx: number
}

/** Lines of diff for the newest changes of the history (then heads only), and a live agent's fresh one. */
const HISTORY_DIFF_LINES = [20, 10, 10] as const
const AGENT_DIFF_LINES = 20
/** Lines of a whole diff, unfolded. */
const FULL_DIFF_LINES = 600
/** Rows of a run, unfolded. */
const RUN_ROWS_MAX = 60
/** Characters all the Code of one drawing may hold together. */
const CODE_BUDGET = 90_000
/** Wide enough for two portrait screens side by side. */
const PAIR_MIN_PX = 440
/** Cells between two screens side by side. */
const PAIR_GAP = 2
/** A screen in the history is a smaller card. */
const HISTORY_FRAME_PX = 240

const GLYPH: Record<CockpitStatus, string> = { running: '◐', ok: '✓', error: '✗', denied: '⛔' }
const GLYPH_COLOR: Record<CockpitStatus, string> = { running: '#3b82f6', ok: '#22c55e', error: '#ef4444', denied: '#f97316' }
const STATUS_WORD: Record<CockpitStatus, string> = { running: 'running', ok: 'done', error: 'failed', denied: 'denied' }

/** What one drawing carries along: the kit, the data, what is unfolded, what Code may still hold. */
type Ctx = { k: Kit; d: LiveData; open: ReadonlySet<string>; code: { left: number } }
type FileMoment = { ev: CockpitEvent; change?: CockpitChange; isNew: boolean }

const took = (ev: CockpitEvent, now: number): string =>
  ev.status === 'running' ? fmtDur(Math.max(0, now - ev.startedAt)) : fmtDur((ev.endedAt ?? ev.startedAt) - ev.startedAt)

/** A drawing as an image: never interactive, so the surface never re-creates a frame for it. */
const svg = (k: Kit, key: string, out: SvgOut, alt: string): RenderElement | null => {
  const { Svg } = k
  if (Svg === undefined) return null
  return <Svg key={key} source={out.source} alt={alt} width={out.width} height={out.height} />
}

/**
 * A leaf in a Box of its own, keyed: a leaf (Svg, Text, Code) carries no key
 * of its own to the surface, a Box does, so this is what keeps its identity
 * from one drawing to the next whatever appears around it.
 */
const keyed = (k: Kit, key: string, child: RenderElement | null): RenderElement | null => {
  const { Box } = k
  if (child === null) return null
  return (
    <Box key={key} flexDirection="column">
      {child}
    </Box>
  )
}

/** A press that unfolds `key`, or folds it back. */
const toggle = (k: Kit, key: string) => (): void => k.act.setUi(u => ({ ...u, open: toggleOpen(u.open, key) }))

/** A Code within the drawing's budget; past it, a line saying so (a diff is never cut, it would not parse). */
const code = (c: Ctx, key: string, source: string, props: Omit<CodeProps, 'source'>): RenderElement | null => {
  const { Code, Text } = c.k
  if (source === '') return null
  if (source.length > c.code.left) {
    if (props.format === 'diff' || c.code.left < 200) {
      return (
        <Text key={key} dimColor italic>
          Too long to show with so much unfolded: fold something first.
        </Text>
      )
    }
    const cut = `${source.slice(0, c.code.left)}\n…`
    c.code.left = 0
    return <Code key={key} source={cut} {...props} />
  }
  c.code.left -= source.length
  return <Code key={key} source={source} {...props} />
}

// ---------------------------------------------------------------- a call
/** What a row says after its title: the command, the change, the target. */
const rowTarget = (ev: CockpitEvent, cwd: string): string => {
  if (ev.cat === 'shell' && ev.detail !== undefined) return ev.detail.replace(/^\$ /, '').replace(/ ⏎ /g, ' ; ')
  if (ev.cat === 'edit' && ev.filePath !== undefined) {
    const dir = dirname(ev.filePath)
    return `+${ev.added ?? 0} −${ev.removed ?? 0}  ${dir === '' || dir === cwd ? './' : `${shortPath(dir, cwd, 60)}/`}`
  }
  if (ev.detail === undefined || ev.detail === '' || ev.detail === ev.title) return ''
  return ev.detail.startsWith('/') ? shortPath(ev.detail, cwd, 80) : ev.detail
}

/**
 * One call as a line of text that unfolds: its state, what it did, how
 * (the command, the file), how long; a subagent's starts with its colour.
 */
const callRow = (c: Ctx, ev: CockpitEvent, withDetail: boolean): RenderElement[] => {
  const { Button, Text } = c.k
  const dur = took(ev, c.k.now)
  let title = ev.cat === 'edit' && ev.filePath !== undefined ? basename(ev.filePath) : ev.title
  let target = rowTarget(ev, c.k.cwd)
  // A command with no description: the command is its title.
  if (target !== '' && target.startsWith(title)) {
    title = target
    target = ''
  }
  const room = Math.max(12, c.k.W - (ev.agentId !== undefined ? 2 : 0) - 2 - 1 - dur.length - 3)
  const shownTitle = clip(title, target === '' ? room : Math.max(10, Math.min(title.length, Math.ceil(room * 0.5))))
  const left = room - shownTitle.length - 1
  const shownTarget = target !== '' && left >= 6 ? clip(target, left) : ''
  const key = `call:${ev.id}`
  const row = (
    <Button key={`row:${ev.id}`} plain onPress={toggle(c.k, key)}>
      {ev.agentId !== undefined ? <Text color={agentColor(ev.agentId)}>● </Text> : ''}
      <Text color={GLYPH_COLOR[ev.status]} bold>
        {`${GLYPH[ev.status]} `}
      </Text>
      <Text bold>{shownTitle}</Text>
      {shownTarget !== '' ? <Text dimColor>{` ${shownTarget}`}</Text> : ''}
      <Text dimColor>{` ${dur}`}</Text>
    </Button>
  )
  return withDetail && c.open.has(key) ? [row, callDetail(c, ev)] : [row]
}

/** A call unfolded: its facts, its whole command (or its input), its whole output. */
const callDetail = (c: Ctx, ev: CockpitEvent): RenderElement => {
  const { Box, Text } = c.k
  const facts: string[] = [ev.tool, STATUS_WORD[ev.status], took(ev, c.k.now)]
  if (ev.exitCode !== undefined) facts.push(`exit ${ev.exitCode}`)
  if (ev.agentId !== undefined) facts.push(agentName(c.d.agents, ev.agentId))
  const command = ev.tool === 'Bash' ? fullCommand(ev) : undefined
  const input = command === undefined && ev.input.trim() !== '' && ev.input.trim() !== '{}' ? ev.input : undefined
  const output = ev.output !== undefined && ev.output.trim() !== '' ? ev.output.trimEnd() : undefined
  return (
    <Box key={`detail:${ev.id}`} flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Text key="facts" dimColor>
        {facts.join(' · ')}
      </Text>
      {command !== undefined ? code(c, 'command', command, { language: 'bash', wrap: 'wrap' }) : null}
      {input !== undefined ? code(c, 'input', input, { language: 'json', wrap: 'wrap' }) : null}
      {output !== undefined ? (
        code(c, 'output', output, { wrap: 'wrap' })
      ) : ev.status === 'running' ? (
        <Text key="wait" dimColor italic>
          Still running…
        </Text>
      ) : null}
    </Box>
  )
}

/** A call drawn large (a command's terminal, any other call's card), with what it leaves out a press away. */
const callCard = (c: Ctx, ev: CockpitEvent, width: number, key = `call:${ev.id}`): RenderElement => {
  const { Box, Button } = c.k
  const openKey = `call:${ev.id}`
  const isOpen = c.open.has(openKey)
  const isShell = ev.cat === 'shell'
  const hasMore = isShell ? terminalHasMore(width, ev) : ev.output !== undefined && ev.output.trim() !== ''
  return (
    <Box key={key} flexDirection="column">
      {svg(c.k, 'card', nowCallSvg(width, ev, c.d.agents, c.k.now, appBadge(c.k, ev.app)), ev.title)}
      {hasMore || isOpen ? (
        <Button
          key={`cmd:${ev.id}`}
          plain
          dimColor
          label={isOpen ? 'Hide details' : isShell ? 'Show full command and output' : 'Show input and output'}
          onPress={toggle(c.k, openKey)}
        />
      ) : null}
      {isOpen ? callDetail(c, ev) : null}
    </Box>
  )
}

/** An Agent call's card; its prompt and answer a press away. */
const agentCard = (c: Ctx, ev: CockpitEvent, agent: CockpitAgent | undefined, key: string, width: number): RenderElement => {
  const { Box, Button } = c.k
  const openKey = `call:${ev.id}`
  const isOpen = c.open.has(openKey)
  const hasMore = ev.output !== undefined && ev.output.trim() !== ''
  return (
    <Box key={key} flexDirection="column">
      {svg(c.k, 'card', agentCardSvg(width, agent, ev, c.d.agents, c.k.now), agent?.description ?? ev.title)}
      {hasMore || isOpen ? (
        <Button key={`cmd:${ev.id}`} plain dimColor label={isOpen ? 'Hide details' : 'Show prompt and answer'} onPress={toggle(c.k, openKey)} />
      ) : null}
      {isOpen ? callDetail(c, ev) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- a file
const diffBodyLines = (diff: string): number =>
  (diff.endsWith('\n') ? diff.slice(0, -1) : diff).split('\n').filter(line => !line.startsWith('@@')).length

/** A file change: its head, its diff cut to `lines` (none: the head alone), the rest a press away. */
const fileView = (c: Ctx, m: FileMoment, key: string, width: number, lines: number): RenderElement => {
  const { Box, Button, Text } = c.k
  const ev = m.ev
  const asset = m.change?.isBinary === true ? { size: m.change.size } : undefined
  const head = fileHeadSvg(width, ev, c.d.agents, c.k.cwd, c.k.now, m.isNew, appBadge(c.k, ev.app), asset)
  const diff = asset === undefined && m.change !== undefined ? m.change.diff : ''
  const openKey = `diff:${ev.id}`
  const isOpen = c.open.has(openKey)
  const total = diff === '' ? 0 : diffBodyLines(diff)
  const cut = diff === '' ? undefined : isOpen ? trimDiff(diff, FULL_DIFF_LINES) : lines > 0 ? trimDiff(diff, lines) : undefined
  const hidden = cut !== undefined ? cut.hidden : total
  return (
    <Box key={key} flexDirection="column">
      {svg(c.k, 'head', head, ev.filePath ?? ev.title)}
      {cut !== undefined ? code(c, 'diff', cut.diff, { format: 'diff', path: ev.filePath, wrap: 'truncate-end' }) : null}
      {isOpen && hidden > 0 ? (
        <Text key="cut" dimColor italic>
          {`… ${hidden} more lines not shown`}
        </Text>
      ) : null}
      {!isOpen && hidden > 0 ? (
        <Button
          key={`diffmore:${ev.id}`}
          plain
          dimColor
          label={cut === undefined ? `Show diff · ${total} line${total === 1 ? '' : 's'}` : `Show ${hidden} more line${hidden === 1 ? '' : 's'}`}
          onPress={toggle(c.k, openKey)}
        />
      ) : null}
      {isOpen ? <Button key={`diffless:${ev.id}`} plain dimColor label="Show less" onPress={toggle(c.k, openKey)} /> : null}
      {m.change?.isTooLarge === true ? (
        <Text key="big" dimColor italic>
          File too large for a diff
        </Text>
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- runs and agents
/** A run of small calls: its summary drawn, its newest rows native, the rest a press away. */
const runView = (c: Ctx, events: readonly CockpitEvent[], key: string, width: number): RenderElement => {
  const { Box, Button } = c.k
  const oldest = events[events.length - 1]?.id ?? 'empty'
  const isOpen = c.open.has(key)
  const shown = events.slice(0, isOpen ? RUN_ROWS_MAX : COMPACT_ROWS)
  const hidden = events.length - shown.length
  return (
    <Box key={key} flexDirection="column">
      {svg(c.k, 'sum', runSummarySvg(width, events, c.k.now), `${events.length} call${events.length === 1 ? '' : 's'}`)}
      <Box key="rows" flexDirection="column" paddingLeft={1}>
        {shown.flatMap(ev => callRow(c, ev, true))}
        {!isOpen && hidden > 0 ? <Button key={`runmore:${oldest}`} plain dimColor label={`+ ${hidden} more`} onPress={toggle(c.k, key)} /> : null}
        {isOpen && events.length > COMPACT_ROWS ? <Button key={`runless:${oldest}`} plain dimColor label="Show less" onPress={toggle(c.k, key)} /> : null}
      </Box>
    </Box>
  )
}

/**
 * A subagent at work: the head of its card, its calls as rows (the running
 * one first), then the command it runs drawn large and the file it just
 * changed with its diff.
 */
const agentLiveView = (c: Ctx, m: Extract<Moment, { kind: 'agentLive' }>, key: string, width: number): RenderElement => {
  const { Box, Text } = c.k
  const rows = [...(m.current !== undefined ? [m.current] : []), ...m.recent]
  // Its running command unfolds under its terminal, not under its row.
  const term = m.current !== undefined && m.current.cat === 'shell' ? m.current : undefined
  return (
    <Box key={key} flexDirection="column">
      {svg(c.k, 'card', agentHeadSvg(width, m.agent, c.k.now), m.agent.name ?? m.agent.description)}
      <Box key="rows" flexDirection="column" paddingLeft={2}>
        {rows.length === 0 ? (
          <Text key="starting" dimColor italic>
            Starting…
          </Text>
        ) : (
          rows.flatMap(ev => callRow(c, ev, ev.id !== term?.id))
        )}
      </Box>
      {term !== undefined ? (
        <Box key="term" flexDirection="column" paddingLeft={2} marginTop={1}>
          {callCard(c, term, width - 16)}
        </Box>
      ) : null}
      {m.edit !== undefined ? (
        <Box key="edit" flexDirection="column" paddingLeft={2} marginTop={1}>
          {fileView(c, m.edit, `file:${m.edit.ev.id}`, width - 16, AGENT_DIFF_LINES)}
        </Box>
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- screens
/**
 * One screen: a native caption (where it comes from, Live or how old) over
 * its picture, whose source changes only when the frame does.
 */
const frameView = (c: Ctx, f: CockpitFrame, maxW: number, maxH: number, isNow: boolean, cells: number): RenderElement => {
  const { Box, Text } = c.k
  const key = `frame:${f.key}`
  const isLive = isNow && isDeviceFrame(f) && c.d.screen.isLive
  const isWatched = isNow && f.source === 'window' && c.d.screen.watch !== undefined && f.key === `window:${c.d.screen.watch}`
  const state = isLive ? 'Live' : isWatched ? 'Watching' : fmtAgoCoarse(f.at, c.k.now)
  // A device by its own name (iPhone 17 Pro, Android emulator-5554); anything else by its source, then what it shows.
  const name = isDeviceFrame(f) ? f.label : sourceName(f)
  const detail = isDeviceFrame(f) ? '' : sourceDetail(f)
  // The state always shows: what gives way is the detail, then the name.
  const room = cells - state.length - 6
  const shownName = clip(name, Math.max(8, room))
  const shownDetail = detail !== '' && room - shownName.length - 3 >= 6 ? clip(detail, room - shownName.length - 3) : ''
  const caption = [shownName, shownDetail, state].filter(one => one !== '').join(' · ')
  return (
    <Box key={key} flexDirection="column">
      <Text key="cap" dimColor wrap="truncate-end">
        <Text color={frameColor(f)}>● </Text>
        {caption}
      </Text>
      {svg(c.k, 'picture', frameCardSvg(f, maxW, maxH, isNow), `${name}${detail !== '' ? ` — ${detail}` : ''}`)}
    </Box>
  )
}

/** The screens under NOW, newest first: two portrait ones side by side where there is room. */
const nowFrames = (c: Ctx, frames: readonly CockpitFrame[], width: number): RenderElement[] => {
  const { Box } = c.k
  const maxH = Math.min(560, Math.max(260, c.d.roomPx * 0.55))
  const out: RenderElement[] = []
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]
    if (f === undefined) continue
    const g = frames[i + 1]
    if (width >= PAIR_MIN_PX && g !== undefined && isPortrait(f) && isPortrait(g)) {
      const half = Math.floor((width - PAIR_GAP * PX_PER_CELL) / 2)
      const cells = Math.floor((c.k.W - PAIR_GAP) / 2)
      out.push(
        <Box key={`frames:${f.key}+${g.key}`} flexDirection="row" columnGap={PAIR_GAP}>
          {frameView(c, f, half, maxH, true, cells)}
          {frameView(c, g, half, maxH, true, cells)}
        </Box>,
      )
      i += 1
    } else out.push(frameView(c, f, width, maxH, true, c.k.W))
  }
  return out
}

// ---------------------------------------------------------------- the view
const momentView = (c: Ctx, m: Moment, key: string, diffLines: () => number): RenderElement | null => {
  const { Text } = c.k
  const w = c.d.px
  switch (m.kind) {
    case 'frame':
      return frameView(c, m.frame, w, HISTORY_FRAME_PX, false, c.k.W)
    case 'liveWait':
      return keyed(
        c.k,
        key,
        <Text key="wait" dimColor italic>
          Live screen — waiting for a simulator or emulator…
        </Text>,
      )
    case 'call':
      return callCard(c, m.ev, w, key)
    case 'agent':
      return agentCard(c, m.ev, m.agent, key, w)
    case 'agentLive':
      return agentLiveView(c, m, key, w)
    case 'workflow':
      return keyed(c.k, key, svg(c.k, 'card', workflowCardSvg(w, m.wf, m.ev, m.agents, c.k.now), m.wf?.name ?? m.ev?.title ?? 'Workflow'))
    case 'run':
      return runView(c, m.events, key, w)
    case 'file': {
      const hasDiff = m.change !== undefined && m.change.isBinary !== true && m.change.diff !== ''
      return fileView(c, m, key, w, hasDiff ? diffLines() : 0)
    }
  }
}

export const liveView = (k: Kit, d: LiveData): RenderElement => {
  const { Box, Button, Text } = k
  const w = d.px
  const c: Ctx = { k, d, open: new Set(k.ui.open ?? []), code: { left: CODE_BUDGET } }
  // Keys come from ids; a clash (never expected) still gets a key of its own.
  const seen = new Set<string>()
  const keyOf = (m: Moment): string => {
    let key = momentKey(m)
    while (seen.has(key)) key = `${key}~`
    seen.add(key)
    return key
  }
  const nowViews: RenderElement[] = []
  let frames: CockpitFrame[] = []
  const flushFrames = () => {
    if (frames.length > 0) nowViews.push(...nowFrames(c, frames, w))
    frames = []
  }
  for (const m of d.plan.now) {
    if (m.kind === 'frame') {
      seen.add(momentKey(m))
      frames.push(m.frame)
      continue
    }
    flushFrames()
    const view = momentView(c, m, keyOf(m), () => 0)
    if (view !== null) nowViews.push(view)
  }
  flushFrames()
  // The newest change of the history shows 20 lines of its diff, the next two 10, the rest their head.
  const budget: number[] = [...HISTORY_DIFF_LINES]
  const historyViews: RenderElement[] = []
  for (const m of d.plan.history) {
    const view = momentView(c, m, keyOf(m), () => budget.shift() ?? 0)
    if (view !== null) historyViews.push(view)
  }
  return (
    <Box key="live-view" flexDirection="column" rowGap={1}>
      {keyed(k, 'header', svg(k, 'summary', headerSvg(w, { stats: d.stats, agents: d.agents, files: d.files, series: d.series, now: k.now }), 'Cockpit summary'))}
      <Box key="screen-tools" flexDirection="row" columnGap={1}>
        <Button
          key="live"
          hotkey="l"
          variant={d.screen.isLive ? 'primary' : 'secondary'}
          label={d.screen.isLive ? 'Live screen: on' : 'Live screen: off'}
          onPress={() => k.act.toggleLive()}
        />
        <Button key="snap" hotkey="s" label="Capture screen" onPress={() => k.act.capture()} />
      </Box>
      {d.screen.error !== undefined
        ? keyed(
            k,
            'screen-error',
            <Text key="error" dimColor>
              {d.screen.error}
            </Text>,
          )
        : null}
      {nowViews.length > 0 ? keyed(k, 'sec-now', svg(k, 'label', sectionSvg(w, 'NOW', '', true), 'Now')) : null}
      {nowViews}
      {historyViews.length > 0 ? keyed(k, 'sec-history', svg(k, 'label', sectionSvg(w, 'HISTORY', '', false), 'History')) : null}
      {historyViews}
      {nowViews.length === 0 && historyViews.length === 0
        ? keyed(
            k,
            'empty',
            <Text key="idle" dimColor italic>
              Waiting for Claude — what it does shows up here as it happens.
            </Text>,
          )
        : null}
    </Box>
  )
}
