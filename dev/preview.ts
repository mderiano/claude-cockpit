// Renders the desktop live view from fixture data into one HTML page, at the
// pane's real width: the view's own tree (hooks/ui/live.tsx) through a mock
// kit, its drawings as images and its native elements (rows, buttons, Code)
// as plain HTML. Light and dark side by side, then the same with things
// unfolded (ONLY=light|dark|unfolded draws one of them). Run:
//   npx -y tsx dev/preview.ts > /tmp/cockpit-preview.html
import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

import type { CockpitAgent, CockpitChange, CockpitEvent, CockpitFrame, CockpitScreen, CockpitStats, CockpitUi, CockpitWorkflow } from '../types'
import { badgeOf, BUILTIN_APPS } from '../hooks/apps'
import { planLive } from '../hooks/live'
import { EMPTY_SCREEN, EMPTY_STATS, EMPTY_UI } from '../hooks/model'
import { PX_PER_CELL } from '../hooks/svg/base'
import type { Kit } from '../hooks/ui/kit'
import { liveView } from '../hooks/ui/live'

const NOW = 1_760_000_000_000
const ago = (s: number) => NOW - s * 1000
const COLUMNS = Number(process.env.COLUMNS ?? 72)
const ROWS = 48

// ---------------------------------------------------------------- the JSX factory the engine provides
type Node = { type: string; props: Record<string, unknown>; children: unknown[] }
const flat = (children: unknown[]): unknown[] => children.flat(Infinity as 1).filter(c => c !== null && c !== undefined && c !== false && c !== '')
;(globalThis as unknown as { h: unknown }).h = (tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]) =>
  typeof tag === 'function' ? (tag as (p: unknown) => unknown)({ ...(props ?? {}), children: flat(children) }) : { type: String(tag), props: props ?? {}, children: flat(children) }
const element = (type: string) => (props: Record<string, unknown>): Node => ({ type, props, children: flat([props.children ?? []]) })

// ---------------------------------------------------------------- pictures: tiny PNGs drawn here
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
type Rect = [x: number, y: number, w: number, h: number, rgb: [number, number, number]]
/** A PNG of `w`×`h` filled with `bg`, then the rectangles painted in order. */
const png = (w: number, h: number, bg: [number, number, number], rects: Rect[]): string => {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x += 1) {
      let rgb = bg
      for (const [rx, ry, rw, rh, c] of rects) if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) rgb = c
      raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
const phone = (accent: [number, number, number]): string =>
  png(150, 326, [250, 250, 250], [
    [0, 0, 150, 34, accent],
    [12, 50, 126, 14, [226, 226, 230]],
    ...Array.from({ length: 7 }, (_, i): Rect => [12, 78 + i * 30, 126, 20, i % 2 === 0 ? [236, 236, 240] : [244, 244, 246]]),
    [55, 296, 40, 10, accent],
  ])
const browser = png(320, 200, [255, 255, 255], [
  [0, 0, 320, 22, [232, 232, 236]],
  [24, 44, 180, 18, [30, 30, 36]],
  [24, 74, 272, 8, [200, 200, 206]],
  [24, 90, 240, 8, [200, 200, 206]],
  [24, 120, 120, 40, [217, 119, 87]],
  [160, 120, 136, 40, [226, 232, 240]],
])
const img = process.env.IMG !== undefined ? readFileSync(process.env.IMG).toString('base64') : undefined

// ---------------------------------------------------------------- the fixture
const cwd = '/Volumes/Dev/Projects/claude-cockpit'
const stats: CockpitStats = {
  ...EMPTY_STATS,
  startedAt: ago(39 * 60),
  calls: 91,
  commands: 75,
  errors: 1,
  added: 412,
  removed: 87,
  turns: 5,
  isWorking: true,
  running: 2,
  spark: [0, 1, 3, 2, 0, 0, 4, 7, 5, 2, 1, 0, 0, 2, 6, 9, 4, 3, 1, 0, 2, 5, 3, 2],
  sparkAt: Math.floor(NOW / 15000),
}
const agents: CockpitAgent[] = [
  { id: 'a1', description: 'Fix minor review findings', type: 'general-purpose', status: 'running', startedAt: ago(300), tools: 42, errors: 0, lastTool: 'Bash', lastTitle: 'Run plugin tests', lastAt: ago(4), toolUseId: 'e7' },
  { id: 'a2', description: 'Probe screen pipeline', type: 'workflow', status: 'done', startedAt: ago(1800), endedAt: ago(1500), tools: 18, errors: 0, runId: 'r1', workflowIndex: 1 },
  { id: 'a4', description: 'Build the Cockpit mod', type: 'workflow', status: 'running', startedAt: ago(1300), tools: 120, errors: 2, runId: 'r1', workflowIndex: 4, lastTool: 'Edit', lastTitle: 'register.tsx', lastAt: ago(8) },
  { id: 'a5', description: 'Review API correctness', type: 'workflow', status: 'failed', startedAt: ago(900), endedAt: ago(600), tools: 31, errors: 3, runId: 'r1', workflowIndex: 5 },
]
const workflows: CockpitWorkflow[] = [{ runId: 'r1', name: 'build-cockpit-mod', toolUseId: 'e11', startedAt: ago(1800) }]
const cmd = (id: string, title: string, command: string, over: Partial<CockpitEvent> = {}): CockpitEvent => ({
  id,
  tool: 'Bash',
  cat: 'shell',
  title,
  detail: `$ ${command.replace(/\n/g, ' ⏎ ')}`,
  status: 'ok',
  startedAt: ago(60),
  endedAt: ago(58),
  input: JSON.stringify({ command, description: title }, null, 2),
  ...over,
})
const events: CockpitEvent[] = [
  cmd('e1', 'Run plugin tests', 'cd /Volumes/Dev/Projects/claude-cockpit && claude plugin test . 2>&1 | tail -3', { status: 'running', startedAt: ago(3), endedAt: undefined, agentId: 'a1' }),
  cmd('e0', 'Type-check the mod', 'npx -y -p typescript@5.6.3 tsc -p .', { status: 'running', startedAt: ago(6), endedAt: undefined }),
  { id: 'e5', tool: 'Grep', cat: 'search', title: '/ui.render/', detail: 'hooks/', status: 'ok', startedAt: ago(20), endedAt: ago(20), input: '{}', agentId: 'a1' },
  { id: 'e2', tool: 'Edit', cat: 'edit', title: 'feed.tsx', filePath: `${cwd}/hooks/ui/feed.tsx`, added: 24, removed: 7, status: 'ok', startedAt: ago(30), endedAt: ago(30), input: '{}' },
  cmd('e3', 'Push minor fixes to GitHub', 'git push 2>&1 | tail -1', { startedAt: ago(70), endedAt: ago(68), output: 'To github.com:mderiano/claude-cockpit.git\n   d46a2a9..2a754dd  main -> main' }),
  { id: 'e6', tool: 'Read', cat: 'read', title: 'register.tsx :1040+70', detail: `${cwd}/hooks/register.tsx`, status: 'ok', startedAt: ago(80), endedAt: ago(80), input: '{}' },
  cmd('e4', 'Type-check the mod', 'npx -y -p typescript@5.6.3 tsc -p .', {
    status: 'error',
    startedAt: ago(90),
    endedAt: ago(84),
    exitCode: 2,
    output: "hooks/svg/feed.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.",
  }),
  { id: 'e8', tool: 'mcp__Claude_Browser__navigate', cat: 'browser', title: 'navigate · localhost:4777', detail: 'Claude Browser', status: 'ok', startedAt: ago(100), endedAt: ago(99), input: '{}' },
  { id: 'e9', tool: 'WebFetch', cat: 'web', title: 'docs.anthropic.com/claude-code/plugins', detail: 'Summarise the plugin manifest fields', status: 'denied', startedAt: ago(110), endedAt: ago(110), input: '{}', output: 'Permission denied by user' },
  { id: 'e10', tool: 'TodoWrite', cat: 'task', title: 'Todo list', status: 'ok', startedAt: ago(120), endedAt: ago(120), input: '{}' },
  ...Array.from({ length: 6 }, (_, i): CockpitEvent => ({ id: `g${i}`, tool: 'Glob', cat: 'search', title: `hooks/**/*.ts${'x'.repeat(i % 2)}`, status: 'ok', startedAt: ago(130 + i), endedAt: ago(130 + i), input: '{}' })),
  { id: 'x3', tool: 'Bash', cat: 'edit', title: 'shot.blend', filePath: `${cwd}/scenes/shot.blend`, status: 'ok', startedAt: ago(200), endedAt: ago(200), input: '', app: 'blender', added: 0, removed: 0 },
  cmd('x1', 'Blender · Render', 'blender -b scenes/shot.blend -o //renders/frame_####.png -f 12', {
    startedAt: ago(205),
    endedAt: ago(200),
    app: 'blender',
    output: 'Fra:12 Mem:182.4M | Time:00:04.21 | Rendering 64 / 64 samples\nSaved: renders/frame_0012.png\nBlender quit',
  }),
  { id: 'e11', tool: 'Workflow', cat: 'agent', title: 'build-cockpit-mod', status: 'ok', startedAt: ago(1800), endedAt: ago(1799), input: '{}' },
]
const diff = `@@ -40,7 +40,23 @@ export const feedView = (
   const { Box, Button, Text } = k
-  const showAgent = k.ui.filter === 'all'
+  const showAgent = k.ui.filter === 'all' || k.ui.filter === 'main'
+  // Output tails cost two lines a row: errors and the newest command only.
+  const newestShell = events.find(ev => ev.cat === 'shell')?.id
   const out: RenderElement[] = []
   for (const ev of events) {
     out.push(row(k, ev, agents, showAgent))
${Array.from({ length: 14 }, (_, i) => `+  // added line ${i}`).join('\n')}
`
const changes = new Map<string, CockpitChange>([
  ['e2', { id: 'e2', at: ago(30), tool: 'Edit', diff, added: 24, removed: 7 }],
  ['x3', { id: 'x3', at: ago(200), tool: 'Bash', diff: '', added: 0, removed: 0, isBinary: true, size: 3_355_443 }],
])
const frames: CockpitFrame[] = [
  { key: 'ios:A', source: 'ios', label: 'iPhone 17 Pro', b64: phone([37, 99, 235]), mime: 'image/png', width: 150, height: 326, at: ago(1) },
  { key: 'ios:B', source: 'ios', label: 'iPhone Air', b64: phone([22, 163, 74]), mime: 'image/png', width: 150, height: 326, at: ago(1) },
  {
    key: 'tool:Claude_Browser',
    source: 'tool',
    label: 'Claude Browser · computer',
    b64: img ?? browser,
    mime: img !== undefined ? 'image/jpeg' : 'image/png',
    width: img !== undefined ? 1280 : 320,
    height: img !== undefined ? 800 : 200,
    at: ago(99),
    eventId: 'e8',
    app: 'Claude Browser',
    appColor: '#0d9488',
  },
]
const screen: CockpitScreen = { ...EMPTY_SCREEN, isLive: true }
const plan = planLive({ events, agents, workflows, frames, changes, now: NOW, isLive: true, isWorking: true })

// ---------------------------------------------------------------- the kit, its tree as HTML
const kit = (ui: CockpitUi): Kit => ({
  Box: element('Box') as unknown as Kit['Box'],
  Text: element('Text') as unknown as Kit['Text'],
  Button: element('Button') as unknown as Kit['Button'],
  Code: element('Code') as unknown as Kit['Code'],
  Svg: element('Svg') as unknown as Kit['Svg'],
  surface: 'desktop',
  W: COLUMNS - 6,
  H: ROWS,
  now: NOW,
  cwd,
  ui,
  act: { setUi: () => undefined, toggleLive: () => undefined, capture: () => undefined },
  apps: new Map(BUILTIN_APPS.map(a => [a.id, badgeOf(a)])),
})
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const CELL = PX_PER_CELL
const css = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
const toHtml = (node: unknown, dark: boolean): string => {
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node))
  if (Array.isArray(node)) return node.map(n => toHtml(n, dark)).join('')
  if (typeof node !== 'object' || node === null) return ''
  const { type, props, children } = node as Node
  const inner = children.map(c => toHtml(c, dark)).join('')
  const p = props as Record<string, unknown>
  switch (type) {
    case 'Box': {
      const isRow = p.flexDirection === 'row'
      const gap = isRow ? Number(p.columnGap ?? 0) * CELL : Number(p.rowGap ?? 0) * 8
      return `<div style="${css({
        display: 'flex',
        'flex-direction': isRow ? 'row' : 'column',
        gap: gap > 0 ? `${gap}px` : undefined,
        'padding-left': p.paddingLeft !== undefined ? `${Number(p.paddingLeft) * CELL}px` : undefined,
        'margin-top': p.marginTop !== undefined ? `${Number(p.marginTop) * 6}px` : undefined,
        'margin-bottom': p.marginBottom !== undefined ? `${Number(p.marginBottom) * 6}px` : undefined,
      })}">${inner}</div>`
    }
    case 'Text':
      return `<span class="${p.dimColor === true ? 'dim' : ''}" style="${css({
        color: typeof p.color === 'string' ? p.color : undefined,
        'font-weight': p.bold === true ? 650 : undefined,
        'font-style': p.italic === true ? 'italic' : undefined,
      })}">${inner}</span>`
    case 'Button': {
      const label = inner !== '' ? inner : esc(String(p.label ?? ''))
      return p.plain === true
        ? `<div class="line${p.dimColor === true ? ' dim' : ''}">${label}</div>`
        : `<span class="button${p.variant === 'primary' ? ' primary' : ''}">${label}</span>`
    }
    case 'Code': {
      const source = String(p.source ?? '')
      if (p.format !== 'diff') return `<pre class="code">${esc(source)}</pre>`
      const lines = source.replace(/\n$/, '').split('\n')
      const cls = (l: string) => (l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('@@') ? 'h' : '')
      return `<pre class="code diff">${lines.map(l => `<span class="${cls(l)}">${esc(l) || ' '}</span>`).join('')}</pre>`
    }
    case 'Svg': {
      let source = String(p.source ?? '')
      // The dark column: the drawing's own dark palette, as the app's theme would pick it.
      if (dark) source = source.replace('@media (prefers-color-scheme: dark){', '@media all{')
      return `<img src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}" width="${String(p.width)}" height="${String(p.height)}">`
    }
  }
  return inner
}

const px = Math.max(240, Math.floor((COLUMNS - 2) * PX_PER_CELL))
const view = (ui: CockpitUi, dark: boolean, title: string): string => {
  const tree = liveView(kit(ui), { plan, stats, agents, files: 4, series: stats.spark, screen, px, roomPx: ROWS * 19 })
  return `<div class="col ${dark ? 'dark' : 'light'}"><div class="title">${esc(title)}</div>${toHtml(tree, dark)}</div>`
}
const run = plan.history.find(m => m.kind === 'run' && m.events.length > 3)
const runKey = run !== undefined && run.kind === 'run' ? `run:${run.events[run.events.length - 1]?.id ?? ''}` : ''
const folded: CockpitUi = { ...EMPTY_UI, open: [] }
const unfolded: CockpitUi = { ...EMPTY_UI, open: ['call:e4', 'diff:e2', 'call:e3', runKey] }
process.stdout.write(`<!doctype html><meta charset="utf-8"><title>Cockpit preview</title>
<style>
body{margin:0;display:flex;gap:24px;padding:24px;background:#e9e7e2;font:13px -apple-system,BlinkMacSystemFont,sans-serif;align-items:flex-start}
.col{padding:12px ${CELL}px;border-radius:12px;width:${px}px;flex:none}.light{background:#fff;color:#1c1917}.dark{background:#262624;color:#f5f4ef}
.title{font:600 11px -apple-system;letter-spacing:.06em;text-transform:uppercase;opacity:.45;margin:0 0 8px 4px}
img{display:block}.dim{opacity:.55}
.line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:20px;cursor:pointer;border-radius:5px;padding:0 2px}
.button{display:inline-block;border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:2px 9px;font-size:12px}.button.primary{background:#d97757;color:#fff;border-color:#d97757}
.code{margin:2px 0;font:11.5px ui-monospace,Menlo,monospace;line-height:1.45;padding:6px 8px;border-radius:8px;background:#f6f6f4;white-space:pre-wrap;overflow:hidden}
.dark .code{background:#1f1e1d;color:#ddd}.diff{white-space:pre}.diff span{display:block}.diff .a{color:#15803d;background:#dcfce7}.diff .d{color:#b91c1c;background:#fee2e2}.diff .h{color:#7c3aed}
.dark .diff .a{background:#14321f;color:#86efac}.dark .diff .d{background:#3b1d1d;color:#fca5a5}
</style>${[
  ['light', view(folded, false, 'Light')],
  ['dark', view(folded, true, 'Dark')],
  ['unfolded', view(unfolded, false, 'Unfolded')],
]
  // ONLY=light|dark|unfolded draws one column, for a closer look.
  .filter(([name]) => process.env.ONLY === undefined || process.env.ONLY === name)
  .map(([, html]) => html)
  .join('')}`)
