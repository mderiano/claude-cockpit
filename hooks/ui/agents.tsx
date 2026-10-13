// Cockpit: subagents, teammates and workflow agents as a live tree.
import type { RenderElement } from 'claude-code'

import type { CockpitAgent, CockpitEvent, CockpitFeedRef, CockpitStats, CockpitWorkflow } from '../../types'
import {
  ACCENT,
  AGENT_COLOR,
  agentGlyph,
  agentHue,
  CAT_COLOR,
  CAT_LABEL,
  clip,
  fmtCount,
  fmtDur,
  statusGlyph,
  STATUS_COLOR,
} from '../model'
import { chip, empty, fit, setUi } from './kit'
import type { Kit } from './kit'

const elapsed = (k: Kit, a: CockpitAgent): string =>
  fmtDur((a.endedAt ?? (k.now > 0 ? k.now : a.startedAt)) - a.startedAt)

/** Below this width the type chip goes: the title is what tells agents apart. */
const TYPE_CHIP_MIN_W = 70
/** Finished loose agents shown before the « N terminés » expander. */
const FINISHED_SHOWN = 6

const shortType = (type: string): string => (type === 'general-purpose' ? 'gp' : clip(type, 14))

const agentRow = (k: Kit, a: CockpitAgent, depth: number, hideType?: string): RenderElement => {
  const { Button, Text } = k
  const isOpen = k.ui.agent === a.id
  const color = AGENT_COLOR[a.status]
  const indent = '  '.repeat(depth)
  const showType = k.W >= TYPE_CHIP_MIN_W && a.type !== hideType && a.type !== ''
  const type = showType ? shortType(a.type) : ''
  const time = elapsed(k, a)
  const tools = `⚒${a.tools}`
  const fixed = indent.length + 2 + (showType ? type.length + 3 : 0) + 1 + tools.length + 1 + time.length + 1
  const titleWidth = Math.max(8, k.W - fixed)
  const title = a.workflowIndex !== undefined ? `#${a.workflowIndex} ${a.name ?? a.description}` : (a.name ?? a.description)
  return (
    <Button key={`ag-${a.id}`} plain onPress={() => setUi(k, u => ({ ...u, agent: u.agent === a.id ? null : a.id }))}>
      <Text>{indent}</Text>
      <Text color={color} bold>
        {agentGlyph(a.status, k.now)}{' '}
      </Text>
      <Text bold={a.status === 'running' || isOpen} dimColor={a.status === 'done' && !isOpen}>
        {fit(title, titleWidth)}
      </Text>
      {showType ? <Text> </Text> : ''}
      {showType ? (
        <Text backgroundColor={agentHue(a.id)} color="#0b1020">
          {` ${type} `}
        </Text>
      ) : (
        ''
      )}
      <Text dimColor> {tools} </Text>
      <Text color={a.status === 'running' ? AGENT_COLOR.running : undefined} dimColor={a.status !== 'running'}>
        {time}
      </Text>
    </Button>
  )
}

const lastLine = (k: Kit, a: CockpitAgent, depth: number): RenderElement | null => {
  const { Text } = k
  if (a.lastTool === undefined) return null
  return (
    <Text key={`ag-last-${a.id}`} dimColor wrap="truncate-end">
      {'  '.repeat(depth + 1)}
      {'└ '}
      {a.lastTool}
      {a.lastTitle !== undefined ? ` · ${clip(a.lastTitle, Math.max(10, k.W - depth * 2 - a.lastTool.length - 8))}` : ''}
      {a.errors > 0 ? ` · ✗${a.errors}` : ''}
    </Text>
  )
}

/** The refs of an agent's own mini-feed, newest first. */
export const agentRefs = (id: string, refs: readonly CockpitFeedRef[]): CockpitFeedRef[] =>
  refs.filter(r => r.agent === id).slice(-8).reverse()

const agentDetail = (k: Kit, a: CockpitAgent, events: readonly CockpitEvent[]): RenderElement => {
  const { Box, Button, Text } = k
  const facts = [a.type, a.model, a.tokens !== undefined ? `${fmtCount(a.tokens)} tokens` : undefined, a.isBackground === true ? 'arrière-plan' : undefined]
    .filter((x): x is string => x !== undefined && x !== '')
    .join(' · ')
  return (
    <Box key={`ag-detail-${a.id}`} flexDirection="column" borderStyle="round" borderColor={agentHue(a.id)} paddingX={1} marginBottom={1}>
      <Text key="desc" bold>
        {a.description}
      </Text>
      <Text key="facts" dimColor>
        {facts}
      </Text>
      <Text key="id" dimColor>
        id {a.id}
      </Text>
      {events.length === 0 ? (
        <Text key="none" dimColor italic>
          Pas encore d’appel d’outil.
        </Text>
      ) : (
        <Box key="mini" flexDirection="column" marginTop={1}>
          {events.map(ev => (
            <Text key={`m-${ev.id}`} wrap="truncate-end">
              <Text color={STATUS_COLOR[ev.status]}>{statusGlyph(ev.status, k.now)} </Text>
              <Text color={CAT_COLOR[ev.cat]} bold>
                {fit(CAT_LABEL[ev.cat], 6)}
              </Text>
              <Text> {clip(ev.title, Math.max(10, k.W - 14))}</Text>
            </Text>
          ))}
        </Box>
      )}
      {a.answer !== undefined ? (
        <Box key="ans" flexDirection="column" marginTop={1}>
          <Text key="t" bold color={ACCENT}>
            Réponse
          </Text>
          <Text key="a" dimColor wrap="wrap">
            {a.answer}
          </Text>
        </Box>
      ) : null}
      <Box key="act" flexDirection="row" marginTop={1}>
        <Button key={`ag-filter-${a.id}`} label="Voir son feed" onPress={() => setUi(k, u => ({ ...u, tab: 'feed', filter: a.id, expanded: null }))} />
      </Box>
    </Box>
  )
}

const progress = (k: Kit, done: number, total: number, width: number): RenderElement => {
  const { Text } = k
  const cells = Math.max(4, width)
  const fill = total === 0 ? 0 : Math.round((done / total) * cells)
  return (
    <Text key="bar">
      <Text color={AGENT_COLOR.done}>{'█'.repeat(fill)}</Text>
      <Text dimColor>{'░'.repeat(cells - fill)}</Text>
      <Text dimColor>
        {' '}
        {done}/{total}
      </Text>
    </Text>
  )
}

const isActive = (a: CockpitAgent): boolean => a.status === 'running' || a.status === 'idle'
/** Running first, then waiting, then finished; newest first within each. */
const byLiveness = (x: CockpitAgent, y: CockpitAgent): number => {
  const rank = (a: CockpitAgent) => (a.status === 'running' ? 0 : a.status === 'idle' ? 1 : 2)
  return rank(x) - rank(y) || y.startedAt - x.startedAt
}

export const agentsView = (
  k: Kit,
  agents: readonly CockpitAgent[],
  workflows: readonly CockpitWorkflow[],
  refs: readonly CockpitFeedRef[],
  stats: CockpitStats,
  mini: readonly CockpitEvent[],
): RenderElement => {
  const { Box, Button, Text } = k
  const running = agents.filter(a => a.status === 'running').length
  const done = agents.filter(a => a.status === 'done' || a.status === 'idle').length
  const failed = agents.filter(a => a.status === 'failed' || a.status === 'killed').length
  const mainCalls = refs.filter(r => r.agent === undefined).length
  const openRuns = k.ui.openRuns ?? []

  const pushAgent = (out: RenderElement[], a: CockpitAgent, depth: number, hideType?: string) => {
    out.push(agentRow(k, a, depth, hideType))
    const last = a.status === 'running' ? lastLine(k, a, depth) : null
    if (last !== null) out.push(last)
    if (k.ui.agent === a.id) out.push(agentDetail(k, a, mini))
  }

  // Plain subagents and teammates, as a tree by parent: live branches first,
  // then the latest finished ones, the rest behind an expander.
  const loose = agents.filter(a => a.runId === undefined)
  const known = new Set(loose.map(a => a.id))
  const parentOf = (a: CockpitAgent): string | undefined =>
    a.parentId !== undefined && known.has(a.parentId) ? a.parentId : undefined
  const childrenOf = new Map<string | undefined, CockpitAgent[]>()
  for (const a of loose) {
    const p = parentOf(a)
    const list = childrenOf.get(p) ?? []
    list.push(a)
    childrenOf.set(p, list)
  }
  const liveTree = new Map<string, boolean>()
  const hasLive = (a: CockpitAgent, depth = 0): boolean => {
    const cached = liveTree.get(a.id)
    if (cached !== undefined) return cached
    const live = isActive(a) || (depth < 8 && (childrenOf.get(a.id) ?? []).some(c => hasLive(c, depth + 1)))
    liveTree.set(a.id, live)
    return live
  }
  const sortTree = (list: readonly CockpitAgent[]): CockpitAgent[] =>
    [...list].sort((x, y) => Number(hasLive(y)) - Number(hasLive(x)) || byLiveness(x, y))
  const looseRows: RenderElement[] = []
  const walk = (a: CockpitAgent, depth: number) => {
    pushAgent(looseRows, a, depth)
    if (depth < 6) for (const c of sortTree(childrenOf.get(a.id) ?? [])) walk(c, depth + 1)
  }
  const roots = sortTree(childrenOf.get(undefined) ?? [])
  const liveRoots = roots.filter(a => hasLive(a))
  const doneRoots = roots.filter(a => !hasLive(a))
  const showAll = k.ui.showAllAgents === true
  const shownDone = showAll ? doneRoots : doneRoots.slice(0, FINISHED_SHOWN)
  for (const a of [...liveRoots, ...shownDone]) walk(a, 1)
  const hidden = doneRoots.length - shownDone.length
  if (hidden > 0 || (showAll && doneRoots.length > FINISHED_SHOWN)) {
    looseRows.push(
      <Button key="ag-more" plain onPress={() => setUi(k, u => ({ ...u, showAllAgents: u.showAllAgents !== true }))}>
        <Text dimColor>{hidden > 0 ? `  ▸ ${hidden} terminés de plus` : '  ▾ masquer les plus anciens'}</Text>
      </Button>,
    )
  }

  // Workflow runs (ultracode): running runs first and unfolded, newest
  // first; a finished run is one line that unfolds on press.
  const runIds = [...new Set([...workflows.map(w => w.runId), ...agents.flatMap(a => (a.runId !== undefined ? [a.runId] : []))])]
  type Run = { runId: string; w?: CockpitWorkflow; members: CockpitAgent[]; live: number; startedAt: number }
  const runs: Run[] = runIds.map(runId => {
    const members = agents.filter(a => a.runId === runId)
    const w = workflows.find(one => one.runId === runId)
    const starts = members.map(a => a.startedAt)
    return {
      runId,
      w,
      members,
      live: members.filter(isActive).length,
      startedAt: w?.startedAt ?? (starts.length > 0 ? Math.min(...starts) : 0),
    }
  })
  runs.sort((x, y) => Number(y.live > 0) - Number(x.live > 0) || y.startedAt - x.startedAt)

  const runView = (run: Run): RenderElement => {
    const { runId, w, members, live } = run
    const sorted = [...members].sort(
      (x, y) => Number(isActive(y)) - Number(isActive(x)) || (x.workflowIndex ?? 0) - (y.workflowIndex ?? 0),
    )
    const finished = members.filter(a => !isActive(a)).length
    const fails = members.filter(a => a.status === 'failed' || a.status === 'killed').length
    const types = new Set(members.map(a => a.type))
    const commonType = types.size === 1 ? [...types][0] : undefined
    const name = w?.name ?? 'Workflow'
    const isOpen = live > 0 || openRuns.includes(runId)
    const ends = members.map(a => a.endedAt ?? (k.now > 0 ? k.now : a.startedAt))
    const span = members.length > 0 ? fmtDur(Math.max(...ends) - run.startedAt) : ''
    if (!isOpen) {
      return (
        <Button
          key={`wf-${runId}`}
          plain
          onPress={() => setUi(k, u => ({ ...u, openRuns: [...(u.openRuns ?? []).filter(id => id !== runId), runId].slice(-10) }))}
        >
          <Text wrap="truncate-end">
            <Text color={fails > 0 ? AGENT_COLOR.failed : AGENT_COLOR.done} bold>
              {fails > 0 ? '✗' : '✓'}{' '}
            </Text>
            <Text color={CAT_COLOR.agent}>⚙ {clip(name, Math.max(10, k.W - 26))}</Text>
            <Text dimColor>
              {' '}
              {finished}/{members.length}
              {fails > 0 ? ` · ${fails} ✗` : ''}
              {span !== '' ? ` · ${span}` : ''} ▸
            </Text>
          </Text>
        </Button>
      )
    }
    const rows: RenderElement[] = []
    for (const a of sorted) pushAgent(rows, a, 1, commonType)
    return (
      <Box key={`wf-${runId}`} flexDirection="column" marginTop={1}>
        <Box key="h" flexDirection="row" justifyContent="space-between">
          <Button
            key={`wf-h-${runId}`}
            plain
            onPress={() => setUi(k, u => ({ ...u, openRuns: (u.openRuns ?? []).filter(id => id !== runId) }))}
          >
            <Text wrap="truncate-end">
              <Text color={CAT_COLOR.agent} bold>
                ⚙ {clip(name, Math.max(10, k.W - 34))}
              </Text>
              {commonType !== undefined && commonType !== '' ? <Text dimColor> · {shortType(commonType)}</Text> : ''}
              {live === 0 ? <Text dimColor> ▾</Text> : ''}
            </Text>
          </Button>
          <Text color={live > 0 ? AGENT_COLOR.running : AGENT_COLOR.done}>{live > 0 ? `${live} en cours` : 'terminé'}</Text>
        </Box>
        {progress(k, finished, members.length, Math.min(24, Math.max(6, k.W - 16)))}
        {rows}
      </Box>
    )
  }
  const liveRuns = runs.filter(r => r.live > 0).map(runView)
  const doneRuns = runs.filter(r => r.live === 0).map(runView)

  if (agents.length === 0 && runIds.length === 0) {
    return (
      <Box key="agents" flexDirection="column">
        {mainRow(k, stats, mainCalls)}
        {empty(k, 'agents-empty', [
          'Pas encore de sous-agent 🤖',
          'Les agents (Agent), coéquipiers et agents de workflow ultracode apparaîtront ici avec leur activité.',
        ])}
      </Box>
    )
  }
  return (
    <Box key="agents" flexDirection="column">
      <Box key="sum" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {chip(k, 'a-run', `${running} en cours`, AGENT_COLOR.running)}
        {chip(k, 'a-done', `${done} finis`, AGENT_COLOR.done)}
        {failed > 0 ? chip(k, 'a-fail', `${failed} échoués`, AGENT_COLOR.failed) : null}
      </Box>
      {mainRow(k, stats, mainCalls)}
      {liveRuns}
      {looseRows}
      {doneRuns.length > 0 ? (
        <Box key="done-runs" flexDirection="column" marginTop={1}>
          {doneRuns}
        </Box>
      ) : null}
    </Box>
  )
}

const mainRow = (k: Kit, stats: CockpitStats, calls: number): RenderElement => {
  const { Text } = k
  return (
    <Text key="main" wrap="truncate-end">
      <Text color={stats.isWorking ? AGENT_COLOR.running : AGENT_COLOR.done} bold>
        {stats.isWorking ? agentGlyph('running', k.now) : '◆'}{' '}
      </Text>
      <Text bold>Session principale</Text>
      <Text dimColor>
        {' '}
        · {calls} appels · {stats.turns} tours
      </Text>
    </Text>
  )
}
