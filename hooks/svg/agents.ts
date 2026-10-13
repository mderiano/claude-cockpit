// Cockpit's agents board: the main session, loose subagents, then each
// workflow run as a card with its progress and its agents.
import type { CockpitAgent, CockpitStats, CockpitWorkflow } from '../../types'
import { fmtCount, fmtDur } from '../model'
import { agentColor, esc, fitText, measure, pill, statusMark, svgDoc, text } from './base'
import type { SvgOut } from './base'

export type AgentsSvgData = {
  agents: readonly CockpitAgent[]
  workflows: readonly CockpitWorkflow[]
  stats: CockpitStats
  mainCalls: number
  now: number
  selected?: string
}

const STATUS_RANK = { running: 0, idle: 1, failed: 2, killed: 3, done: 4 } as const

const span = (a: CockpitAgent, now: number): string => fmtDur((a.endedAt ?? now) - a.startedAt)

const agentRow = (a: CockpitAgent, x: number, y: number, w: number, now: number, isSel: boolean): { svg: string; h: number } => {
  const hue = agentColor(a.id)
  const h = a.status === 'running' && a.lastTitle !== undefined ? 46 : 34
  let s = `<g class="row"><title>${esc(
    `${a.name ?? a.description}\n${a.type}${a.model !== undefined ? ` · ${a.model}` : ''} · ${a.status} · ${span(a, now)}\n${a.tools} tool calls${a.errors > 0 ? ` · ${a.errors} errors` : ''}${a.tokens !== undefined ? ` · ${fmtCount(a.tokens)} tokens` : ''}${a.answer !== undefined ? `\n\n${a.answer.slice(0, 600)}` : ''}`,
  )}</title>`
  s += `<rect x="${x - 6}" y="${y}" width="${w + 12}" height="${h - 2}" rx="8" class="hov"/>`
  if (isSel) s += `<rect x="${x - 5.5}" y="${y + 0.5}" width="${w + 11}" height="${h - 3}" rx="8" fill="none" stroke="#d97757" stroke-width="1.2"/>`
  s += statusMark(a.status, x + 8, y + 16, 7)
  s += `<rect x="${x + 22}" y="${y + 10}" width="3" height="12" rx="1.5" fill="${hue}"/>`
  const meta = `${a.tools} calls · ${span(a, now)}`
  const metaW = measure(meta, 11) + 4
  const prefix = a.workflowIndex !== undefined ? `#${a.workflowIndex}  ` : ''
  s += text(x + 32, y + 20, fitText(prefix + (a.name ?? a.description), w - 32 - metaW - 8, 12.5), 't1', 12.5, { weight: a.status === 'running' ? 620 : 520 })
  s += text(x + w, y + 20, meta, 't3 num', 11, { anchor: 'end' })
  if (a.status === 'running' && a.lastTitle !== undefined)
    s += text(x + 32, y + 36, fitText(`${a.lastTool ?? ''} · ${a.lastTitle}`, w - 32, 11, true), 't2 mono', 11)
  s += `</g>`
  return { svg: s, h }
}

export const agentsSvg = (width: number, d: AgentsSvgData): SvgOut => {
  const pad = 14
  const inner = width - pad * 2
  let y = 0
  let body = ''

  // The main session, as one card.
  body += `<rect x=".5" y=".5" width="${width - 1}" height="54" rx="12" class="card"/>`
  body += statusMark(d.stats.isWorking ? 'running' : 'idle', pad + 8, 27, 7)
  body += text(pad + 24, 24, 'Main session', 't1', 13, { weight: 620 })
  body += text(pad + 24, 41, `${d.mainCalls} calls · ${d.stats.turns} turns`, 't3 num', 11)
  const running = d.agents.filter(a => a.status === 'running').length
  const done = d.agents.filter(a => a.status === 'done' || a.status === 'idle').length
  const failed = d.agents.filter(a => a.status === 'failed' || a.status === 'killed').length
  let px = width - pad
  for (const [label, color, n] of [
    [`${failed} failed`, '#dc2626', failed],
    [`${done} done`, '#16a34a', done],
    [`${running} running`, '#2563eb', running],
  ] as const) {
    if (n === 0) continue
    const w = measure(label, 11) + 14
    px -= w
    body += pill(px, 18, label, color).svg
    px -= 6
  }
  y = 66

  const sorted = (list: readonly CockpitAgent[]) =>
    [...list].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.startedAt - a.startedAt)

  // Loose subagents.
  const loose = sorted(d.agents.filter(a => a.runId === undefined))
  if (loose.length > 0) {
    body += text(pad, y + 12, 'SUBAGENTS', 't3', 10.5, { weight: 650, extra: ' letter-spacing=".6"' })
    y += 22
    for (const a of loose) {
      const r = agentRow(a, pad, y, inner, d.now, d.selected === a.id)
      body += r.svg
      y += r.h
    }
    y += 10
  }

  // Workflow runs, live ones first.
  const runIds = [...new Set(d.agents.filter(a => a.runId !== undefined).map(a => a.runId as string))]
  const runs = runIds
    .map(id => {
      const list = d.agents.filter(a => a.runId === id)
      return { id, list, live: list.filter(a => a.status === 'running').length, wf: d.workflows.find(w => w.runId === id) }
    })
    .sort((a, b) => Number(b.live > 0) - Number(a.live > 0))
  for (const run of runs) {
    const list = [...run.list].sort((a, b) => (a.workflowIndex ?? 0) - (b.workflowIndex ?? 0))
    const finished = list.filter(a => a.status !== 'running' && a.status !== 'idle').length
    const fails = list.filter(a => a.status === 'failed' || a.status === 'killed').length
    const top = y
    y += 14
    body += `<g transform="translate(${pad} ${y})"><rect width="18" height="18" rx="5" fill="#7c3aed" fill-opacity=".12"/>` +
      `<path d="M4.5 9h3l1.5-3.5 2 7 1.5-3.5h1.5" fill="none" stroke="#7c3aed" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></g>`
    const meta = `${finished}/${list.length}${fails > 0 ? ` · ${fails} failed` : ''}`
    body += text(pad + 26, y + 13.5, fitText(run.wf?.name ?? 'Workflow', inner - 26 - measure(meta, 11) - 12, 13), 't1', 13, { weight: 620 })
    body += text(width - pad, y + 13.5, meta, `${fails > 0 ? 'err' : 't3'} num`, 11, { anchor: 'end' })
    y += 26
    // Progress: a segment per agent, coloured by state.
    const gap = 3
    const seg = Math.max(4, (inner - gap * (list.length - 1)) / list.length)
    for (const [i, a] of list.entries()) {
      const fill = a.status === 'done' ? '#16a34a' : a.status === 'running' ? '#2563eb' : a.status === 'failed' || a.status === 'killed' ? '#dc2626' : '#a8a29e'
      const op = a.status === 'running' ? '.55' : a.status === 'idle' ? '.35' : '.85'
      body += `<rect x="${(pad + i * (seg + gap)).toFixed(1)}" y="${y}" width="${seg.toFixed(1)}" height="5" rx="2.5" fill="${fill}" fill-opacity="${op}">` +
        (a.status === 'running' ? `<animate attributeName="fill-opacity" values=".35;.8;.35" dur="1.6s" repeatCount="indefinite"/>` : '') +
        `</rect>`
    }
    y += 14
    for (const a of sorted(list)) {
      const r = agentRow(a, pad + 4, y, inner - 4, d.now, d.selected === a.id)
      body += r.svg
      y += r.h
    }
    y += 6
    body += `<rect x=".5" y="${top + 0.5}" width="${width - 1}" height="${y - top}" rx="12" fill="none" class="line" stroke-width="1"/>`
    y += 10
  }
  if (d.agents.length === 0) {
    body += text(width / 2, y + 22, 'No subagents yet', 't2', 12.5, { anchor: 'middle', weight: 560 })
    body += text(width / 2, y + 40, 'Agents, teammates and workflow runs show up here live.', 't3', 11, { anchor: 'middle' })
    y += 56
  }
  return svgDoc(width, y + 2, body)
}
