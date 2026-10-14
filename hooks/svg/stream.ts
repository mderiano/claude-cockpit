// Cockpit's live stream, the drawn parts: compact runs of small calls, agent
// and workflow cards, and the head of a file change (its diff is the
// engine's own Code, drawn under it).
import type { CockpitAgent, CockpitCategory, CockpitEvent, CockpitWorkflow } from '../../types'
import { basename, dirname, fmtAgo, fmtBytes, fmtCount, fmtDur, shortPath } from '../model'
import { agentColor, appPill, appTile, CAT_NAME, esc, fitText, HUE, iconTile, measure, pill, statusMark, svgDoc, text } from './base'
import type { Badge, SvgOut } from './base'
import { agentName } from './feed'

const took = (ev: CockpitEvent, now: number): string =>
  ev.status === 'running' ? fmtDur(Math.max(0, now - ev.startedAt)) : fmtDur((ev.endedAt ?? ev.startedAt) - ev.startedAt)

/** A title without the app's name it starts with, when a badge already says it. */
const bare = (title: string, app: Badge | undefined): string =>
  app !== undefined && title.startsWith(`${app.name} · `) ? title.slice(app.name.length + 3) : title

const ago = (at: number, now: number): string => {
  const a = fmtAgo(at, now)
  return a === '' ? '' : a === 'now' ? 'now' : `${a} ago`
}

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

/** How many rows of a run of small calls stay visible. */
export const COMPACT_ROWS = 3

/**
 * A run of small calls (commands, reads, searches): one summary line, then
 * the newest few as single lines. Everything else stays in the tooltip.
 */
export const compactRunSvg = (
  width: number,
  events: readonly CockpitEvent[],
  agents: readonly CockpitAgent[],
  now: number,
  appOf: (ev: CockpitEvent) => Badge | undefined = () => undefined,
): SvgOut => {
  const pad = 12
  let body = ''
  // Summary: counts by kind, each with its tiny tile.
  const counts = new Map<CockpitCategory, number>()
  for (const ev of events) counts.set(ev.cat, (counts.get(ev.cat) ?? 0) + 1)
  let x = pad
  const failed = events.filter(ev => ev.status === 'error' || ev.status === 'denied').length
  for (const [cat, n] of counts) {
    const [one, many] = NOUN[cat] ?? ['call', 'calls']
    const label = `${n} ${n === 1 ? one : many}`
    const w = 18 + measure(label, 11.5) + 14
    if (x + w > width - pad - 60) break
    body += iconTile(cat, x, 6, 16)
    body += text(x + 21, 18.5, label, 't2', 11.5, { weight: 560 })
    x += w
  }
  const last = events[0]
  const right = failed > 0 ? `${failed} failed` : last !== undefined ? ago(last.startedAt, now) : ''
  body += text(width - pad, 18.5, right, failed > 0 ? 'err' : 't3 num', 11, { anchor: 'end', weight: failed > 0 ? 600 : 400 })
  let y = 30
  // The newest few, one line each; a failed one shows its first error line.
  const shown = events.slice(0, COMPACT_ROWS)
  for (const ev of shown) {
    const errLine =
      (ev.status === 'error' || ev.status === 'denied') && ev.output !== undefined
        ? (ev.output.split('\n').find(l => l.trim() !== '') ?? '').trim()
        : ''
    const h = errLine !== '' ? 38 : 22
    const tip = `${CAT_NAME[ev.cat]} · ${ev.tool} · ${took(ev, now)}${ev.agentId !== undefined ? `\n${agentName(agents, ev.agentId)}` : ''}${ev.detail !== undefined ? `\n\n${ev.detail.replace(/ ⏎ /g, '\n').slice(0, 600)}` : ''}${ev.output !== undefined && ev.output.trim() !== '' ? `\n\n${ev.output.trimEnd().split('\n').slice(-10).join('\n').slice(-800)}` : ''}`
    body += `<g class="row"><title>${esc(tip)}</title><rect x="4" y="${y}" width="${width - 8}" height="${h}" rx="7" class="hov"/>`
    body += statusMark(ev.status, pad + 6, y + 11, 5.5)
    const isShell = ev.cat === 'shell' && ev.detail !== undefined
    const main = isShell ? (ev.detail ?? '').replace(/^\$ /, '').replace(/ ⏎ /g, ' ; ') : bare(ev.title, appOf(ev))
    let tx = pad + 20
    if (ev.agentId !== undefined) {
      const hue = agentColor(ev.agentId)
      body += `<circle cx="${tx + 3}" cy="${y + 11}" r="3" fill="${hue}"/>`
      tx += 11
    }
    const app = appOf(ev)
    if (app !== undefined) {
      const badge = appPill(app, tx, y + 3, 9.5)
      body += badge.svg
      tx += badge.width + 6
    }
    const dur = took(ev, now)
    const avail = width - tx - pad - measure(dur, 10.5) - 10
    if (isShell && ev.title !== '' && !main.startsWith(ev.title)) {
      const t = fitText(bare(ev.title, appOf(ev)), avail * 0.45, 12)
      body += text(tx, y + 15, t, 't1', 12, { weight: 540 })
      const tw = measure(t, 12) + 8
      body += text(tx + tw, y + 15, fitText(main, avail - tw, 11, true), 't3 mono', 11)
    } else body += text(tx, y + 15, fitText(main, avail, isShell ? 11 : 12, isShell), isShell ? 't2 mono' : 't1', isShell ? 11 : 12, { weight: isShell ? 400 : 540 })
    body += text(width - pad, y + 15, dur, 't3 num', 10.5, { anchor: 'end' })
    if (errLine !== '') body += text(pad + 20, y + 31, fitText(errLine, width - pad * 2 - 20, 10.5, true), 'err mono', 10.5)
    body += `</g>`
    y += h
  }
  if (events.length > shown.length) {
    body += text(pad + 20, y + 13, `+ ${events.length - shown.length} more — hover a line for its output`, 't3', 10.5)
    y += 18
  }
  return svgDoc(width, y + 4, body)
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
  const tip = `${title}${a?.answer !== undefined ? `\n\n${a.answer.slice(0, 700)}` : ''}${a?.tokens !== undefined ? `\n\n${fmtCount(a.tokens)} tokens` : ''}`
  void agents
  return svgDoc(width, h, `<g><title>${esc(tip)}</title>${body}</g>`)
}

/** A workflow run's card: its name, a segment per agent, the live ones listed. */
export const workflowCardSvg = (width: number, wf: CockpitWorkflow | undefined, ev: CockpitEvent, list: readonly CockpitAgent[], now: number): SvgOut => {
  const pad = 14
  const sorted = [...list].sort((a, b) => (a.workflowIndex ?? 0) - (b.workflowIndex ?? 0))
  const live = sorted.filter(a => a.status === 'running')
  const done = sorted.filter(a => a.status === 'done' || a.status === 'idle').length
  const fails = sorted.filter(a => a.status === 'failed' || a.status === 'killed').length
  let body = ''
  body += `<g transform="translate(${pad} 14)"><rect width="28" height="28" rx="8" fill="#7c3aed" fill-opacity=".12"/>` +
    `<path d="M7 14h4l2-5 3 10 2-5h3" fill="none" stroke="#7c3aed" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>`
  const isLive = live.length > 0 || ev.status === 'running'
  const tag = pill(pad + 40, 12, isLive ? 'Workflow running' : fails > 0 ? 'Workflow finished with errors' : 'Workflow finished', isLive ? '#7c3aed' : fails > 0 ? '#dc2626' : '#16a34a', { dot: true, pulse: isLive, size: 10.5 })
  body += tag.svg
  const meta = `${done}/${sorted.length} done${fails > 0 ? ` · ${fails} failed` : ''} · ${fmtDur((ev.endedAt ?? now) - ev.startedAt)}`
  body += text(width - pad, 25, meta, 't3 num', 11, { anchor: 'end' })
  body += text(pad + 40, 50, fitText(wf?.name ?? ev.title, width - pad - 54, 13.5), 't1', 13.5, { weight: 620 })
  let y = 62
  if (sorted.length > 0) {
    const inner = width - pad * 2
    const gap = 3
    const seg = Math.max(3, (inner - gap * (sorted.length - 1)) / sorted.length)
    for (const [i, a] of sorted.entries()) {
      const fill = a.status === 'done' || a.status === 'idle' ? '#16a34a' : a.status === 'running' ? '#7c3aed' : a.status === 'failed' || a.status === 'killed' ? '#dc2626' : '#a8a29e'
      body += `<rect x="${(pad + i * (seg + gap)).toFixed(1)}" y="${y}" width="${seg.toFixed(1)}" height="6" rx="3" fill="${fill}" fill-opacity="${a.status === 'running' ? '.5' : '.85'}">` +
        (a.status === 'running' ? `<animate attributeName="fill-opacity" values=".3;.85;.3" dur="1.6s" repeatCount="indefinite"/>` : '') +
        `<title>${esc(`#${a.workflowIndex ?? i + 1} ${a.name ?? a.description} · ${a.status}`)}</title></rect>`
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
  return svgDoc(width, 72, `<g><title>${esc(path)}</title>${body}</g>`)
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
  const command = (ev.detail ?? ev.title).replace(/^\$ /, '').replace(/ ⏎ /g, ' ; ')
  const lines = wrapMono(command, inner - 16, 11.5, 4)
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
    for (const line of ev.output.trimEnd().split('\n').slice(-8)) {
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
