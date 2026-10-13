// Cockpit's files list: each file Claude changed, with a balance bar of what
// it added and removed. The diffs themselves are drawn by the engine's Code.
import type { CockpitFile } from '../../types'
import { basename, dirname, fmtAgo, shortPath } from '../model'
import { esc, fitText, measure, svgDoc, text } from './base'
import type { SvgOut } from './base'

export type FilesSvgData = {
  files: readonly CockpitFile[]
  now: number
  cwd: string
  selected?: string
}

const EXT_HUE: Record<string, string> = {
  ts: '#2563eb', tsx: '#2563eb', js: '#ca8a04', jsx: '#ca8a04', json: '#78716c', md: '#57534e',
  py: '#0891b2', swift: '#ea580c', kt: '#7c3aed', css: '#db2777', html: '#ea580c', sh: '#16a34a',
}

export const filesSvg = (width: number, d: FilesSvgData): SvgOut => {
  const pad = 12
  const tile = 30
  const textX = pad + tile + 12
  const barW = 54
  let y = 4
  let body = ''
  const sorted = [...d.files].sort((a, b) => b.lastAt - a.lastAt)
  const maxChange = Math.max(1, ...sorted.map(f => f.added + f.removed))
  for (const [i, f] of sorted.entries()) {
    const name = basename(f.path)
    const ext = (name.includes('.') ? name.split('.').pop() ?? '' : '').toLowerCase()
    const hue = EXT_HUE[ext] ?? '#78716c'
    const isSel = d.selected === f.path
    const h = 50
    let row = `<g class="row"><title>${esc(`${f.path}\n+${f.added} −${f.removed} · ${f.edits} change${f.edits === 1 ? '' : 's'} · last by ${f.lastTool}`)}</title>`
    row += `<rect x="4" y="${y}" width="${width - 8}" height="${h - 2}" rx="10" class="hov"/>`
    if (isSel) row += `<rect x="4.5" y="${y + 0.5}" width="${width - 9}" height="${h - 3}" rx="10" fill="none" stroke="#d97757" stroke-width="1.2"/>`
    row += `<rect x="${pad}" y="${y + 9}" width="${tile}" height="${tile}" rx="8" fill="${hue}" fill-opacity=".12"/>`
    row += text(pad + tile / 2, y + 28, fitText(ext === '' ? '·' : ext.toUpperCase(), tile - 4, 9.5), '', 9.5, { anchor: 'middle', weight: 700, fill: hue })
    const right = `+${f.added} −${f.removed}`
    const rightW = Math.max(barW, measure(right, 11)) + 8
    const label = f.isCreated === true ? 'new' : f.edits > 1 ? `×${f.edits}` : ''
    const labelW = label !== '' ? measure(label, 10.5) + 14 : 0
    const shownName = fitText(name, width - textX - rightW - labelW - 16, 13)
    row += text(textX, y + 22, shownName, 't1', 13, { weight: 580 })
    if (label !== '') {
      const lx = textX + measure(shownName, 13) + 8
      row += `<rect x="${lx.toFixed(1)}" y="${y + 11}" width="${(labelW - 4).toFixed(1)}" height="15" rx="7.5" class="sunk"/>`
      row += text(lx + (labelW - 4) / 2, y + 22, label, 't2', 10.5, { anchor: 'middle', weight: 600 })
    }
    const dir = dirname(f.path)
    const where = dir === '' || dir === d.cwd ? './' : `${shortPath(dir, d.cwd, 80)}/`
    const when = fmtAgo(f.lastAt, d.now)
    row += text(textX, y + 39, fitText(`${where}${when !== '' ? `  ·  ${when === 'now' ? 'just now' : `${when} ago`}` : ''}`, width - textX - rightW - 16, 11), 't3', 11)
    // Right: +/- counts over a balance bar scaled to the busiest file.
    const rx = width - pad
    const plus = `+${f.added}`
    row += text(rx - measure(` −${f.removed}`, 11), y + 22, plus, 'add num', 11, { anchor: 'end', weight: 600 })
    row += text(rx, y + 22, `−${f.removed}`, 'del num', 11, { anchor: 'end', weight: 600 })
    const total = (f.added + f.removed) / maxChange
    const fullW = Math.max(6, barW * Math.sqrt(total))
    const addW = f.added + f.removed > 0 ? (fullW * f.added) / (f.added + f.removed) : 0
    row += `<rect x="${rx - barW}" y="${y + 31}" width="${barW}" height="5" rx="2.5" class="track"/>`
    if (addW > 0) row += `<rect x="${(rx - barW).toFixed(1)}" y="${y + 31}" width="${addW.toFixed(1)}" height="5" rx="2.5" class="add"/>`
    if (fullW - addW > 0.5) row += `<rect x="${(rx - barW + addW).toFixed(1)}" y="${y + 31}" width="${(fullW - addW).toFixed(1)}" height="5" rx="2.5" class="del"/>`
    row += `</g>`
    body += row
    y += h
    if (i < sorted.length - 1) body += `<path d="M${textX} ${y - 1}h${width - textX - pad}" class="line" stroke-width="1"/>`
  }
  if (sorted.length === 0) {
    body += text(width / 2, y + 22, 'No files changed yet', 't2', 12.5, { anchor: 'middle', weight: 560 })
    body += text(width / 2, y + 40, 'Edits and new files show up here with their diffs.', 't3', 11, { anchor: 'middle' })
    y += 56
  }
  return svgDoc(width, y + 4, body)
}
