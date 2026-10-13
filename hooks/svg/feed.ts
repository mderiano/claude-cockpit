// Cockpit's activity list: one calm row per tool call, newest first. The
// icon says what kind of call, the title what it did, the second line how
// (the command, the path), the right edge how long and how it ended.
import type { CockpitAgent, CockpitEvent } from '../../types'
import { basename, dirname, fmtDur, shortPath } from '../model'
import { agentColor, CAT_NAME, esc, fitText, iconTile, measure, statusMark, svgDoc, text } from './base'
import type { SvgOut } from './base'

export type FeedSvgData = {
  events: readonly CockpitEvent[]
  agents: readonly CockpitAgent[]
  now: number
  cwd: string
  /** Show which agent ran a call (off when the list is one agent's). */
  showAgent: boolean
  /** The row the inspector below shows, outlined. */
  selected?: string
}

const STATUS_WORD = { running: 'running', ok: 'done', error: 'failed', denied: 'denied' } as const

export const agentName = (agents: readonly CockpitAgent[], id: string): string => {
  const a = agents.find(one => one.id === id)
  if (a === undefined) return `agent ${id.slice(0, 6)}`
  const base = a.name ?? a.description
  return a.workflowIndex !== undefined ? `#${a.workflowIndex} ${base}` : base
}

const took = (ev: CockpitEvent, now: number): string =>
  ev.status === 'running' ? fmtDur(Math.max(0, now - ev.startedAt)) : fmtDur((ev.endedAt ?? ev.startedAt) - ev.startedAt)

/** The second line: what the call ran on, said the plainest way. */
const secondLine = (ev: CockpitEvent, cwd: string): { value: string; mono: boolean } | undefined => {
  if (ev.cat === 'shell' && ev.detail !== undefined) return { value: ev.detail.replace(/^\$ /, '').replace(/ ⏎ /g, ' ; '), mono: true }
  if (ev.filePath !== undefined) {
    const dir = dirname(ev.filePath)
    return { value: dir === '' || dir === cwd ? './' : `${shortPath(dir, cwd, 80)}/`, mono: true }
  }
  if (ev.detail !== undefined && ev.detail !== '' && ev.detail !== ev.title) return { value: ev.detail, mono: ev.cat === 'search' || ev.cat === 'read' }
  return undefined
}

const tooltip = (ev: CockpitEvent, agents: readonly CockpitAgent[], now: number): string => {
  const head = `${CAT_NAME[ev.cat]} · ${ev.tool} · ${STATUS_WORD[ev.status]} · ${took(ev, now)}`
  const who = ev.agentId !== undefined ? `\n${agentName(agents, ev.agentId)}` : ''
  const what = ev.detail !== undefined ? `\n\n${ev.detail.replace(/ ⏎ /g, '\n').slice(0, 600)}` : ''
  const out = ev.output !== undefined && ev.output.trim() !== '' ? `\n\n${ev.output.trimEnd().split('\n').slice(-12).join('\n').slice(-900)}` : ''
  return `${head}${who}${what}${out}`
}

export const feedSvg = (width: number, d: FeedSvgData): SvgOut => {
  const padX = 12
  const tile = 28
  const textX = padX + tile + 12
  const rightW = 64
  const textW = width - textX - rightW - 4
  let y = 6
  let body = ''
  for (const [i, ev] of d.events.entries()) {
    const second = secondLine(ev, d.cwd)
    const isFailed = ev.status === 'error' || ev.status === 'denied'
    const errLine = isFailed && ev.output !== undefined ? (ev.output.split('\n').find(l => l.trim() !== '') ?? '').trim() : ''
    const h = 50 + (errLine !== '' ? 18 : 0)
    const isSel = d.selected === ev.id
    let row = `<g class="row"><title>${esc(tooltip(ev, d.agents, d.now))}</title>`
    row += `<rect x="4" y="${y}" width="${width - 8}" height="${h - 2}" rx="10" class="${isFailed ? 'errbg' : 'hov'}"/>`
    if (isSel) row += `<rect x="4.5" y="${y + 0.5}" width="${width - 9}" height="${h - 3}" rx="10" fill="none" stroke="#d97757" stroke-width="1.2"/>`
    row += iconTile(ev.cat, padX, y + 10, tile)

    // Line 1: what it did.
    const title = ev.cat === 'edit' && ev.filePath !== undefined ? basename(ev.filePath) : ev.title
    let x = textX
    let line1W = textW
    if (ev.cat === 'edit' && (ev.added !== undefined || ev.removed !== undefined)) {
      const delta = `+${ev.added ?? 0} −${ev.removed ?? 0}`
      line1W -= measure(delta, 11) + 10
    }
    const shownTitle = fitText(title, line1W, 13)
    row += text(x, y + 22, shownTitle, 't1', 13, { weight: ev.status === 'running' ? 650 : 560 })
    if (ev.cat === 'edit' && (ev.added !== undefined || ev.removed !== undefined)) {
      const tx = x + measure(shownTitle, 13) + 8
      const plus = `+${ev.added ?? 0}`
      row += text(tx, y + 22, plus, 'add num', 11, { weight: 600 })
      row += text(tx + measure(`${plus} `, 11), y + 22, `−${ev.removed ?? 0}`, 'del num', 11, { weight: 600 })
    }

    // Line 2: the agent that ran it, then how.
    x = textX
    let line2W = textW
    if (d.showAgent && ev.agentId !== undefined) {
      const hue = agentColor(ev.agentId)
      const name = fitText(agentName(d.agents, ev.agentId), Math.min(130, textW * 0.4), 10.5)
      const w = measure(name, 10.5) + 16
      row += `<rect x="${x}" y="${y + 29}" width="${w.toFixed(1)}" height="15" rx="7.5" fill="${hue}" fill-opacity=".12"/>`
      row += `<circle cx="${x + 6.5}" cy="${y + 36.5}" r="2.5" fill="${hue}"/>`
      row += text(x + 12, y + 40, name, '', 10.5, { weight: 600, fill: hue })
      x += w + 6
      line2W -= w + 6
    }
    if (second !== undefined)
      row += text(x, y + 40, fitText(second.value, line2W, second.mono ? 11 : 11.5, second.mono), `t2${second.mono ? ' mono' : ''}`, second.mono ? 11 : 11.5)
    else row += text(x, y + 40, ev.tool, 't3', 11)
    if (errLine !== '') row += text(textX, y + 58, fitText(errLine, textW + rightW - 20, 11, true), 'err mono', 11)

    // Right edge: duration over the status mark.
    row += text(width - 34, y + 22, took(ev, d.now), 't3 num', 11, { anchor: 'end' })
    row += statusMark(ev.status, width - 20, y + 18, 7)
    row += `</g>`
    body += row
    y += h
    if (i < d.events.length - 1 && !isFailed && d.events[i + 1]?.status !== 'error')
      body += `<path d="M${textX} ${y - 1}h${width - textX - 12}" class="line" stroke-width="1"/>`
  }
  return svgDoc(width, y + 6, body)
}
