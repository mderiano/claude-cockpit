// Cockpit: the live feed of tool calls, newest first.
import type { RenderElement } from 'claude-code'

import type { CockpitAgent, CockpitChange, CockpitEvent, CockpitFeedRef } from '../../types'
import {
  ADDED,
  agentHue,
  CAT_COLOR,
  CAT_LABEL,
  clip,
  fmtDur,
  REMOVED,
  shortPath,
  statusGlyph,
  STATUS_COLOR,
} from '../model'
import { chip, empty, fit, setUi } from './kit'
import type { Kit } from './kit'

export const agentLabel = (agents: readonly CockpitAgent[], id: string): string => {
  const a = agents.find(one => one.id === id)
  if (a === undefined) return id.slice(0, 6)
  const base = a.name ?? a.description
  return a.workflowIndex !== undefined ? `#${a.workflowIndex} ${base}` : base
}

const filterRow = (k: Kit, refs: readonly CockpitFeedRef[], agents: readonly CockpitAgent[]): RenderElement => {
  const { Box, Button, Text } = k
  const recent: string[] = []
  for (let i = refs.length - 1; i >= 0 && recent.length < 4; i -= 1) {
    const id = refs[i]?.agent
    if (id !== undefined && !recent.includes(id)) recent.push(id)
  }
  if (k.ui.filter !== 'all' && k.ui.filter !== 'main' && !recent.includes(k.ui.filter)) recent.unshift(k.ui.filter)
  const option = (key: string, value: string, label: string, color?: string) => {
    const isOn = k.ui.filter === value
    return (
      <Button key={key} plain onPress={() => setUi(k, u => ({ ...u, filter: value, expanded: null }))}>
        <Text color={isOn ? (color ?? '#e2e8f0') : undefined} bold={isOn} dimColor={!isOn} underline={isOn}>
          {isOn ? '◉ ' : '○ '}
          {label}
        </Text>
      </Button>
    )
  }
  return (
    <Box key="filters" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
      {option('f-all', 'all', 'All')}
      {option('f-main', 'main', 'Session')}
      {recent.map(id => option(`f-${id}`, id, clip(agentLabel(agents, id), 18), agentHue(id)))}
    </Box>
  )
}

const duration = (k: Kit, ev: CockpitEvent): string =>
  ev.status === 'running' ? fmtDur(Math.max(0, k.now - ev.startedAt)) : fmtDur((ev.endedAt ?? ev.startedAt) - ev.startedAt)

const row = (k: Kit, ev: CockpitEvent, agents: readonly CockpitAgent[], showAgent: boolean): RenderElement => {
  const { Box, Button, Text } = k
  const color = CAT_COLOR[ev.cat]
  const dur = duration(k, ev)
  const tag = showAgent && ev.agentId !== undefined ? clip(agentLabel(agents, ev.agentId), 14) : ''
  const label = CAT_LABEL[ev.cat]
  // glyph(2) + chip(label+2) + gap + title + tag + dur
  const fixed = 2 + label.length + 3 + (tag !== '' ? tag.length + 3 : 0) + dur.length + 1
  const titleWidth = Math.max(8, k.W - fixed)
  const isOpen = k.ui.expanded === ev.id
  const lines: RenderElement[] = []
  const indent = 2
  if (ev.detail !== undefined && ev.detail !== '' && (ev.cat === 'shell' || ev.cat === 'web' || ev.cat === 'agent' || ev.cat === 'mcp' || ev.cat === 'browser')) {
    lines.push(
      <Text key="d" color={ev.cat === 'shell' ? '#fbbf24' : undefined} dimColor={ev.cat !== 'shell'} wrap="truncate-end">
        {clip(ev.detail, Math.max(10, (k.W - indent) * 2))}
      </Text>,
    )
  } else if (ev.filePath !== undefined && ev.cat === 'edit') {
    lines.push(
      <Text key="d" dimColor wrap="truncate-end">
        {shortPath(ev.filePath, k.cwd, k.W - indent - 14)}
        {ev.added !== undefined ? <Text color={ADDED}> +{ev.added}</Text> : ''}
        {ev.removed !== undefined ? <Text color={REMOVED}> −{ev.removed}</Text> : ''}
      </Text>,
    )
  }
  if (ev.status !== 'running' && ev.output !== undefined && ev.cat === 'shell' && !isOpen) {
    const tail = ev.output.trimEnd().split('\n').slice(-2)
    for (const [i, line] of tail.entries()) {
      lines.push(
        <Text key={`o${i}`} color={ev.status === 'ok' ? '#94a3b8' : STATUS_COLOR.error} wrap="truncate-end">
          {`│ ${clip(line, Math.max(10, k.W - indent - 2))}`}
        </Text>,
      )
    }
  }
  if (ev.status !== 'running' && ev.status !== 'ok' && ev.cat !== 'shell' && ev.output !== undefined && !isOpen) {
    lines.push(
      <Text key="err" color={STATUS_COLOR[ev.status]} wrap="truncate-end">
        {`│ ${clip(ev.output.split('\n')[0] ?? '', Math.max(10, k.W - indent - 2))}`}
      </Text>,
    )
  }
  return (
    <Box key={`row-${ev.id}`} flexDirection="column" marginTop={0}>
      <Button key={`ev-${ev.id}`} plain onPress={() => setUi(k, u => ({ ...u, expanded: u.expanded === ev.id ? null : ev.id }))}>
        <Text color={STATUS_COLOR[ev.status]} bold>
          {statusGlyph(ev.status, k.now)}{' '}
        </Text>
        <Text backgroundColor={color} color="#0b1020" bold>
          {` ${label} `}
        </Text>
        <Text> </Text>
        <Text bold={ev.status === 'running'}>{fit(ev.title, titleWidth)}</Text>
        {tag !== '' ? <Text color={agentHue(ev.agentId ?? '')}> ⟡{tag}</Text> : ''}
        <Text dimColor={ev.status !== 'running'} color={ev.status === 'running' ? STATUS_COLOR.running : undefined}>
          {' '}
          {dur}
        </Text>
      </Button>
      {lines.length > 0 ? (
        <Box key="lines" flexDirection="column" paddingLeft={indent}>
          {lines}
        </Box>
      ) : null}
    </Box>
  )
}

const detail = (k: Kit, ev: CockpitEvent, change: CockpitChange | undefined): RenderElement => {
  const { Box, Text, Code } = k
  const color = CAT_COLOR[ev.cat]
  const facts: string[] = [ev.tool]
  if (ev.exitCode !== undefined) facts.push(`exit ${ev.exitCode}`)
  facts.push(duration(k, ev))
  if (ev.isBackground === true) facts.push('background')
  if (ev.agentId !== undefined) facts.push(`agent ${ev.agentId.slice(0, 10)}`)
  const command = ev.tool === 'Bash' && ev.detail !== undefined ? ev.detail.replace(/^\$ /, '').replace(/ ⏎ /g, '\n') : undefined
  return (
    <Box key={`detail-${ev.id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      <Box key="facts" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {chip(k, 'st', ev.status === 'running' ? 'RUNNING' : ev.status === 'ok' ? 'OK' : ev.status === 'error' ? 'ERROR' : 'DENIED', STATUS_COLOR[ev.status])}
        <Text key="f" dimColor>
          {facts.join(' · ')}
        </Text>
      </Box>
      {command !== undefined ? (
        <Box key="cmd" flexDirection="column" marginTop={1}>
          <Text key="t" bold color={color}>
            Command
          </Text>
          <Code key="c" source={command} language="bash" wrap="wrap" />
        </Box>
      ) : (
        <Box key="in" flexDirection="column" marginTop={1}>
          <Text key="t" bold color={color}>
            Input
          </Text>
          <Code key="c" source={ev.input} language="json" wrap="wrap" />
        </Box>
      )}
      {change !== undefined && change.diff !== '' ? (
        <Box key="diff" flexDirection="column" marginTop={1}>
          <Text key="t" bold color={color}>
            Diff <Text color={ADDED}>+{change.added}</Text> <Text color={REMOVED}>−{change.removed}</Text>
          </Text>
          <Code key="c" source={change.diff} format="diff" path={ev.filePath} wrap="truncate-end" />
        </Box>
      ) : null}
      {ev.output !== undefined ? (
        <Box key="out" flexDirection="column" marginTop={1}>
          <Text key="t" bold color={ev.status === 'ok' ? color : STATUS_COLOR[ev.status]}>
            Output
          </Text>
          <Code key="c" source={ev.output} language="text" wrap="wrap" />
        </Box>
      ) : ev.status === 'running' ? (
        <Text key="wait" dimColor italic>
          … running for {duration(k, ev)}
        </Text>
      ) : null}
    </Box>
  )
}

/** The refs the feed shows for the current filter and limit, newest first. */
export const visibleRefs = (
  ui: { filter: string; limit: number },
  refs: readonly CockpitFeedRef[],
): { shown: CockpitFeedRef[]; total: number } => {
  const filtered = refs.filter(r =>
    ui.filter === 'all' ? true : ui.filter === 'main' ? r.agent === undefined : r.agent === ui.filter,
  )
  return { shown: filtered.slice(-ui.limit).reverse(), total: filtered.length }
}

export const feedView = (
  k: Kit,
  refs: readonly CockpitFeedRef[],
  agents: readonly CockpitAgent[],
  events: readonly CockpitEvent[],
  total: number,
  expandedChange: CockpitChange | undefined,
): RenderElement => {
  const { Box, Button, Text } = k
  const showAgent = k.ui.filter === 'all' || k.ui.filter === 'main'
  const out: RenderElement[] = []
  for (const ev of events) {
    out.push(row(k, ev, agents, showAgent))
    if (k.ui.expanded === ev.id) out.push(detail(k, ev, expandedChange))
  }
  return (
    <Box key="feed" flexDirection="column">
      {refs.some(r => r.agent !== undefined) ? filterRow(k, refs, agents) : null}
      {events.length === 0
        ? empty(k, 'empty', [
            refs.length === 0 ? 'Nothing yet — waiting for Claude ✨' : 'Nothing for this filter.',
            'Every command, read, edit or agent will show up here live.',
          ])
        : (
            <Box key="list" flexDirection="column" marginTop={1}>
              {out}
            </Box>
          )}
      {total > events.length ? (
        <Button key="more" plain onPress={() => setUi(k, u => ({ ...u, limit: u.limit + 40 }))}>
          <Text dimColor>↓ {total - events.length} older — show 40 more</Text>
        </Button>
      ) : null}
    </Box>
  )
}
