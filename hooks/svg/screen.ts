// Cockpit's screen card: the latest frame (simulator, emulator, browser, an
// app's window, an image a tool returned or a command wrote) in a rounded
// frame, under a one-line caption naming where it comes from.
import type { CockpitScreen } from '../../types'
import { fmtAgo } from '../model'
import { esc, fitText, measure, pill, svgDoc, text } from './base'
import type { SvgOut } from './base'

const SOURCE: Record<CockpitScreen['source'], string> = {
  none: 'Screen',
  ios: 'iOS Simulator',
  android: 'Android',
  tool: 'Tool',
  file: 'Image',
  window: 'Window',
}

/** The source's name: the app when known, else what a tool frame's label says. */
export const sourceName = (s: CockpitScreen): string => {
  if (s.app !== undefined && s.app !== '') return s.app
  if (s.source !== 'tool') return SOURCE[s.source]
  if (/simulator/i.test(s.label)) return 'iOS Simulator'
  if (/browser|chrome/i.test(s.label)) return 'Browser'
  if (/computer/i.test(s.label)) return 'Desktop'
  return 'Tool'
}

/** The caption after the name: the label without the name it starts with. */
export const sourceDetail = (s: CockpitScreen): string => {
  const name = sourceName(s)
  if (s.label.startsWith(`${name} · `)) return s.label.slice(name.length + 3)
  if (s.label === name) return ''
  return s.label.replace(/^Claude Browser · |^claude-in-chrome · /i, '')
}

export const screenCardSvg = (width: number, s: CockpitScreen, now: number, maxH: number): SvgOut | undefined => {
  if (s.b64 === undefined) return undefined
  const pad = 12
  const fw = s.width ?? 1280
  const fh = s.height ?? 800
  const innerW = width - pad * 2
  const scale = Math.min(innerW / fw, Math.max(120, maxH - 52) / fh)
  const w = Math.round(fw * scale)
  const h = Math.round(fh * scale)
  const x = Math.round((width - w) / 2)
  const top = 40
  let body = `<rect x=".5" y=".5" width="${width - 1}" height="${top + h + pad - 1}" rx="14" class="card"/>`
  const live = s.isLive || s.isBusy === true
  const color = s.appColor !== undefined && /^#[0-9a-f]{3,8}$/i.test(s.appColor) ? s.appColor : '#0d9488'
  const tag = pill(pad, 11, sourceName(s), color, { dot: true, pulse: live || s.watch !== undefined })
  body += tag.svg
  const age = fmtAgo(s.at, now)
  const right = `${s.isLive ? 'Live · ' : s.watch !== undefined ? 'Watching · ' : ''}${age === '' ? '' : age === 'now' ? 'just now' : `${age} ago`}`
  body += text(width - pad, 25, right, 't3 num', 11, { anchor: 'end' })
  const label = sourceDetail(s)
  body += text(pad + tag.width + 8, 25, fitText(label, width - pad * 2 - tag.width - 8 - measure(right, 11) - 10, 11.5), 't2', 11.5)
  const r = Math.max(6, Math.round(Math.min(w, h) * 0.035))
  body +=
    `<clipPath id="frame"><rect x="${x}" y="${top}" width="${w}" height="${h}" rx="${r}"/></clipPath>` +
    `<rect x="${x}" y="${top}" width="${w}" height="${h}" rx="${r}" class="sunk"/>` +
    `<image href="data:${s.mime ?? 'image/jpeg'};base64,${s.b64}" x="${x}" y="${top}" width="${w}" height="${h}" clip-path="url(#frame)" preserveAspectRatio="xMidYMid meet"/>` +
    `<rect x="${x + 0.5}" y="${top + 0.5}" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" class="line" stroke-width="1"/>`
  const out = svgDoc(width, top + h + pad, body)
  return { ...out, source: out.source.replace('<svg ', `<svg aria-label="${esc(sourceName(s))}" `) }
}
