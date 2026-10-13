// Cockpit's screen card: the latest frame of the simulator, emulator or
// browser in a rounded frame, under a one-line caption.
import type { CockpitScreen } from '../../types'
import { fmtAgo } from '../model'
import { esc, fitText, measure, pill, svgDoc, text } from './base'
import type { SvgOut } from './base'

const SOURCE: Record<CockpitScreen['source'], string> = {
  none: 'Screen',
  ios: 'iOS Simulator',
  android: 'Android',
  tool: 'Browser',
}

/** The source's name; a tool frame says which tool took it. */
export const sourceName = (s: CockpitScreen): string => {
  if (s.source !== 'tool') return SOURCE[s.source]
  if (/simulator/i.test(s.label)) return 'iOS Simulator'
  if (/browser|chrome/i.test(s.label)) return 'Browser'
  if (/computer/i.test(s.label)) return 'Desktop'
  return 'Browser'
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
  const tag = pill(pad, 11, sourceName(s), '#0d9488', { dot: true, pulse: live })
  body += tag.svg
  const age = fmtAgo(s.at, now)
  const right = `${s.isLive ? 'Live · ' : ''}${age === '' ? '' : age === 'now' ? 'just now' : `${age} ago`}`
  body += text(width - pad, 25, right, 't3 num', 11, { anchor: 'end' })
  const label = s.label.replace(/^Claude Browser · |^claude-in-chrome · /i, '')
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
