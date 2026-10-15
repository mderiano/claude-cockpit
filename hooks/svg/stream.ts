// Cockpit's live stream, the drawn parts: the summary line of a run of small
// calls (its rows are native, so they can be clicked), agent and workflow
// cards, a command's terminal, and the head of a file change (its diff is the
// engine's own Code, drawn under it). Images only: nothing here hovers, and
// nothing changes from one second to the next but a running call's time.
import type { CockpitAgent, CockpitCategory, CockpitEvent, CockpitWorkflow } from '../../types'
import { basename, dirname, fmtAgoCoarse, fmtBytes, fmtDur, shortPath } from '../model'
import { agentColor, appPill, appTile, CAT_NAME, fitText, HUE, iconTile, measure, pill, statusMark, svgDoc, text } from './base'
import type { Badge, SvgOut } from './base'
import { agentName } from './feed'

const took = (ev: CockpitEvent, now: number): string =>
  ev.status === 'running' ? fmtDur(Math.max(0, now - ev.startedAt)) : fmtDur((ev.endedAt ?? ev.startedAt) - ev.startedAt)

/** A title without the app's name it starts with, when a badge already says it. */
const bare = (title: string, app: Badge | undefined): string =>
  app !== undefined && title.startsWith(`${app.name} · `) ? title.slice(app.name.length + 3) : title

/** An age that changes once a minute at most: the drawing stays the same picture. */
const ago = (at: number, now: number): string => fmtAgoCoarse(at, now)

const NOUN: Partial<Record<CockpitCategory, [string, string]>> = {
  shell: ['command', 'commands'],
  read: ['read', 'reads'],
  search: ['search', 'searches'],
  web: ['fetch', 'fetches'],
  mcp: ['tool call', 'tool calls'],
  task: ['update', 'updates'],
  browser: ['screen action', 'screen actions'],
  other: ['call', 'calls'],
  agent: ['agent call', 'agent calls'],
  edit: ['edit', 'edits'],
}

/** How many rows of a run of small calls show before « + N more ». */
export const COMPACT_ROWS = 3

/**
 * The summary line of a run of small calls (commands, reads, searches): the
 * count of each kind with its tile, what failed, how long ago. The rows
 * themselves are native, under it.
 */
export const runSummarySvg = (width: number, events: readonly CockpitEvent[], now: number): SvgOut => {
  const pad = 12
  let body = ''
  const counts = new Map<CockpitCategory, number>()
  for (const ev of events) counts.set(ev.cat, (counts.get(ev.cat) ?? 0) + 1)
  const failed = events.filter(ev => ev.status === 'error' || ev.status === 'denied').length
  const last = events[0]
  const right = failed > 0 ? `${failed} failed` : last !== undefined ? ago(last.startedAt, now) : ''
  const rightW = measure(right, 11) + 12
  let x = pad
  for (const [cat, n] of counts) {
    const [one, many] = NOUN[cat] ?? ['call', 'calls']
    const label = `${n} ${n === 1 ? one : many}`
    const w = 18 + measure(label, 11.5) + 14
    if (x + w > width - pad - rightW) break
    body += iconTile(cat, x, 6, 16)
    body += text(x + 21, 18.5, label, 't2', 11.5, { weight: 560 })
    x += w
  }
  body += text(width - pad, 18.5, right, failed > 0 ? 'err' : 't3 num', 11, { anchor: 'end', weight: failed > 0 ? 600 : 400 })
  return svgDoc(width, 28, body)
}

/** An agent's card: what it was asked, its state and what it does now. */
export const agentCardSvg = (width: number, a: CockpitAgent | undefined, ev: CockpitEvent, agents: readonly CockpitAgent[], now: number): SvgOut => {
  const pad = 14
  const hue = a !== undefined ? agentColor(a.id) : HUE.agent
  const status = a?.status ?? (ev.status === 'running' ? 'running' : ev.status === 'ok' ? 'done' : 'failed')
  const isLive = status === 'running'
  const title = a?.description ?? ev.title
  const h = isLive && a?.lastTitle !== undefined ? 84 : 66
  let body = `<rect x=".5" y=".5" width="${width - 1}" height="${h - 1}" rx="14" class="card"/>`
  body += `<rect x=".5" y=".5" width="4" height="${h - 1}" rx="2" fill="${hue}"/>`
  body += iconTile('agent', pad, 14, 28)
  const word = isLive ? 'Agent running' : status === 'done' || status === 'idle' ? 'Agent finished' : 'Agent failed'
  const color = isLive ? '#2563eb' : status === 'done' || status === 'idle' ? '#16a34a' : '#dc2626'
  const tag = pill(pad + 40, 12, word, color, { dot: true, pulse: isLive, size: 10.5 })
  body += tag.svg
  const meta = [a?.type ?? ev.detail ?? '', a !== undefined ? `${a.tools} calls` : '', fmtDur(((a?.endedAt ?? ev.endedAt) ?? now) - (a?.startedAt ?? ev.startedAt))]
    .filter(s => s !== '')
    .join(' · ')
  body += text(pad + 40 + tag.width + 8, 25, fitText(meta, width - pad * 2 - 48 - tag.width, 11), 't3 num', 11)
  body += text(pad + 40, 50, fitText(title, width - pad - 40 - 14, 13.5), 't1', 13.5, { weight: 620 })
  if (isLive && a?.lastTitle !== undefined)
    body += text(pad + 40, 68, fitText(`${a.lastTool ?? ''} · ${a.lastTitle}`, width - pad - 54, 11, true), 't2 mono', 11)
  void agents
  return svgDoc(width, h, body)
}

/** A workflow run's card: its name, a segment per agent, the live ones listed. */
export const workflowCardSvg = (width: number, wf: CockpitWorkflow | undefined, ev: CockpitEvent | undefined, list: readonly CockpitAgent[], now: number): SvgOut => {
  const pad = 14
  const sorted = [...list].sort((a, b) => (a.workflowIndex ?? 0) - (b.workflowIndex ?? 0))
  const live = sorted.filter(a => a.status === 'running')
  const done = sorted.filter(a => a.status === 'done' || a.status === 'idle').length
  const fails = sorted.filter(a => a.status === 'failed' || a.status === 'killed').length
  let body = ''
  body += `<g transform="translate(${pad} 14)"><rect width="28" height="28" rx="8" fill="#7c3aed" fill-opacity=".12"/>` +
    `<path d="M7 14h4l2-5 3 10 2-5h3" fill="none" stroke="#7c3aed" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>`
  const isLive = live.length > 0 || ev?.status === 'running'
  const tag = pill(pad + 40, 12, isLive ? 'Workflow running' : fails > 0 ? 'Workflow finished with errors' : 'Workflow finished', isLive ? '#7c3aed' : fails > 0 ? '#dc2626' : '#16a34a', { dot: true, pulse: isLive, size: 10.5 })
  body += tag.svg
  // How long the run took: its agents run on after the call that launched them returned.
  const start = wf?.startedAt ?? ev?.startedAt ?? now
  const end = isLive ? now : Math.max(ev?.endedAt ?? start, ...sorted.map(a => a.endedAt ?? start))
  const meta = `${done}/${sorted.length} done${fails > 0 ? ` · ${fails} failed` : ''} · ${fmtDur(end - start)}`
  body += text(width - pad, 25, meta, 't3 num', 11, { anchor: 'end' })
  body += text(pad + 40, 50, fitText(wf?.name ?? ev?.title ?? 'Workflow', width - pad - 54, 13.5), 't1', 13.5, { weight: 620 })
  let y = 62
  if (sorted.length > 0) {
    const inner = width - pad * 2
    const gap = 3
    const seg = Math.max(3, (inner - gap * (sorted.length - 1)) / sorted.length)
    for (const [i, a] of sorted.entries()) {
      const fill = a.status === 'done' || a.status === 'idle' ? '#16a34a' : a.status === 'running' ? '#7c3aed' : a.status === 'failed' || a.status === 'killed' ? '#dc2626' : '#a8a29e'
      body += `<rect x="${(pad + i * (seg + gap)).toFixed(1)}" y="${y}" width="${seg.toFixed(1)}" height="6" rx="3" fill="${fill}" fill-opacity="${a.status === 'running' ? '.5' : '.85'}">` +
        (a.status === 'running' ? `<animate attributeName="fill-opacity" values=".3;.85;.3" dur="1.6s" repeatCount="indefinite"/>` : '') +
        `</rect>`
    }
    y += 14
  }
  // The agents at work now, one line each.
  for (const a of live.slice(0, 6)) {
    body += statusMark('running', pad + 7, y + 11, 5.5)
    const head = `#${a.workflowIndex ?? '?'} ${a.name ?? a.description}`
    const headT = fitText(head, (width - pad * 2 - 20) * 0.5, 12)
    body += text(pad + 20, y + 15, headT, 't1', 12, { weight: 560 })
    if (a.lastTitle !== undefined) {
      const lx = pad + 20 + measure(headT, 12) + 8
      body += text(lx, y + 15, fitText(`${a.lastTool ?? ''} · ${a.lastTitle}`, width - lx - pad, 11, true), 't3 mono', 11)
    }
    y += 22
  }
  if (live.length > 6) {
    body += text(pad + 20, y + 13, `+ ${live.length - 6} more running`, 't3', 10.5)
    y += 18
  }
  const h = y + 10
  return svgDoc(width, h, `<rect x=".5" y=".5" width="${width - 1}" height="${h - 1}" rx="14" class="card"/><rect x=".5" y=".5" width="4" height="${h - 1}" rx="2" fill="#7c3aed"/>${body}`)
}

/** The head of a file change; the diff follows as the engine's Code. */
export const fileHeadSvg = (
  width: number,
  ev: CockpitEvent,
  agents: readonly CockpitAgent[],
  cwd: string,
  now: number,
  isNew: boolean,
  app?: Badge,
  /** A binary asset: its size instead of the line counts, and no diff. */
  asset?: { size?: number },
): SvgOut => {
  const pad = 14
  const path = ev.filePath ?? ev.title
  const name = basename(path)
  const dir = dirname(path)
  const where = dir === '' || dir === cwd ? './' : `${shortPath(dir, cwd, 80)}/`
  let body = app !== undefined ? appTile(app, pad, 12, 28) : iconTile('edit', pad, 12, 28)
  const word =
    ev.status === 'running' ? 'Editing' : asset !== undefined ? 'Asset changed' : isNew ? 'New file' : ev.status === 'ok' ? 'Edited' : 'Edit failed'
  const color = ev.status === 'error' || ev.status === 'denied' ? '#dc2626' : asset !== undefined ? '#7c3aed' : '#16a34a'
  const tag = pill(pad + 40, 10, word, color, { size: 10.5, dot: ev.status === 'running', pulse: ev.status === 'running' })
  body += tag.svg
  let x = pad + 40 + tag.width + 8
  if (app !== undefined) {
    const badge = appPill(app, x, 10)
    body += badge.svg
    x += badge.width + 8
  }
  if (ev.agentId !== undefined) {
    const hue = agentColor(ev.agentId)
    const n = fitText(agentName(agents, ev.agentId), 140, 10.5)
    body += `<circle cx="${x + 3}" cy="${21}" r="3" fill="${hue}"/>`
    body += text(x + 10, 24.5, n, '', 10.5, { weight: 600, fill: hue })
    x += measure(n, 10.5) + 18
  }
  const right = ago(ev.startedAt, now)
  body += text(width - pad, 24.5, right, 't3 num', 11, { anchor: 'end' })
  const plus = `+${ev.added ?? 0}`
  const minus = `−${ev.removed ?? 0}`
  const size = asset !== undefined ? (asset.size !== undefined ? fmtBytes(asset.size) : 'binary') : ''
  const deltaW = asset !== undefined ? measure(size, 11.5) + 6 : measure(`${plus} ${minus}`, 11.5) + 6
  const nameT = fitText(name, width - pad - 40 - deltaW - 14 - pad, 14)
  body += text(pad + 40, 47, nameT, 't1', 14, { weight: 640 })
  const dx = pad + 40 + measure(nameT, 14) + 10
  if (asset !== undefined) body += text(dx, 47, size, 't3 num', 11.5, { weight: 650 })
  else {
    body += text(dx, 47, plus, 'add num', 11.5, { weight: 650 })
    body += text(dx + measure(`${plus} `, 11.5), 47, minus, 'del num', 11.5, { weight: 650 })
  }
  body += text(pad + 40, 63, fitText(where, width - pad * 2 - 40, 11, true), 't3 mono', 11)
  return svgDoc(width, 72, body)
}

/** Wraps text into at most `lines` lines of `px` (mono), the last cut. */
const wrapMono = (value: string, px: number, size: number, lines: number): string[] => {
  const per = Math.max(8, Math.floor(px / (size * 0.6)))
  const out: string[] = []
  let rest = value
  while (rest.length > 0 && out.length < lines) {
    out.push(rest.slice(0, per))
    rest = rest.slice(per)
  }
  if (rest.length > 0 && out.length > 0) out[out.length - 1] = `${out[out.length - 1]!.slice(0, per - 1)}…`
  return out
}

/** Output lines a terminal card shows, from the end. */
const TERMINAL_TAIL = 8
/** Lines of the command a terminal card shows. */
const TERMINAL_COMMAND_LINES = 4

/** The command as a terminal card writes it: one line, its line breaks as `;`. */
const commandLine = (ev: CockpitEvent): string => (ev.detail ?? ev.title).replace(/^\$ /, '').replace(/ ⏎ /g, ' ; ')

/**
 * Whether a terminal card of `width` leaves something out: a command wrapped
 * past its lines, written on several lines or cut, an output longer or wider
 * than what it shows.
 */
export const terminalHasMore = (width: number, ev: CockpitEvent): boolean => {
  const inner = width - 28
  const detail = ev.detail ?? ''
  const perCommand = Math.max(8, Math.floor((inner - 16) / (11.5 * 0.6)))
  if (commandLine(ev).length > perCommand * TERMINAL_COMMAND_LINES) return true
  if (detail.includes(' ⏎ ') || detail.endsWith('…')) return true
  if (ev.status === 'running' || ev.output === undefined || ev.output.trim() === '') return false
  const lines = ev.output.trimEnd().split('\n')
  if (lines.length > TERMINAL_TAIL) return true
  const perOutput = Math.max(8, Math.floor(inner / (11 * 0.6)))
  return lines.some(line => line.length > perOutput)
}

/**
 * A command as a terminal window over the shoulder: the prompt and command,
 * a blinking cursor while it runs, then the end of its output.
 */
export const terminalSvg = (width: number, ev: CockpitEvent, agents: readonly CockpitAgent[], now: number, app?: Badge): SvgOut => {
  const pad = 14
  const isLive = ev.status === 'running'
  const isFailed = ev.status === 'error' || ev.status === 'denied'
  const inner = width - pad * 2
  // Window chrome: dots, the call's name, its time.
  let body = `<rect width="${width}" height="HEIGHT" rx="12" fill="#1c1b19"/>`
  body += `<path d="M0 12a12 12 0 0 1 12-12h${width - 24}a12 12 0 0 1 12 12v18H0z" fill="#2a2926"/>`
  body += ['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<circle cx="${16 + i * 15}" cy="15" r="4.5" fill="${c}"/>`).join('')
  let tx = 66
  if (ev.agentId !== undefined) {
    const ah = agentColor(ev.agentId)
    const n = fitText(agentName(agents, ev.agentId), 130, 10.5)
    body += `<circle cx="${tx + 3}" cy="15" r="3" fill="${ah}"/>`
    body += text(tx + 10, 18.5, n, '', 10.5, { weight: 600, fill: ah })
    tx += measure(n, 10.5) + 20
  }
  if (app !== undefined) {
    const badge = appPill(app, tx, 5.5, 10)
    body += badge.svg
    tx += badge.width + 8
  }
  const dur = `${took(ev, now)}${ev.exitCode !== undefined && ev.exitCode !== 0 ? ` · exit ${ev.exitCode}` : ''}`
  body += text(tx, 18.5, fitText(bare(ev.title, app), width - tx - measure(dur, 10.5) - 26, 11.5), '', 11.5, { weight: 600, fill: '#e7e5e4' })
  body += text(width - pad, 18.5, dur, 'num', 10.5, { anchor: 'end', fill: isFailed ? '#f87171' : '#a8a29e' })
  let y = 44
  const lines = wrapMono(commandLine(ev), inner - 16, 11.5, TERMINAL_COMMAND_LINES)
  for (const [i, line] of lines.entries()) {
    if (i === 0) body += text(pad, y + 4, '$', 'mono', 11.5, { weight: 700, fill: '#d97757' })
    body += text(pad + 14, y + 4, line, 'mono', 11.5, { fill: '#f5f5f4' })
    y += 16
  }
  if (isLive) {
    body += `<rect x="${pad}" y="${y - 6}" width="7" height="13" fill="#d6d3d1"><animate attributeName="opacity" values="1;0;1" dur="1s" calcMode="discrete" repeatCount="indefinite"/></rect>`
    y += 14
  } else if (ev.output !== undefined && ev.output.trim() !== '') {
    y += 4
    for (const line of ev.output.trimEnd().split('\n').slice(-TERMINAL_TAIL)) {
      body += text(pad, y + 4, fitText(line, inner, 11, true), 'mono', 11, { fill: isFailed ? '#fca5a5' : '#a8a29e' })
      y += 15
    }
  } else {
    body += text(pad, y + 4, isFailed ? 'failed' : 'done, no output', 'mono', 11, { fill: isFailed ? '#fca5a5' : '#78716c' })
    y += 15
  }
  const h = y + 8
  return svgDoc(width, h, body.replace('HEIGHT', String(h)))
}

/** Any other call drawn large: its kind and state, its target, its result. */
export const nowCallSvg = (width: number, ev: CockpitEvent, agents: readonly CockpitAgent[], now: number, app?: Badge): SvgOut => {
  if (ev.cat === 'shell') return terminalSvg(width, ev, agents, now, app)
  const pad = 14
  const isLive = ev.status === 'running'
  const isFailed = ev.status === 'error' || ev.status === 'denied'
  let body = app !== undefined ? appTile(app, pad, 14, 28) : iconTile(ev.cat, pad, 14, 28)
  const word = isLive ? 'Running' : isFailed ? (ev.status === 'denied' ? 'Denied' : 'Failed') : 'Done'
  const color = isLive ? '#2563eb' : isFailed ? '#dc2626' : '#16a34a'
  const tag = pill(pad + 40, 12, `${CAT_NAME[ev.cat]} · ${word}`, color, { dot: true, pulse: isLive, size: 10.5 })
  body += tag.svg
  let x = pad + 40 + tag.width + 8
  if (app !== undefined) {
    const badge = appPill(app, x, 12)
    body += badge.svg
    x += badge.width + 8
  }
  if (ev.agentId !== undefined) {
    const ah = agentColor(ev.agentId)
    const n = fitText(agentName(agents, ev.agentId), 150, 10.5)
    body += `<circle cx="${x + 3}" cy="23" r="3" fill="${ah}"/>`
    body += text(x + 10, 26.5, n, '', 10.5, { weight: 600, fill: ah })
    x += measure(n, 10.5) + 18
  }
  body += text(width - pad, 26.5, took(ev, now), `${isFailed ? 'err' : 't3'} num`, 11, { anchor: 'end' })
  body += text(pad + 40, 52, fitText(bare(ev.title, app), width - pad - 54, 14), 't1', 14, { weight: 640 })
  let y = 62
  const inner = width - pad * 2
  if (ev.detail !== undefined && ev.detail !== '' && ev.detail !== ev.title) {
    body += text(pad + 40, y + 4, fitText(ev.detail, width - pad - 54, 11, true), 't2 mono', 11)
    y += 14
  }
  if (!isLive && isFailed && ev.output !== undefined && ev.output.trim() !== '') {
    for (const line of ev.output.trimEnd().split('\n').slice(0, 3)) {
      body += text(pad + 40, y + 8, fitText(line, width - pad - 54, 11, true), 'err mono', 11)
      y += 15
    }
  } else if (isLive) {
    body += `<rect x="${pad}" y="${y + 4}" width="${inner}" height="3" rx="1.5" class="track"/>`
    body += `<rect x="${pad}" y="${y + 4}" width="${Math.round(inner * 0.3)}" height="3" rx="1.5" fill="${HUE[ev.cat]}"><animate attributeName="x" values="${pad};${pad + inner * 0.7};${pad}" dur="1.8s" repeatCount="indefinite"/></rect>`
    y += 10
  }
  const h = y + 12
  return svgDoc(
    width,
    h,
    `<rect x=".5" y=".5" width="${width - 1}" height="${h - 1}" rx="14" class="card"/><rect x=".5" y=".5" width="4" height="${h - 1}" rx="2" fill="${color}"/>${body}`,
  )
}

/** A thin section label: "NOW", "HISTORY". */
export const sectionSvg = (width: number, label: string, aside: string, live: boolean): SvgOut => {
  let body = text(2, 15, label, 't3', 10.5, { weight: 700, extra: ' letter-spacing=".9"' })
  const lw = measure(label, 10.5) + label.length * 0.9 + 8
  if (live) body += `<circle cx="${lw + 2}" cy="11.5" r="3.5" fill="#d97757"><animate attributeName="opacity" values="1;.25;1" dur="1.4s" repeatCount="indefinite"/></circle>`
  body += `<path d="M${lw + (live ? 12 : 0)} 11.5H${width - 4 - (aside !== '' ? measure(aside, 10.5) + 10 : 0)}" class="line" stroke-width="1"/>`
  if (aside !== '') body += text(width - 2, 15, aside, 't3', 10.5, { anchor: 'end' })
  return svgDoc(width, 22, body)
}

/**
 * A subagent at work, live: the head of its card, with what it was asked and
 * how far it got. Its calls follow as native rows, so each can be unfolded.
 */
export const agentHeadSvg = (width: number, a: CockpitAgent, now: number): SvgOut => {
  const pad = 14
  const hue = agentColor(a.id)
  let body = iconTile('agent', pad, 14, 28)
  const tag = pill(pad + 40, 12, a.workflowIndex !== undefined ? `Agent #${a.workflowIndex} running` : 'Agent running', '#2563eb', { dot: true, pulse: true, size: 10.5 })
  body += tag.svg
  const meta = [a.type === 'general-purpose' ? '' : a.type, `${a.tools} calls`, fmtDur(now - a.startedAt)].filter(one => one !== '').join(' · ')
  body += text(width - pad, 25, fitText(meta, width - pad * 2 - 48 - tag.width, 11), 't3 num', 11, { anchor: 'end' })
  body += text(pad + 40, 50, fitText(a.name ?? a.description, width - pad - 54, 13.5), 't1', 13.5, { weight: 620 })
  const h = 64
  return svgDoc(
    width,
    h,
    `<rect x=".5" y=".5" width="${width - 1}" height="${h - 1}" rx="14" class="card"/><rect x=".5" y=".5" width="4" height="${h - 1}" rx="2" fill="${hue}"/>${body}`,
  )
}

export type CallRowData = {
  status: CockpitEvent['status']
  cat: CockpitCategory
  title: string
  /** After the title, in mono: the command, the change, the target. */
  target: string
  /** The change of an edit, coloured, before the target. */
  delta?: { added: number; removed: number }
  dur: string
  /** A subagent's colour, as a thin bar at the row's start. */
  agentHue?: string
  app?: Badge
  /** Unfolded, or running: the row sits on a tint. */
  isOpen: boolean
}

/** Height of a call's row, in pixels. */
export const CALL_ROW_H = 26

/**
 * One call as a drawn line: its state, its kind, what it did and how, how
 * long. The surface draws no colour inside a button, so the row is a picture
 * and the press that unfolds it sits beside it.
 */
export const callRowSvg = (width: number, r: CallRowData): SvgOut => {
  const h = CALL_ROW_H
  const isRunning = r.status === 'running'
  let body = ''
  if (r.isOpen || isRunning) body += `<rect x="0" y="1" width="${width}" height="${h - 2}" rx="7" class="sunk"/>`
  if (r.agentHue !== undefined) body += `<rect x="1" y="6" width="3" height="${h - 12}" rx="1.5" fill="${r.agentHue}"/>`
  body += statusMark(r.status, 14, h / 2, 5.5)
  body += r.app !== undefined ? appTile(r.app, 26, 5, 16) : iconTile(r.cat, 26, 5, 16)
  const tx = 50
  const durW = measure(r.dur, 10.5) + 6
  const avail = width - tx - durW - 6
  const title = fitText(r.title, r.target === '' && r.delta === undefined ? avail : Math.max(60, avail * 0.55), 12)
  body += text(tx, h / 2 + 4, title, r.status === 'error' || r.status === 'denied' ? 'err' : 't1', 12, { weight: isRunning ? 650 : 560 })
  let x = tx + measure(title, 12) + 8
  if (r.delta !== undefined) {
    const plus = `+${r.delta.added}`
    const minus = `−${r.delta.removed}`
    body += text(x, h / 2 + 4, plus, 'add num', 11, { weight: 600 })
    x += measure(`${plus} `, 11)
    body += text(x, h / 2 + 4, minus, 'del num', 11, { weight: 600 })
    x += measure(`${minus}  `, 11)
  }
  if (r.target !== '' && width - durW - 6 - x > 24)
    body += text(x, h / 2 + 4, fitText(r.target, width - durW - 6 - x, 11, true), 't3 mono', 11)
  body += text(width - 4, h / 2 + 4, r.dur, 't3 num', 10.5, { anchor: 'end' })
  return svgDoc(width, h, body)
}
