// Cockpit: the stats strip, the activity sparkline and the tabs.
import type { RenderElement } from 'claude-code'

import type { CockpitAgent, CockpitStats, CockpitTab } from '../../types'
import {
  ACCENT,
  ADDED,
  CAT_COLOR,
  fmtCount,
  fmtDur,
  MUTED,
  plural,
  REMOVED,
  sparkSeries,
  sparkText,
  SPARK_LEN,
  SPARK_MS,
} from '../model'
import { chip, setUi } from './kit'
import type { Kit } from './kit'

const sparkSvg = (values: readonly number[], width: number, height: number): string => {
  const max = Math.max(1, ...values)
  const gap = 2
  const bar = Math.max(2, (width - gap * (values.length - 1)) / values.length)
  const rects = values
    .map((v, i) => {
      const barH = v === 0 ? 1.5 : Math.max(3, (v / max) * (height - 2))
      const x = i * (bar + gap)
      const opacity = v === 0 ? 0.25 : 0.55 + 0.45 * (i / Math.max(1, values.length - 1))
      return `<rect x="${x.toFixed(1)}" y="${(height - barH).toFixed(1)}" width="${bar.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="url(#g)" opacity="${opacity.toFixed(2)}"/>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>` +
    `${rects}</svg>`
  )
}

export type HeaderData = {
  stats: CockpitStats
  agents: readonly CockpitAgent[]
  files: number
}

export const header = (k: Kit, d: HeaderData): RenderElement => {
  const { Box, Text, Svg } = k
  const { stats, agents } = d
  const running = agents.filter(a => a.status === 'running').length
  const finished = agents.filter(a => a.status === 'done' || a.status === 'idle').length
  const failed = agents.filter(a => a.status === 'failed' || a.status === 'killed').length
  const since = k.now - stats.startedAt
  const elapsed = stats.startedAt > 0 && k.now > 0 ? (since < 1000 ? '0s' : fmtDur(since)) : '—'
  const isBusy = stats.isWorking || stats.running > 0 || running > 0
  const pulse = Math.floor(k.now / 1000) % 2 === 0
  const series = sparkSeries(stats, k.now)
  const isNarrow = k.W < 56
  // Narrow, the text strip keeps the latest whole minutes (4 buckets each),
  // and its label says the span it actually draws.
  const drawn = Svg === undefined && isNarrow ? Math.min(SPARK_LEN, Math.max(8, Math.floor((k.W - 30) / 4) * 4)) : SPARK_LEN

  const chips: RenderElement[] = [
    chip(k, 'c-calls', `⚡ ${fmtCount(stats.calls)}`, ACCENT),
    chip(k, 'c-cmd', `$ ${fmtCount(stats.commands)}`, CAT_COLOR.shell),
    chip(k, 'c-files', `✎ ${d.files}`, CAT_COLOR.edit),
  ]
  if (agents.length > 0) chips.push(chip(k, 'c-agents', `🤖 ${running}▸ ${finished}✓${failed > 0 ? ` ${failed}✗` : ''}`, CAT_COLOR.agent))
  if (stats.errors > 0) chips.push(chip(k, 'c-err', `✗ ${stats.errors}`, '#ef4444'))
  if (stats.streak >= 3) chips.push(chip(k, 'c-streak', `🔥 ×${stats.streak}`, '#f97316'))

  return (
    <Box key="header" flexDirection="column">
      <Box key="h-top" flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color={ACCENT}>
            ◆ COCKPIT
          </Text>
          <Text> </Text>
          {isBusy ? (
            <Text color={pulse ? '#38bdf8' : '#0ea5e9'}>{pulse ? '●' : '◉'} working</Text>
          ) : (
            <Text dimColor>○ idle</Text>
          )}
        </Text>
        <Text dimColor>
          ⏱ {elapsed}
          {stats.turns > 0 ? ` · ${plural(stats.turns, 'turn')}` : ''}
        </Text>
      </Box>
      <Box key="h-chips" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {chips}
        <Text key="c-lines">
          <Text color={ADDED} bold>
            +{fmtCount(stats.added)}
          </Text>{' '}
          <Text color={REMOVED} bold>
            −{fmtCount(stats.removed)}
          </Text>
        </Text>
      </Box>
      <Box key="h-spark" flexDirection="row" columnGap={1} marginTop={1} alignItems="flex-end">
        {Svg !== undefined ? (
          <Svg
            key="spark"
            alt={`Activity: ${series.join(' ')}`}
            source={sparkSvg(series, Math.min(280, Math.max(120, k.W * 5)), 22)}
          />
        ) : (
          <Text key="spark" color={ACCENT}>
            {sparkText(series.slice(-drawn))}
          </Text>
        )}
        <Text key="spark-l" dimColor>
          {`${Math.round((drawn * SPARK_MS) / 60000)} min`}
          {stats.bestStreak >= 5 ? ` · record ×${stats.bestStreak}` : ''}
        </Text>
      </Box>
    </Box>
  )
}

const TABS: { tab: CockpitTab; label: string; hotkey: string; color: string }[] = [
  { tab: 'feed', label: 'Feed', hotkey: '1', color: CAT_COLOR.shell },
  { tab: 'files', label: 'Files', hotkey: '2', color: CAT_COLOR.edit },
  { tab: 'agents', label: 'Agents', hotkey: '3', color: CAT_COLOR.agent },
  { tab: 'screen', label: 'Screen', hotkey: '4', color: CAT_COLOR.browser },
]

export const tabs = (
  k: Kit,
  counts: Record<CockpitTab, string>,
  onScreen: () => void,
): RenderElement => {
  const { Box, Button, Text } = k
  return (
    <Box key="tabs" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
      {TABS.map(t => {
        const isActive = k.ui.tab === t.tab
        return (
          <Button
            key={`tab-${t.tab}`}
            hotkey={t.hotkey}
            variant={isActive ? 'primary' : 'secondary'}
            onPress={() => {
              setUi(k, u => ({ ...u, tab: t.tab, offset: 0 }))
              if (t.tab === 'screen') onScreen()
            }}
          >
            <Text color={isActive ? t.color : undefined} bold={isActive}>
              {t.label}
            </Text>
            {counts[t.tab] !== '' ? <Text dimColor> {counts[t.tab]}</Text> : ''}
          </Button>
        )
      })}
    </Box>
  )
}

export const footer = (k: Kit): RenderElement => {
  const { Text } = k
  return (
    <Text key="footer" dimColor color={MUTED}>
      1-4 tabs · click = details · /cockpit screen
    </Text>
  )
}
