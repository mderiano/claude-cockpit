// Cockpit on the desktop: one live view, no tabs. On top what Claude does
// right now, drawn large (a terminal, an editor's diff, the screen, an
// agent at work); under it the history, small calls folded into runs.
import type { RenderElement } from 'claude-code'

import type { CockpitAgent, CockpitScreen, CockpitStats } from '../../types'
import type { LivePlan, Moment } from '../live'
import { trimDiff } from '../live'
import { headerSvg } from '../svg/header'
import { screenCardSvg } from '../svg/screen'
import { agentCardSvg, compactRunSvg, fileHeadSvg, nowCallSvg, sectionSvg, workflowCardSvg } from '../svg/stream'
import type { SvgOut } from '../svg/base'
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
  /** Rows of room, for the screen's height. */
  roomPx: number
}

/** Lines of diff shown for the change in view, and for one in the history. */
const NOW_DIFF_LINES = 40
const HISTORY_DIFF_LINES = 10
/** History file moments that keep their diff; older ones show their head. */
const HISTORY_DIFFS = 3

const svg = (k: Kit, key: string, out: SvgOut, alt: string, isInteractive = false): RenderElement => {
  const { Svg } = k
  if (Svg === undefined) return null as unknown as RenderElement
  return <Svg key={key} source={out.source} alt={alt} width={out.width} height={out.height} isInteractive={isInteractive ? true : undefined} />
}

const momentView = (k: Kit, d: LiveData, m: Moment, key: string, isNow: boolean, diffBudget: { left: number }): RenderElement | null => {
  const { Box, Code, Text } = k
  const w = d.px
  switch (m.kind) {
    case 'screen': {
      const card = screenCardSvg(w, d.screen, k.now, Math.min(560, Math.max(260, d.roomPx * 0.55)))
      if (card === undefined) return null
      return svg(k, key, card, `Screen: ${d.screen.label}`)
    }
    case 'call':
      return svg(k, key, nowCallSvg(w, m.ev, d.agents, k.now, appBadge(k, m.ev.app)), m.ev.title)
    case 'agent':
      return svg(k, key, agentCardSvg(w, m.agent, m.ev, d.agents, k.now), m.agent?.description ?? m.ev.title, true)
    case 'workflow':
      return svg(k, key, workflowCardSvg(w, m.wf, m.ev, m.agents, k.now), m.wf?.name ?? m.ev.title, true)
    case 'run':
      return svg(k, key, compactRunSvg(w, m.events, d.agents, k.now, ev => appBadge(k, ev.app)), `${m.events.length} calls`, true)
    case 'file': {
      const asset = m.change?.isBinary === true ? { size: m.change.size } : undefined
      const head = fileHeadSvg(w, m.ev, d.agents, k.cwd, k.now, m.isNew, appBadge(k, m.ev.app), asset)
      const showDiff = asset === undefined && m.change !== undefined && m.change.diff !== '' && (isNow || diffBudget.left > 0)
      if (!isNow && showDiff) diffBudget.left -= 1
      const cut = showDiff && m.change !== undefined ? trimDiff(m.change.diff, isNow ? NOW_DIFF_LINES : HISTORY_DIFF_LINES) : undefined
      return (
        <Box key={key} flexDirection="column">
          {svg(k, 'head', head, m.ev.filePath ?? m.ev.title)}
          {cut !== undefined ? <Code key="diff" source={cut.diff} format="diff" path={m.ev.filePath} wrap="truncate-end" /> : null}
          {cut !== undefined && cut.hidden > 0 ? (
            <Text key="more" dimColor>
              {`… ${cut.hidden} more lines`}
            </Text>
          ) : null}
          {m.change?.isTooLarge === true ? (
            <Text key="big" dimColor italic>
              File too large for a diff
            </Text>
          ) : null}
        </Box>
      )
    }
  }
}

export const liveView = (k: Kit, d: LiveData): RenderElement => {
  const { Box, Button, Text } = k
  const w = d.px
  const running = d.agents.filter(a => a.status === 'running').length
  const isBusy = d.stats.isWorking || d.stats.running > 0 || running > 0
  const budget = { left: HISTORY_DIFFS }
  const nowViews = d.plan.now.map((m, i) => momentView(k, d, m, `now-${i}`, true, budget)).filter(v => v !== null)
  const historyViews = d.plan.history.map((m, i) => momentView(k, d, m, `h-${i}`, false, budget)).filter(v => v !== null)
  return (
    <Box key="live" flexDirection="column" rowGap={1}>
      {svg(k, 'header', headerSvg(w, { stats: d.stats, agents: d.agents, files: d.files, series: d.series, now: k.now }), 'Cockpit summary')}
      {svg(k, 'sec-now', sectionSvg(w, 'NOW', isBusy ? 'working' : 'idle', isBusy), 'Now')}
      {nowViews.length > 0 ? (
        nowViews
      ) : (
        <Text key="idle" dimColor italic>
          Waiting for Claude — what it does shows up here as it happens.
        </Text>
      )}
      <Box key="screen-tools" flexDirection="row" columnGap={1}>
        <Button key="live" hotkey="l" variant={d.screen.isLive ? 'primary' : 'secondary'} label={d.screen.isLive ? 'Live screen: on' : 'Live screen: off'} onPress={() => k.act.toggleLive()} />
        <Button key="snap" hotkey="s" label="Capture screen" onPress={() => k.act.capture()} />
      </Box>
      {d.screen.error !== undefined ? (
        <Text key="screen-error" dimColor>
          {d.screen.error}
        </Text>
      ) : null}
      {historyViews.length > 0 ? svg(k, 'sec-history', sectionSvg(w, 'HISTORY', '', false), 'History') : null}
      {historyViews}
    </Box>
  )
}
