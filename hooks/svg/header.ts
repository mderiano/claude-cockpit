// Cockpit's header card: who is working, a row of plain metrics and the
// activity of the last minutes as one smooth area.
import type { CockpitAgent, CockpitStats } from '../../types'
import { fmtCount, fmtSince, SPARK_MS } from '../model'
import { esc, fitText, measure, pill, svgDoc, text } from './base'
import type { SvgOut } from './base'

export type HeaderSvgData = {
  stats: CockpitStats
  agents: readonly CockpitAgent[]
  files: number
  series: readonly number[]
  now: number
  /** What Claude is doing right now, when a call runs. */
  doing?: string
}

const smoothPath = (pts: readonly [number, number][]): string => {
  if (pts.length === 0) return ''
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1]!
    const [x1, y1] = pts[i]!
    const mx = (x0 + x1) / 2
    d += ` C${mx.toFixed(1)} ${y0.toFixed(1)} ${mx.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`
  }
  return d
}

export const headerSvg = (width: number, d: HeaderSvgData): SvgOut => {
  const { stats, agents } = d
  const running = agents.filter(a => a.status === 'running').length
  const isBusy = stats.isWorking || stats.running > 0 || running > 0
  const pad = 16
  const inner = width - pad * 2
  let body = ''

  // Row 1: mark, name, state pill; elapsed on the right.
  body += `<rect x=".5" y=".5" width="${width - 1}" height="HEIGHT" rx="14" class="card"/>`
  body +=
    `<g transform="translate(${pad} 16)">` +
    `<rect width="22" height="22" rx="7" fill="url(#mark)"/>` +
    `<path d="M6 13.5l5-7 5 7M8.2 11h5.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g>`
  body += text(pad + 30, 32, 'Cockpit', 't1', 15, { weight: 650 })
  const state = isBusy
    ? pill(pad + 30 + measure('Cockpit', 15) + 12, 18, running > 0 ? `Working · ${running} agent${running === 1 ? '' : 's'}` : 'Working', '#d97757', { dot: true, pulse: true })
    : pill(pad + 30 + measure('Cockpit', 15) + 12, 18, 'Idle', '#78716c', { dot: true })
  body += state.svg
  // To the minute: the header is the same picture from one second to the next.
  const elapsed = stats.startedAt > 0 && d.now > 0 ? fmtSince(d.now - stats.startedAt) : '—'
  const right = `${elapsed} · ${stats.turns} turn${stats.turns === 1 ? '' : 's'}`
  body += text(width - pad, 32, right, 't3 num', 12, { anchor: 'end' })

  // The current action, one line, when there is one.
  let y = 50
  if (d.doing !== undefined && d.doing !== '') {
    body += text(pad, y + 14, fitText(d.doing, inner, 12.5), 't2', 12.5)
    y += 22
  }

  // Row 2: metrics, evenly spaced; a value over its label.
  const failed = agents.filter(a => a.status === 'failed' || a.status === 'killed').length
  const metrics: { label: string; value: string; sub?: string; cls?: string }[] = [
    { label: 'Tool calls', value: fmtCount(stats.calls) },
    { label: 'Commands', value: fmtCount(stats.commands) },
    {
      label: 'Files',
      value: String(d.files),
      sub: stats.added + stats.removed > 0 ? `+${fmtCount(stats.added)} −${fmtCount(stats.removed)}` : undefined,
    },
    { label: 'Agents', value: agents.length === 0 ? '0' : `${running}/${agents.length}`, sub: failed > 0 ? `${failed} failed` : undefined },
    { label: 'Errors', value: String(stats.errors), cls: stats.errors > 0 ? 'err' : 't1' },
  ]
  const list = inner < 330 ? [metrics[0]!, metrics[2]!, metrics[4]!] : metrics
  const colW = inner / list.length
  y += 12
  for (const [i, m] of list.entries()) {
    const x = pad + i * colW
    if (i > 0) body += `<path d="M${(x - 8).toFixed(1)} ${y + 2}v30" class="line" stroke-width="1"/>`
    body += text(x, y + 18, m.value, `${m.cls ?? 't1'} num`, 19, { weight: 650 })
    if (m.sub !== undefined) {
      const vw = measure(m.value, 19) + 6
      const isDiff = m.sub.startsWith('+')
      if (isDiff) {
        const [plus, minus] = m.sub.split(' ')
        body += text(x + vw, y + 17, plus ?? '', 'add num', 11, { weight: 600 })
        body += text(x + vw + measure(`${plus ?? ''} `, 11), y + 17, minus ?? '', 'del num', 11, { weight: 600 })
      } else body += text(x + vw, y + 17, m.sub, 'err', 11, { weight: 600 })
    }
    body += text(x, y + 33, m.label, 't3', 11, { weight: 500 })
  }
  y += 48

  // Row 3: activity, a smooth area over the last minutes.
  const series = d.series
  const chartH = 34
  const max = Math.max(1, ...series)
  const step = series.length > 1 ? inner / (series.length - 1) : inner
  const pts: [number, number][] = series.map((v, i) => [pad + i * step, y + chartH - (v / max) * (chartH - 4) - 1])
  const line = smoothPath(pts)
  const area = `${line} L${(pad + inner).toFixed(1)} ${y + chartH} L${pad} ${y + chartH} Z`
  body += `<path d="M${pad} ${y + chartH + 0.5}h${inner}" class="line" stroke-width="1"/>`
  body += `<path d="${area}" fill="url(#area)"/>`
  body += `<path d="${line}" fill="none" stroke="#d97757" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`
  const last = pts[pts.length - 1]
  if (last !== undefined && (series[series.length - 1] ?? 0) > 0)
    body += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="#d97757" stroke="#fff" stroke-width="1.5"/>`
  const minutes = Math.round((series.length * SPARK_MS) / 60000)
  y += chartH + 15
  body += text(pad, y, `${minutes} min ago`, 't3', 10.5)
  body += text(pad + inner / 2, y, 'activity', 't3', 10.5, { anchor: 'middle' })
  body += text(pad + inner, y, 'now', 't3', 10.5, { anchor: 'end' })
  const height = y + 14
  const defs =
    `<linearGradient id="mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e08a6a"/><stop offset="1" stop-color="#c2552f"/></linearGradient>` +
    `<linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d97757" stop-opacity=".28"/><stop offset="1" stop-color="#d97757" stop-opacity="0"/></linearGradient>`
  const out = svgDoc(width, height, body.replace('HEIGHT', String(height - 1)), defs)
  return { ...out, source: out.source.replace('<svg ', `<svg aria-label="${esc('Cockpit summary')}" `) }
}
