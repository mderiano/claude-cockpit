// Renders the desktop drawings from fixture data into one HTML page, light
// and dark side by side, at the pane's real width. Run:
//   npx -y tsx dev/preview.ts > /tmp/cockpit-preview.html
import type { CockpitAgent, CockpitEvent, CockpitFile, CockpitStats } from '../types'
import { EMPTY_STATS } from '../hooks/model'
import { headerSvg } from '../hooks/svg/header'
import { feedSvg } from '../hooks/svg/feed'
import { agentsSvg } from '../hooks/svg/agents'
import { filesSvg } from '../hooks/svg/files'
import { planLive, trimDiff } from '../hooks/live'
import type { Moment } from '../hooks/live'
import { screenCardSvg } from '../hooks/svg/screen'
import { agentCardSvg, compactRunSvg, fileHeadSvg, nowCallSvg, sectionSvg, workflowCardSvg } from '../hooks/svg/stream'
import type { SvgOut } from '../hooks/svg/base'
import { badgeOf, BUILTIN_APPS } from '../hooks/apps'
import type { CockpitScreen } from '../types'
import { readFileSync } from 'node:fs'

const NOW = 1_760_000_000_000
const ago = (s: number) => NOW - s * 1000
const W = Number(process.env.W ?? 500)

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
  running: 1,
  spark: [0, 1, 3, 2, 0, 0, 4, 7, 5, 2, 1, 0, 0, 2, 6, 9, 4, 3, 1, 0, 2, 5, 3, 2],
  sparkAt: Math.floor(NOW / 15000),
}

const agents: CockpitAgent[] = [
  { id: 'a1', description: 'Fix minor review findings', type: 'general-purpose', status: 'running', startedAt: ago(300), tools: 42, errors: 0, lastTool: 'Bash', lastTitle: 'Run plugin tests', lastAt: ago(4), model: 'opus', tokens: 237042 },
  { id: 'a2', description: 'Probe screen pipeline', type: 'workflow', status: 'done', startedAt: ago(1800), endedAt: ago(1500), tools: 18, errors: 0, runId: 'r1', workflowIndex: 1 },
  { id: 'a3', description: 'Probe tool results', type: 'workflow', status: 'done', startedAt: ago(1800), endedAt: ago(1400), tools: 25, errors: 1, runId: 'r1', workflowIndex: 2 },
  { id: 'a4', description: 'Build the Cockpit mod', type: 'workflow', status: 'running', startedAt: ago(1300), tools: 120, errors: 2, runId: 'r1', workflowIndex: 4, lastTool: 'Edit', lastTitle: 'register.tsx' },
  { id: 'a5', description: 'Review API correctness', type: 'workflow', status: 'failed', startedAt: ago(900), endedAt: ago(600), tools: 31, errors: 3, runId: 'r1', workflowIndex: 5 },
]

const events: CockpitEvent[] = [
  { id: 'e1', tool: 'Bash', cat: 'shell', title: 'Run plugin tests', detail: '$ cd /Volumes/Dev/Projects/claude-cockpit && claude plugin test . 2>&1 | tail -3', status: 'running', startedAt: ago(3), input: '{}', agentId: 'a1' },
  { id: 'e2', tool: 'Edit', cat: 'edit', title: 'feed.tsx', filePath: '/Volumes/Dev/Projects/claude-cockpit/hooks/ui/feed.tsx', added: 24, removed: 7, status: 'ok', startedAt: ago(20), endedAt: ago(20), input: '{}' },
  { id: 'e3', tool: 'Bash', cat: 'shell', title: 'Push minor fixes to GitHub', detail: '$ cd /Volumes/Dev/Projects/claude-cockpit && git push 2>&1 | tail -1', status: 'ok', startedAt: ago(60), endedAt: ago(58), input: '{}', output: 'd46a2a9..2a754dd  main -> main' },
  { id: 'e4', tool: 'Bash', cat: 'shell', title: 'Type-check the mod', detail: '$ npx -y -p typescript@5.6.3 tsc -p .', status: 'error', startedAt: ago(90), endedAt: ago(84), input: '{}', exitCode: 2, output: "hooks/svg/feed.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error." },
  { id: 'e5', tool: 'Grep', cat: 'search', title: 'ui.render', detail: 'hooks/ · *.tsx', status: 'ok', startedAt: ago(120), endedAt: ago(120), input: '{}', agentId: 'a4' },
  { id: 'e6', tool: 'Read', cat: 'read', title: 'register.tsx', detail: 'hooks/register.tsx:1040-1110', filePath: '/Volumes/Dev/Projects/claude-cockpit/hooks/register.tsx', status: 'ok', startedAt: ago(130), endedAt: ago(130), input: '{}', agentId: 'a4' },
  { id: 'e7', tool: 'Agent', cat: 'agent', title: 'Fix minor review findings', detail: 'general-purpose', status: 'ok', startedAt: ago(700), endedAt: ago(110), input: '{}' },
  { id: 'e8', tool: 'mcp__Claude_Browser__navigate', cat: 'browser', title: 'Open preview', detail: 'file:///tmp/cockpit-preview.html', status: 'ok', startedAt: ago(140), endedAt: ago(139), input: '{}' },
  { id: 'e9', tool: 'WebFetch', cat: 'web', title: 'docs.anthropic.com/claude-code/plugins', detail: 'Summarise the plugin manifest fields', status: 'denied', startedAt: ago(150), endedAt: ago(150), input: '{}', output: 'Permission denied by user' },
  { id: 'e10', tool: 'TodoWrite', cat: 'task', title: 'Todo list', detail: '4 tasks · 1 in progress', status: 'ok', startedAt: ago(160), endedAt: ago(160), input: '{}' },
]

const files: CockpitFile[] = [
  { path: '/Volumes/Dev/Projects/claude-cockpit/hooks/register.tsx', added: 198, removed: 64, edits: 9, firstAt: ago(2000), lastAt: ago(30), lastTool: 'Edit' },
  { path: '/Volumes/Dev/Projects/claude-cockpit/hooks/svg/feed.ts', added: 140, removed: 0, edits: 1, firstAt: ago(200), lastAt: ago(200), lastTool: 'Write', isCreated: true },
  { path: '/Volumes/Dev/Projects/claude-cockpit/README.md', added: 12, removed: 9, edits: 3, firstAt: ago(3000), lastAt: ago(600), lastTool: 'Edit' },
  { path: '/Volumes/Dev/Projects/claude-cockpit/tests/cockpit.test.ts', added: 62, removed: 14, edits: 4, firstAt: ago(2500), lastAt: ago(900), lastTool: 'Edit' },
]

const cwd = '/Volumes/Dev/Projects/claude-cockpit'
const diff = `@@ -40,7 +40,9 @@ export const feedView = (
   const { Box, Button, Text } = k
-  const showAgent = k.ui.filter === 'all'
+  const showAgent = k.ui.filter === 'all' || k.ui.filter === 'main'
+  // Output tails cost two lines a row: errors and the newest command only.
+  const newestShell = events.find(ev => ev.cat === 'shell')?.id
   const out: RenderElement[] = []
   for (const ev of events) {
     out.push(row(k, ev, agents, showAgent))
@@ -88,4 +90,4 @@ export const feedView = (
-      {older > 0 ? more : null}
+      {older > 0 ? older : null}
     </Box>`
const changes = new Map([['e2', { id: 'e2', at: ago(20), tool: 'Edit', diff, added: 24, removed: 7 }]])
const img = process.env.IMG !== undefined ? readFileSync(process.env.IMG).toString('base64') : undefined
const screen = { isLive: false, source: 'tool' as const, label: 'Claude Browser · computer', generation: 1, at: ago(5), b64: img, mime: 'image/jpeg', width: 1280, height: 800 }
const evs: CockpitEvent[] = [
  { id: 'e0', tool: 'mcp__Claude_Browser__computer', cat: 'browser', title: 'Screenshot', detail: 'localhost:4777', status: 'ok', startedAt: ago(6), endedAt: ago(5), input: '{}' },
  ...events.map(e => (e.id === 'e1' ? { ...e, agentId: undefined } : e)),
  { id: 'e11', tool: 'Workflow', cat: 'agent', title: 'build-cockpit-mod', status: 'running', startedAt: ago(1800), input: '{}' },
]
const plan = planLive({ events: evs, agents, workflows: [{ runId: 'r1', name: 'build-cockpit-mod', toolUseId: 'e11', startedAt: ago(1800) }], screen, changes, now: NOW })
const render = (m: Moment, isNow: boolean): string => {
  const one = (o: SvgOut) => `<img src="data:image/svg+xml;base64,${Buffer.from(o.source).toString('base64')}" width="${o.width}" height="${o.height}">`
  switch (m.kind) {
    case 'screen': { const c = screenCardSvg(W, screen, NOW, 420); return c ? one(c) : '<p>no frame</p>' }
    case 'call': return one(nowCallSvg(W, m.ev, agents, NOW))
    case 'agent': return one(agentCardSvg(W, m.agent, m.ev, agents, NOW))
    case 'workflow': return one(workflowCardSvg(W, m.wf, m.ev, m.agents, NOW))
    case 'run': return one(compactRunSvg(W, m.events, agents, NOW))
    case 'file': {
      const cut = m.change ? trimDiff(m.change.diff, isNow ? 40 : 10) : undefined
      const pre = cut ? `<pre class="diff">${cut.diff.split('\n').map(l => `<span class="${l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('@@') ? 'h' : ''}">${l.replace(/</g, '&lt;')}</span>`).join('\n')}</pre>` : ''
      return one(fileHeadSvg(W, m.ev, agents, cwd, NOW, m.isNew)) + pre
    }
  }
}
const live = [
  headerSvg(W, { stats, agents, files: files.length, series: stats.spark, now: NOW }),
  sectionSvg(W, 'NOW', 'working', true),
]
// The app registry at work: an app-badged command, a watched window, an asset.
const badge = (id: string) => {
  const app = BUILTIN_APPS.find(a => a.id === id)
  return app !== undefined ? badgeOf(app) : undefined
}
const blenderRun: CockpitEvent = { id: 'x1', tool: 'Bash', cat: 'shell', title: 'Blender · Render', detail: '$ blender -b scenes/shot.blend -o //renders/frame_####.png -f 12', status: 'ok', startedAt: ago(14), endedAt: ago(9), input: '{}', app: 'blender', output: 'Fra:12 Mem:182.4M | Time:00:04.21 | Rendering 64 / 64 samples\nSaved: renders/frame_0012.png\nBlender quit' }
const godotCall: CockpitEvent = { id: 'x2', tool: 'mcp__godot__run_project', cat: 'mcp', title: 'run project · res://main.tscn', detail: 'godot', status: 'running', startedAt: ago(2), input: '{}', app: 'godot' }
const assetEv: CockpitEvent = { id: 'x3', tool: 'Bash', cat: 'edit', title: 'shot.blend', filePath: `${cwd}/scenes/shot.blend`, status: 'ok', startedAt: ago(9), endedAt: ago(9), input: '', app: 'blender', added: 0, removed: 0 }
// A 2x2 checker PNG stands in for the window when no IMG is given.
const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='
const windowScreen: CockpitScreen = { isLive: false, source: 'window', label: 'Krita · untitled.kra', app: 'Krita', appColor: '#3bacd4', watch: 'Krita', generation: 3, at: ago(1), b64: img ?? tiny, mime: img !== undefined ? 'image/jpeg' : 'image/png', width: 1280, height: 800 }
const extras = [
  sectionSvg(W, 'APPS', 'registry', false),
  nowCallSvg(W, blenderRun, agents, NOW, badge('blender')),
  nowCallSvg(W, godotCall, agents, NOW, badge('godot')),
  fileHeadSvg(W, assetEv, agents, cwd, NOW, false, badge('blender'), { size: 3_355_443 }),
  compactRunSvg(W, [blenderRun, { ...godotCall, status: 'ok', endedAt: ago(1) }, events[5]!], agents, NOW, ev => (ev.app !== undefined ? badge(ev.app) : undefined)),
  screenCardSvg(W, windowScreen, NOW, 360),
].filter((o): o is SvgOut => o !== undefined)
const liveHtml = (dark: boolean) => {
  const fix = (h: string) => (dark ? h.replace(/data:image\/svg\+xml;base64,([^"]+)/g, (_, b) => `data:image/svg+xml;base64,${Buffer.from(Buffer.from(b, 'base64').toString().replace('@media (prefers-color-scheme: dark){', '@media all{')).toString('base64')}`) : h)
  const one = (o: SvgOut) => `<img src="data:image/svg+xml;base64,${Buffer.from(o.source).toString('base64')}" width="${o.width}" height="${o.height}">`
  return fix(`<div class="col ${dark ? 'dark' : 'light'}">${live.map(one).join('')}${plan.now.map(m => render(m, true)).join('')}${one(sectionSvg(W, 'HISTORY', '', false))}${plan.history.map(m => render(m, false)).join('')}${extras.map(one).join('')}</div>`)
}
process.stdout.write(`<!doctype html><meta charset="utf-8"><title>Cockpit preview</title>
<style>body{margin:0;display:flex;gap:24px;padding:24px;background:#e9e7e2;font:13px -apple-system}
.col{padding:12px;border-radius:12px;display:flex;flex-direction:column;gap:10px;width:${W}px}.light{background:#fff}.dark{background:#262624}
img{display:block}.diff{margin:0;font:11.5px ui-monospace,Menlo;line-height:1.45;padding:6px 8px;border-radius:8px;background:#f6f6f4;overflow:hidden;white-space:pre}
.dark .diff{background:#1f1e1d;color:#ddd}.diff .a{color:#15803d;background:#dcfce7;display:block}.diff .d{color:#b91c1c;background:#fee2e2;display:block}.diff .h{color:#7c3aed}
.dark .diff .a{background:#14321f;color:#86efac}.dark .diff .d{background:#3b1d1d;color:#fca5a5}</style>${liveHtml(false)}${liveHtml(true)}`)
