// Cockpit's screen card: one frame (a simulator, an emulator, a browser, an
// app's window, an image a tool returned or a command wrote) in a calm
// rounded card. The picture alone: its caption (where it comes from, how old)
// is native text above it, so the card's source changes only with the frame.
import type { CockpitFrame, CockpitScreen } from '../../types'
import { esc, svgDoc } from './base'
import type { SvgOut } from './base'

const SOURCE: Record<CockpitScreen['source'], string> = {
  none: 'Screen',
  ios: 'iOS Simulator',
  android: 'Android',
  tool: 'Tool',
  file: 'Image',
  window: 'Window',
}

/** What a caption needs of a frame or of the single screen. */
type Captioned = { source: CockpitScreen['source']; label: string; app?: string }

/** The source's name: the app when known, else what a tool frame's label says. */
export const sourceName = (s: Captioned): string => {
  if (s.app !== undefined && s.app !== '') return s.app
  if (s.source !== 'tool') return SOURCE[s.source]
  if (/simulator/i.test(s.label)) return 'iOS Simulator'
  if (/browser|chrome/i.test(s.label)) return 'Browser'
  if (/computer/i.test(s.label)) return 'Desktop'
  return 'Tool'
}

/** The caption after the name: the label without the name it starts with. */
export const sourceDetail = (s: Captioned): string => {
  const name = sourceName(s)
  if (s.label.startsWith(`${name} · `)) return s.label.slice(name.length + 3)
  if (s.label === name) return ''
  return s.label.replace(/^Claude Browser · |^claude-in-chrome · /i, '')
}

/** A frame's colour: its app's, else the screen's teal. */
export const frameColor = (f: { appColor?: string }): string =>
  f.appColor !== undefined && /^#[0-9a-f]{3,8}$/i.test(f.appColor) ? f.appColor : '#0d9488'

/** Whether a frame is taller than wide (a phone). */
export const isPortrait = (f: { width?: number; height?: number }): boolean =>
  f.width !== undefined && f.height !== undefined && f.height > f.width

/**
 * The frame in a card at most `maxW` wide and `maxH` tall. `fill`: the card
 * takes the whole width and centres the picture (a frame under NOW); else
 * the card hugs the picture (a smaller one in the history).
 */
export const frameCardSvg = (
  f: Pick<CockpitFrame, 'b64' | 'mime' | 'width' | 'height' | 'source' | 'label' | 'app'>,
  maxW: number,
  maxH: number,
  fill: boolean,
): SvgOut => {
  const pad = 8
  const fw = f.width ?? 1280
  const fh = f.height ?? 800
  // A small picture grows twice its size at most: an icon is not blown up to the card.
  const scale = Math.min(2, (maxW - pad * 2) / fw, Math.max(60, maxH - pad * 2) / fh)
  const w = Math.max(1, Math.round(fw * scale))
  const h = Math.max(1, Math.round(fh * scale))
  const width = fill ? Math.round(maxW) : w + pad * 2
  const height = h + pad * 2
  const x = Math.round((width - w) / 2)
  const r = Math.max(5, Math.round(Math.min(w, h) * 0.035))
  const body =
    `<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="12" class="card"/>` +
    `<clipPath id="frame"><rect x="${x}" y="${pad}" width="${w}" height="${h}" rx="${r}"/></clipPath>` +
    `<rect x="${x}" y="${pad}" width="${w}" height="${h}" rx="${r}" class="sunk"/>` +
    `<image href="data:${f.mime};base64,${f.b64}" x="${x}" y="${pad}" width="${w}" height="${h}" clip-path="url(#frame)" preserveAspectRatio="xMidYMid meet"/>` +
    `<rect x="${x + 0.5}" y="${pad + 0.5}" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" class="line" stroke-width="1"/>`
  const out = svgDoc(width, height, body)
  return { ...out, source: out.source.replace('<svg ', `<svg aria-label="${esc(sourceName(f))}" `) }
}
