// Cockpit's SVG kit: tokens, text measuring and icons the desktop drawings
// share. Pure functions from data to markup; nothing here touches `$`.
import type { CockpitAgentStatus, CockpitCategory, CockpitStatus } from '../../types'

/** CSS pixels per terminal cell on the desktop, measured off its pane. */
export const PX_PER_CELL = 7.3

export const SANS = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif`
export const MONO = `'SF Mono', ui-monospace, Menlo, 'JetBrains Mono', Consolas, monospace`

/**
 * The palette, light first; the dark side is a stylesheet override so the
 * drawing follows the app's theme. Classes carry every colour, so one rule
 * flips the whole picture.
 */
export const THEME_CSS = `
.bg{fill:#ffffff}.card{fill:#ffffff;stroke:#e7e5e4}.sunk{fill:#f5f5f4}.line{stroke:#e7e5e4}
.t1{fill:#1c1917}.t2{fill:#57534e}.t3{fill:#a8a29e}.acc{fill:#d97757}.accs{stroke:#d97757}
.ok{fill:#16a34a}.oks{stroke:#16a34a}.err{fill:#dc2626}.errs{stroke:#dc2626}.errbg{fill:#fef2f2}
.warn{fill:#ea580c}.warns{stroke:#ea580c}.run{fill:#2563eb}.runs{stroke:#2563eb}
.add{fill:#16a34a}.del{fill:#dc2626}.track{fill:#f0efed}.hov{fill:transparent}
.row:hover .hov{fill:#f5f5f4}
@media (prefers-color-scheme: dark){
.bg{fill:#262624}.card{fill:#262624;stroke:#3a3936}.sunk{fill:#1f1e1d}.line{stroke:#3a3936}
.t1{fill:#f5f4ef}.t2{fill:#c2c0b6}.t3{fill:#87857d}.errbg{fill:#3b1d1d}.track{fill:#33322f}
.ok{fill:#4ade80}.oks{stroke:#4ade80}.err{fill:#f87171}.errs{stroke:#f87171}.run{fill:#60a5fa}.runs{stroke:#60a5fa}
.add{fill:#4ade80}.del{fill:#f87171}.row:hover .hov{fill:#2f2e2b}
}
text{font-family:${SANS}}.mono{font-family:${MONO}}.num{font-variant-numeric:tabular-nums}
`

/** One hue per category, used for the icon tile alone. */
export const HUE: Record<CockpitCategory, string> = {
  shell: '#d97706',
  edit: '#16a34a',
  read: '#2563eb',
  search: '#7c3aed',
  web: '#0891b2',
  agent: '#db2777',
  browser: '#0d9488',
  mcp: '#4f46e5',
  task: '#ea580c',
  other: '#78716c',
}

/** What each category is called where a word helps (tooltips, legends). */
export const CAT_NAME: Record<CockpitCategory, string> = {
  shell: 'Shell',
  edit: 'Edit',
  read: 'Read',
  search: 'Search',
  web: 'Web',
  agent: 'Agent',
  browser: 'Screen',
  mcp: 'MCP',
  task: 'Tasks',
  other: 'Tool',
}

/** A small stable palette for agents, picked by a hash of the id. */
const AGENT_HUES = ['#db2777', '#7c3aed', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#4f46e5']
export const agentColor = (id: string): string => {
  let n = 0
  for (let i = 0; i < id.length; i += 1) n = (n * 31 + id.charCodeAt(i)) >>> 0
  return AGENT_HUES[n % AGENT_HUES.length] ?? '#db2777'
}

export const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Rough advance of a string in pixels: good enough to cut before a clip. */
export const measure = (text: string, size: number, mono = false): number => {
  if (mono) return text.length * size * 0.6
  let w = 0
  for (const ch of text) {
    if (/[ilj.,:;'|!`]/.test(ch)) w += 0.28
    else if (/[mwMW@%]/.test(ch)) w += 0.85
    else if (/[A-Z0-9#&]/.test(ch)) w += 0.66
    else if (ch === ' ') w += 0.28
    else if (ch.charCodeAt(0) > 0x2e7f) w += 1
    else w += 0.53
  }
  // Semibold faces run wider than the table: err toward room.
  return w * size * 1.06
}

/** Cuts `text` with an ellipsis so it fits `px` at `size`. */
export const fitText = (text: string, px: number, size: number, mono = false): string => {
  if (px <= 0) return ''
  if (measure(text, size, mono) <= px) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(`${text.slice(0, mid)}…`, size, mono) <= px) lo = mid
    else hi = mid - 1
  }
  return lo === 0 ? '' : `${text.slice(0, lo).trimEnd()}…`
}

export type SvgOut = { source: string; width: number; height: number }

/** The document around a drawing: its viewBox, the theme and its defs. */
export const svgDoc = (width: number, height: number, body: string, defs = ''): SvgOut => ({
  width,
  height,
  source:
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${THEME_CSS}</style>` +
    (defs !== '' ? `<defs>${defs}</defs>` : '') +
    body +
    `</svg>`,
})

export const text = (
  x: number,
  y: number,
  value: string,
  cls: string,
  size: number,
  opts: { weight?: number; anchor?: 'start' | 'middle' | 'end'; fill?: string; extra?: string } = {},
): string =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}" font-size="${size}"` +
  (opts.weight !== undefined ? ` font-weight="${opts.weight}"` : '') +
  (opts.anchor !== undefined && opts.anchor !== 'start' ? ` text-anchor="${opts.anchor}"` : '') +
  (opts.fill !== undefined ? ` fill="${opts.fill}"` : '') +
  (opts.extra ?? '') +
  `>${esc(value)}</text>`

// ---------------------------------------------------------------- icons
/** 16×16 stroke icons, drawn at (0,0); `stroke` colours them. */
const ICON_PATHS: Record<CockpitCategory, string> = {
  shell: '<path d="M3 4.5l3.5 3.5L3 11.5"/><path d="M8.5 12h4.5"/>',
  edit: '<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/><path d="M9.3 4.2l2.5 2.5"/>',
  read: '<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5.2h3.4"/><path d="M6 8.5h4.5M6 11h3"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.6 3.6"/>',
  web: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z"/>',
  agent: '<rect x="3" y="5" width="10" height="8" rx="2.4"/><path d="M8 5V2.6"/><circle cx="8" cy="2.2" r=".6"/><path d="M6 9h.01M10 9h.01" stroke-width="2"/>',
  browser: '<rect x="2" y="2.8" width="12" height="8.6" rx="1.6"/><path d="M5.5 14h5M8 11.4V14"/>',
  mcp: '<path d="M6 2v3.2M10 2v3.2"/><path d="M4.2 5.2h7.6v2.6a3.8 3.8 0 0 1-7.6 0z"/><path d="M8 11.6V14"/>',
  task: '<path d="M2.8 4.2l1.2 1.2 2-2.2M2.8 9.2l1.2 1.2 2-2.2"/><path d="M8 4.5h5.2M8 9.5h5.2M8 13h5.2"/>',
  other: '<path d="M8 2.5l1.5 4 4 1.5-4 1.5L8 13.5 6.5 9.5l-4-1.5 4-1.5z"/>',
}

/** The category's icon in a tinted rounded tile of `size` px. */
export const iconTile = (cat: CockpitCategory, x: number, y: number, size = 26): string => {
  const hue = HUE[cat]
  const s = size / 16
  const inset = (size - 16 * s * 0.62) / 2
  return (
    `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
    `<rect width="${size}" height="${size}" rx="${(size * 0.28).toFixed(1)}" fill="${hue}" fill-opacity=".12"/>` +
    `<g transform="translate(${inset.toFixed(1)} ${inset.toFixed(1)}) scale(${(s * 0.62).toFixed(3)})" fill="none" stroke="${hue}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[cat]}</g>` +
    `</g>`
  )
}

/** An app as the drawings know it: its name, colour and glyph. */
export type Badge = { name: string; color: string; glyph: string }

/** A colour the markup may carry as is (the registry's are user-written). */
const safeColor = (c: string): string => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#64748b')

/** The app's glyph in a tile of its colour, where the category icon would be. */
export const appTile = (app: Badge, x: number, y: number, size = 26): string => {
  const color = safeColor(app.color)
  const glyph = [...app.glyph].slice(0, 3).join('')
  const fs = size * (glyph.length <= 1 ? 0.56 : glyph.length === 2 ? 0.44 : 0.34)
  return (
    `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
    `<rect width="${size}" height="${size}" rx="${(size * 0.28).toFixed(1)}" fill="${color}" fill-opacity=".16"/>` +
    text(size / 2, size / 2 + fs * 0.36, glyph, '', fs, { weight: 760, anchor: 'middle', fill: color }) +
    `</g>`
  )
}

/** The app's badge: a pill of its colour with its name. */
export const appPill = (app: Badge, x: number, y: number, size = 10.5): { svg: string; width: number } =>
  pill(x, y, app.name, safeColor(app.color), { size })

/** A status mark centred on (cx, cy): spinner, check, cross or slash. */
export const statusMark = (status: CockpitStatus | CockpitAgentStatus, cx: number, cy: number, r = 7): string => {
  const at = `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`
  if (status === 'running')
    return (
      `<g transform="${at}"><circle r="${r - 1}" fill="none" class="line" stroke-width="2"/>` +
      `<path d="M0 ${-(r - 1)} A ${r - 1} ${r - 1} 0 0 1 ${r - 1} 0" fill="none" class="runs" stroke-width="2" stroke-linecap="round">` +
      `<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.9s" repeatCount="indefinite"/></path></g>`
    )
  if (status === 'ok' || status === 'done')
    return `<g transform="${at}"><circle r="${r}" class="ok" fill-opacity=".14"/><path d="M${-r * 0.42} 0l${r * 0.3} ${r * 0.32} ${r * 0.56}-${r * 0.62}" fill="none" class="oks" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>`
  if (status === 'idle')
    return `<g transform="${at}"><circle r="${r - 1}" fill="none" class="line" stroke-width="2" stroke-dasharray="2 2.5"/></g>`
  if (status === 'error' || status === 'failed')
    return `<g transform="${at}"><circle r="${r}" class="err" fill-opacity=".14"/><path d="M${-r * 0.32} ${-r * 0.32}l${r * 0.64} ${r * 0.64}M${r * 0.32} ${-r * 0.32}l${-r * 0.64} ${r * 0.64}" class="errs" stroke-width="1.7" stroke-linecap="round"/></g>`
  return `<g transform="${at}"><circle r="${r}" class="warn" fill-opacity=".14"/><path d="M${-r * 0.4} 0h${r * 0.8}" class="warns" stroke-width="1.8" stroke-linecap="round"/></g>`
}

/** A pill: a rounded tint with a word, returns markup and its width. */
export const pill = (
  x: number,
  y: number,
  label: string,
  color: string,
  opts: { size?: number; dot?: boolean; pulse?: boolean } = {},
): { svg: string; width: number } => {
  const size = opts.size ?? 11
  const padX = 7
  const dotW = opts.dot === true ? 10 : 0
  const w = Math.ceil(measure(label, size) + padX * 2 + dotW)
  const h = size + 9
  const dot =
    opts.dot === true
      ? `<circle cx="${(x + padX + 3).toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" r="3" fill="${color}">` +
        (opts.pulse === true
          ? `<animate attributeName="opacity" values="1;.25;1" dur="1.4s" repeatCount="indefinite"/>`
          : '') +
        `</circle>`
      : ''
  return {
    width: w,
    svg:
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="${h / 2}" fill="${color}" fill-opacity=".12"/>` +
      dot +
      text(x + padX + dotW, y + h / 2 + size * 0.36, label, '', size, { weight: 600, fill: color }),
  }
}
