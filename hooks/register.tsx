// Cockpit: a live, colourful view of what Claude is doing.
//
// This file holds every hook and every call on `$` (the engine follows `$`
// only within one file). Everything it calls in other files is pure: parsing
// (capture.ts), diffs (diff.ts), device listings and image headers
// (screen.ts), and the views (ui/*.tsx).
//
// Every observer passes its event through untouched (`return next(e)`, or
// the very result `next` gave) and swallows its own failures, with a
// `.catch` that replays `next`: watching can never block or change a call.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type {
  CockpitAgent,
  CockpitChange,
  CockpitEvent,
  CockpitFeedRef,
  CockpitFile,
  CockpitScreen,
  CockpitStats,
  CockpitStatus,
  CockpitTab,
} from '../types'
import {
  agentAnswer,
  AGENT_STATUS,
  agentStatusOf,
  bumpSpark,
  changesOf,
  describe,
  dueMilestones,
  num,
  obj,
  outputOf,
  statusLine,
  str,
  tokensOf,
  touchesDevice,
  upsertAgent,
} from './capture'
import type { FileChange } from './capture'
import { renderHunks } from './diff'
import {
  basename,
  categorize,
  clean,
  clip,
  EMPTY_SCREEN,
  EMPTY_STATS,
  EMPTY_UI,
  isScreenTool,
  MAX_CHANGES_PER_FILE,
  MAX_DIFF,
  MAX_EVENTS,
  MAX_FILES,
  MAX_SVG_B64,
  MAX_WORKFLOWS,
  PANE,
  prettyInput,
} from './model'
import { findImages, firstErrorLine, imageSize, parseAdb, parseSimctl } from './screen'
import type { Device } from './screen'
import { agentRefs, agentsView } from './ui/agents'
import { feedView, visibleRefs } from './ui/feed'
import { filesView, selectedFile } from './ui/files'
import { footer, header, tabs } from './ui/header'
import type { CockpitActions, Kit } from './ui/kit'
import { screenView } from './ui/screen'

type $T = EngineInterface

// ================================================================ state
const feedAtom = atom({ plugin: 'cockpit', key: 'feed' } as const, [])
const filesAtom = atom({ plugin: 'cockpit', key: 'files' } as const, [])
const agentsAtom = atom({ plugin: 'cockpit', key: 'agents' } as const, [])
const workflowsAtom = atom({ plugin: 'cockpit', key: 'workflows' } as const, [])
const statsAtom = atom({ plugin: 'cockpit', key: 'stats' } as const, EMPTY_STATS)
const uiAtom = atom({ plugin: 'cockpit', key: 'ui' } as const, EMPTY_UI)
const screenAtom = atom({ plugin: 'cockpit', key: 'screen' } as const, EMPTY_SCREEN)
const nowAtom = atom({ plugin: 'cockpit', key: 'now' } as const, 0)
const surfaceAtom = atom({ plugin: 'cockpit', key: 'surface' } as const, '')
const tmpAtom = atom({ plugin: 'cockpit', key: 'tmp' } as const, '')

const quiet = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // observability never breaks the session
  }
}

// ================================================================ write queues
/**
 * One writer per hot atom: changes pushed while a write is in flight are
 * folded into the next single compare-and-set, so fifty parallel agents make
 * a handful of writes instead of thousands of retries. Each caller resolves
 * once the batch holding its change is written. Lost on reload with the
 * module, which at worst drops one batch of counters: fine for a viewer.
 */
type Batch<T> = { changes: ((value: T) => T)[]; done: Promise<void>; resolve: () => void }
type Queue<T> = { open?: Batch<T>; isDraining: boolean }

/** Adds a change to the queue's open batch; resolves once that batch is written. */
const enqueue = <T,>(q: Queue<T>, change: (value: T) => T): Promise<void> => {
  if (q.open === undefined) {
    let resolve: () => void = () => undefined
    const done = new Promise<void>(r => {
      resolve = r
    })
    q.open = { changes: [], done, resolve }
  }
  q.open.changes.push(change)
  return q.open.done
}

/** Takes the open batch (or nothing) and its changes folded into one. */
const takeBatch = <T,>(q: Queue<T>): { fold: (value: T) => T; resolve: () => void } | undefined => {
  const batch = q.open
  if (batch === undefined) return undefined
  q.open = undefined
  return { fold: value => batch.changes.reduce((acc, change) => change(acc), value), resolve: batch.resolve }
}

const statsQueue: Queue<CockpitStats> = { isDraining: false }
const feedQueue: Queue<CockpitFeedRef[]> = { isDraining: false }
const agentsQueue: Queue<CockpitAgent[]> = { isDraining: false }
const filesQueue: Queue<CockpitFile[]> = { isDraining: false }

const drainStats = async ($: $T): Promise<void> => {
  if (statsQueue.isDraining) return
  statsQueue.isDraining = true
  try {
    for (let b = takeBatch(statsQueue); b !== undefined; b = takeBatch(statsQueue)) {
      const { fold, resolve } = b
      await quiet(() => update($, statsAtom, fold))
      resolve()
    }
  } finally {
    statsQueue.isDraining = false
  }
}
const drainFeed = async ($: $T): Promise<void> => {
  if (feedQueue.isDraining) return
  feedQueue.isDraining = true
  try {
    for (let b = takeBatch(feedQueue); b !== undefined; b = takeBatch(feedQueue)) {
      const { fold, resolve } = b
      await quiet(() => update($, feedAtom, fold))
      resolve()
    }
  } finally {
    feedQueue.isDraining = false
  }
}
const drainAgents = async ($: $T): Promise<void> => {
  if (agentsQueue.isDraining) return
  agentsQueue.isDraining = true
  try {
    for (let b = takeBatch(agentsQueue); b !== undefined; b = takeBatch(agentsQueue)) {
      const { fold, resolve } = b
      await quiet(() => update($, agentsAtom, fold))
      resolve()
    }
  } finally {
    agentsQueue.isDraining = false
  }
}
const drainFiles = async ($: $T): Promise<void> => {
  if (filesQueue.isDraining) return
  filesQueue.isDraining = true
  try {
    for (let b = takeBatch(filesQueue); b !== undefined; b = takeBatch(filesQueue)) {
      const { fold, resolve } = b
      await quiet(() => update($, filesAtom, fold))
      resolve()
    }
  } finally {
    filesQueue.isDraining = false
  }
}

const statsQ = ($: $T, change: (value: CockpitStats) => CockpitStats): Promise<void> => {
  const done = enqueue(statsQueue, change)
  void drainStats($)
  return done
}
const feedQ = ($: $T, change: (value: CockpitFeedRef[]) => CockpitFeedRef[]): Promise<void> => {
  const done = enqueue(feedQueue, change)
  void drainFeed($)
  return done
}
const agentsQ = ($: $T, change: (value: CockpitAgent[]) => CockpitAgent[]): Promise<void> => {
  const done = enqueue(agentsQueue, change)
  void drainAgents($)
  return done
}
const filesQ = ($: $T, change: (value: CockpitFile[]) => CockpitFile[]): Promise<void> => {
  const done = enqueue(filesQueue, change)
  void drainFiles($)
  return done
}

// Module state that only paces work (lost on reload together with the timers).
let ticker: { cancel: () => void } | undefined
let tickCount = 0
let isTicking = false
let isCapturing = false
let lastStatus = ''

// ================================================================ screen capture
/** Where frames are written: $TMPDIR, never the plugin's (watched) folder. */
const tmpBase = async ($: $T): Promise<string> => {
  const known = await read($, tmpAtom)
  if (known !== '') return known
  let dir = '/tmp/'
  try {
    dir = (await $.env.get('TMPDIR')) ?? '/tmp/'
  } catch {
    dir = '/tmp/'
  }
  if (!dir.endsWith('/')) dir = `${dir}/`
  const base = `${dir}cockpit-${Math.random().toString(36).slice(2, 8)}-`
  await $.state.set({ plugin: 'cockpit', key: 'tmp' }, base)
  return base
}

const setScreen = ($: $T, change: (s: CockpitScreen) => CockpitScreen) => update($, screenAtom, change)

const findDevice = async ($: $T): Promise<Device | undefined> => {
  try {
    const r = await $.process.run(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs: 10_000 })
    const sim = r.exitCode === 0 ? parseSimctl(r.stdout) : undefined
    if (sim !== undefined) return sim
  } catch {
    // no Xcode: try Android
  }
  const candidates = ['adb']
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined) candidates.push(`${home}/Library/Android/sdk/platform-tools/adb`)
    const sdk = await $.env.get('ANDROID_HOME')
    if (sdk !== undefined) candidates.push(`${sdk}/platform-tools/adb`)
  } catch {
    // the PATH alone
  }
  for (const adb of candidates) {
    try {
      const r = await $.process.run([adb, 'devices'], { timeoutMs: 8000 })
      if (r.exitCode === 0) return parseAdb(r.stdout, adb)
    } catch {
      continue
    }
  }
  return undefined
}

/** A PNG on disk shrunk to a JPEG that fits an Svg source, read back as base64. */
const toSvgFrame = async ($: $T, png: string, jpg: string): Promise<{ b64: string; width?: number; height?: number }> => {
  for (const [size, quality] of [
    ['800', '55'],
    ['560', '40'],
  ] as const) {
    const r = await $.process.run(
      ['sips', '-Z', size, '-s', 'format', 'jpeg', '-s', 'formatOptions', quality, png, '--out', jpg],
      { timeoutMs: 15_000 },
    )
    if (r.exitCode !== 0) throw new Error(firstErrorLine(r.stderr || r.stdout) || 'sips failed')
    const { base64 } = await $.fs.read(jpg, { as: 'bytes' })
    if (base64.length <= MAX_SVG_B64) {
      const dims = imageSize(base64)
      return { b64: base64, width: dims?.width, height: dims?.height }
    }
  }
  throw new Error('image trop grande même compressée')
}

/** One frame of the booted simulator / emulator into the screen state. */
const captureDevice = async ($: $T): Promise<void> => {
  if (isCapturing) return
  isCapturing = true
  try {
    await setScreen($, s => ({ ...s, isBusy: true }))
    const base = await tmpBase($)
    const png = `${base}device.png`
    const jpg = `${base}device.jpg`
    const device = await findDevice($)
    if (device === undefined) {
      await setScreen($, s => ({
        ...s,
        isBusy: false,
        error: s.source === 'tool' ? undefined : 'Aucun simulateur iOS ni émulateur Android démarré.',
      }))
      return
    }
    let label: string
    if (device.kind === 'ios') {
      const r = await $.process.run(['xcrun', 'simctl', 'io', device.udid, 'screenshot', '--type=png', png], {
        timeoutMs: 15_000,
      })
      if (r.exitCode !== 0) throw new Error(firstErrorLine(r.stderr || r.stdout) || `simctl a échoué (${r.exitCode})`)
      label = clean(device.name)
    } else {
      const remote = '/sdcard/cockpit-frame.png'
      const shot = await $.process.run([device.adb, '-s', device.serial, 'shell', 'screencap', '-p', remote], {
        timeoutMs: 15_000,
      })
      if (shot.exitCode !== 0) throw new Error(firstErrorLine(shot.stderr || shot.stdout) || 'screencap a échoué')
      const pull = await $.process.run([device.adb, '-s', device.serial, 'pull', remote, png], { timeoutMs: 15_000 })
      if (pull.exitCode !== 0) throw new Error(firstErrorLine(pull.stderr || pull.stdout) || 'adb pull a échoué')
      label = `Android ${device.serial}`
    }
    const frame = await toSvgFrame($, png, jpg)
    const at = await $.clock.now()
    await setScreen($, s => ({
      ...s,
      source: device.kind,
      label,
      b64: frame.b64,
      mime: 'image/jpeg',
      width: frame.width,
      height: frame.height,
      pngPath: png,
      generation: s.generation + 1,
      at,
      error: undefined,
      isBusy: false,
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await quiet(() => setScreen($, s => ({ ...s, isBusy: false, error: clean(message).slice(0, 200) })))
  } finally {
    isCapturing = false
  }
}

/** Whether the terminal draws this session (its `Image` reads PNG files). */
const drawsOnTerminal = async ($: $T): Promise<boolean> => {
  try {
    const surfaces = await $.session.surfaces()
    if (surfaces.length > 0) return surfaces.includes('terminal')
  } catch {
    // fall back on what session.start / session.attach recorded
  }
  return (await read($, surfaceAtom)) === 'terminal'
}

/**
 * A screenshot a tool returned: kept when small, else shrunk to a JPEG for
 * the Svg surfaces; on the terminal, a PNG file its `Image` reads whole (the
 * decoded file itself when the tool already sent a PNG).
 */
const takeToolImage = async ($: $T, image: { data: string; mime: string }, label: string): Promise<void> => {
  try {
    const at = await $.clock.now()
    const isTerminal = await drawsOnTerminal($)
    const isPng = image.mime === 'image/png'
    const needsShrink = image.data.length > MAX_SVG_B64
    // A small PNG draws from its base64 on the terminal; anything else as a file.
    const needsFile = isTerminal && (!isPng || needsShrink)
    let b64 = image.data
    let mime = image.mime
    let pngPath: string | undefined
    if (needsShrink || needsFile) {
      const base = await tmpBase($)
      const ext = isPng ? 'png' : image.mime === 'image/webp' ? 'webp' : image.mime === 'image/gif' ? 'gif' : 'jpg'
      const raw = `${base}tool-raw.${ext}`
      const decode = await $.process.run(['base64', '-D', '-o', raw], { stdin: image.data, timeoutMs: 15_000 })
      if (decode.exitCode !== 0) throw new Error(firstErrorLine(decode.stderr) || 'décodage base64 impossible')
      if (needsFile && isPng) pngPath = raw
      else if (needsFile) {
        const png = `${base}tool.png`
        const r = await $.process.run(['sips', '-s', 'format', 'png', raw, '--out', png], { timeoutMs: 15_000 })
        if (r.exitCode === 0) pngPath = png
      }
      if (needsShrink) {
        const frame = await toSvgFrame($, raw, `${base}tool.jpg`)
        b64 = frame.b64
        mime = 'image/jpeg'
      }
    }
    const dims = imageSize(b64)
    await setScreen($, s => ({
      ...s,
      source: 'tool',
      label,
      b64,
      mime,
      width: dims?.width,
      height: dims?.height,
      pngPath,
      generation: s.generation + 1,
      at,
      error: undefined,
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await quiet(() => setScreen($, s => ({ ...s, error: `Capture d’outil: ${clean(message).slice(0, 160)}` })))
  }
}

const toggleLive = async ($: $T): Promise<void> => {
  const next = await update($, screenAtom, s => ({ ...s, isLive: !s.isLive }))
  if (next.isLive) await captureDevice($)
}

// ================================================================ status, milestones, ticker
const refreshStatus = async ($: $T): Promise<void> => {
  const stats = await read($, statsAtom)
  const files = await read($, filesAtom)
  const agents = await read($, agentsAtom)
  const text = statusLine(stats, files.length, agents)
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

const celebrate = async ($: $T, key: string, text: string): Promise<void> => {
  let isNew = false
  await statsQ($, s => {
    isNew = !s.milestones.includes(key)
    return isNew ? { ...s, milestones: [...s.milestones, key] } : s
  })
  if (isNew) $.ui.toast(text, { timeoutMs: 5000 })
}

const checkMilestones = async ($: $T): Promise<void> => {
  const stats = await read($, statsAtom)
  const agents = await read($, agentsAtom)
  const files = await read($, filesAtom)
  for (const m of dueMilestones(stats, agents.length, files.length)) await celebrate($, m.key, m.text)
}

const markNow = async ($: $T, now: number): Promise<void> => {
  await $.state.set({ plugin: 'cockpit', key: 'now' }, now)
}

/** Once a second: the clock for elapsed times, live capture, agent statuses. */
const tick = async ($: $T): Promise<void> => {
  if (isTicking) return
  isTicking = true
  tickCount += 1
  try {
    const panes = await $.ui.panes()
    if (!panes.some(p => p.id === PANE && p.isShown && p.isPlaced)) return
    const stats = await read($, statsAtom)
    const agents = await read($, agentsAtom)
    const ui = await read($, uiAtom)
    const isBusy = stats.running > 0 || stats.isWorking || agents.some(a => a.status === 'running')
    if (isBusy || tickCount % 10 === 0) await markNow($, await $.clock.now())
    if (ui.tab === 'screen' && tickCount % 2 === 0) {
      const screen = await read($, screenAtom)
      if (screen.isLive) void captureDevice($)
    }
    if (tickCount % 5 === 0 && agents.some(a => a.status === 'running' || a.status === 'idle')) {
      const listed = await $.agent.list()
      const byId = new Map(listed.map(one => [one.id, one.status as string]))
      const now = await $.clock.now()
      await agentsQ($, list =>
        list.map((a): CockpitAgent => {
          const seen = byId.get(a.id)
          const status = seen !== undefined ? AGENT_STATUS[seen] : undefined
          if (status === undefined || status === a.status) return a
          const isEnd = status === 'done' || status === 'failed' || status === 'killed'
          return { ...a, status, endedAt: isEnd ? (a.endedAt ?? now) : undefined }
        }),
      )
    }
  } catch {
    // keep ticking
  } finally {
    isTicking = false
  }
}

const ensureTicker = ($: $T): void => {
  if (ticker !== undefined) return
  try {
    ticker = $.clock.every(1000, () => void tick($))
  } catch {
    ticker = undefined
  }
}

// ================================================================ tool calls
const onToolStart = async ($: $T, e: ToolCallInput): Promise<CockpitEvent> => {
  const now = await $.clock.now()
  const input = e as unknown as Record<string, unknown>
  const tool = String(e.tool)
  const d = describe(input)
  const ev: CockpitEvent = {
    id: e.tool_use_id,
    tool,
    cat: categorize(tool),
    title: clip(clean(d.title), 200),
    detail: d.detail !== undefined ? clip(clean(d.detail), 400) : undefined,
    agentId: e.agentId,
    status: 'running',
    startedAt: now,
    input: prettyInput(input),
    filePath: d.filePath !== undefined ? clean(d.filePath) : undefined,
    isTest: d.isTest,
    isBackground: d.isBackground,
  }
  await $.state.set({ plugin: 'cockpit', key: 'event', id: ev.id }, ev)
  let evicted: string[] = []
  await feedQ($, list => {
    const next = [
      ...list.filter(one => one.id !== ev.id),
      e.agentId !== undefined ? { id: ev.id, agent: e.agentId } : { id: ev.id },
    ]
    evicted = next.slice(0, Math.max(0, next.length - MAX_EVENTS)).map(one => one.id)
    return next.slice(-MAX_EVENTS)
  })
  for (const id of evicted) await $.state.set({ plugin: 'cockpit', key: 'event', id }, null)
  await statsQ($, s => ({
    ...s,
    startedAt: s.startedAt === 0 ? now : s.startedAt,
    calls: s.calls + 1,
    commands: s.commands + (tool === 'Bash' ? 1 : 0),
    running: s.running + 1,
    ...bumpSpark(s, now),
  }))
  if (e.agentId !== undefined) {
    const agentId = e.agentId
    await agentsQ($, list =>
      upsertAgent(list, agentId, now, a => ({
        ...a,
        status: a.status === 'idle' ? 'running' : a.status,
        tools: a.tools + 1,
        lastTool: tool,
        lastTitle: ev.title,
        lastAt: now,
      })),
    )
  }
  // No write of `now` here: the ticker owns the clock the pane draws with.
  return ev
}

const recordChanges = async (
  $: $T,
  ev: CockpitEvent,
  changes: readonly FileChange[],
  now: number,
): Promise<{ added: number; removed: number }> => {
  let added = 0
  let removed = 0
  for (const change of changes) {
    if (change.path === '') continue
    const text = renderHunks(change.hunks, MAX_DIFF)
    added += text.added
    removed += text.removed
    const entry: CockpitChange = {
      id: ev.id,
      at: now,
      tool: ev.tool,
      agentId: ev.agentId,
      diff: text.diff,
      added: text.added,
      removed: text.removed,
      isTruncated: text.isTruncated ? true : undefined,
    }
    await update($, { plugin: 'cockpit', key: 'changes', id: change.path }, list =>
      [...(list ?? []).filter(one => one.id !== entry.id), entry].slice(-MAX_CHANGES_PER_FILE),
    )
    let evicted: string[] = []
    await filesQ($, list => {
      const prev = list.find(f => f.path === change.path)
      const file: CockpitFile = {
        path: change.path,
        added: (prev?.added ?? 0) + text.added,
        removed: (prev?.removed ?? 0) + text.removed,
        edits: (prev?.edits ?? 0) + 1,
        firstAt: prev?.firstAt ?? now,
        lastAt: now,
        lastTool: ev.tool,
        lastAgent: ev.agentId,
        isCreated: prev?.isCreated ?? change.isCreated,
      }
      const next = [file, ...list.filter(f => f.path !== change.path)]
      evicted = next.slice(MAX_FILES).map(f => f.path)
      return next.slice(0, MAX_FILES)
    })
    for (const path of evicted) await $.state.set({ plugin: 'cockpit', key: 'changes', id: path }, null)
  }
  return { added, removed }
}

const onToolEnd = async ($: $T, e: ToolCallInput, ev: CockpitEvent, r: ToolCallResult): Promise<void> => {
  const now = await $.clock.now()
  const input = e as unknown as Record<string, unknown>
  const tool = ev.tool
  const status: CockpitStatus = r.deny !== undefined ? 'denied' : r.isError === true ? 'error' : 'ok'
  // A turn's end may already have closed this row (reconcile): count it once.
  const current = await read($, { plugin: 'cockpit', key: 'event', id: ev.id })
  const wasRunning = current?.status !== 'error' || current.endedAt === undefined
  const { output, exitCode } = outputOf(tool, r)
  const changes = status === 'ok' ? changesOf(input, r) : []
  const counts = changes.length > 0 ? await recordChanges($, ev, changes, now) : { added: 0, removed: 0 }
  const done: CockpitEvent = {
    ...ev,
    status,
    endedAt: now,
    output: output !== undefined && output !== '' ? output : undefined,
    exitCode,
    added: changes.length > 0 ? counts.added : undefined,
    removed: changes.length > 0 ? counts.removed : undefined,
    filePath: ev.filePath ?? changes[0]?.path,
  }
  await $.state.set({ plugin: 'cockpit', key: 'event', id: ev.id }, done)

  const res = obj(r.result)
  // A main-loop Agent call that ran in the foreground settles its agent here.
  if ((tool === 'Agent' || tool === 'Task') && status !== 'denied') {
    const agentId = str(res.agentId)
    const resStatus = str(res.status)
    await agentsQ($, list =>
      list.map((a): CockpitAgent => {
        const isThis = agentId !== undefined ? a.id === agentId : a.toolUseId === ev.id
        if (!isThis) return a
        if (status === 'error') return { ...a, status: 'failed', endedAt: a.endedAt ?? now }
        if (resStatus !== 'completed') return a
        const answer = agentAnswer(res)
        return {
          ...a,
          status: a.isTeammate === true ? 'idle' : 'done',
          endedAt: a.endedAt ?? now,
          tokens: num(res.totalTokens) ?? a.tokens,
          model: str(res.resolvedModel) ?? a.model,
          answer: answer !== '' ? clip(answer, 400) : a.answer,
        }
      }),
    )
  }
  if (tool === 'Workflow' && status === 'ok') {
    const runId = str(res.runId)
    if (runId !== undefined) {
      const rawName = str(res.workflowName) ?? str(input.name) ?? str(input.title)
      const name = rawName !== undefined ? clip(clean(rawName), 120) : undefined
      await update($, workflowsAtom, list => {
        const prev = list.find(w => w.runId === runId)
        return [
          ...list.filter(w => w.runId !== runId),
          { runId, name: name ?? prev?.name, toolUseId: ev.id, startedAt: prev?.startedAt ?? ev.startedAt },
        ].slice(-MAX_WORKFLOWS)
      })
    }
  }
  if (ev.agentId !== undefined && status !== 'ok') {
    const agentId = ev.agentId
    await agentsQ($, list => upsertAgent(list, agentId, now, a => ({ ...a, errors: a.errors + 1 })))
  }
  await statsQ($, s => {
    const streak = status === 'ok' ? s.streak + 1 : 0
    return {
      ...s,
      running: wasRunning ? Math.max(0, s.running - 1) : s.running,
      errors: s.errors + (status === 'error' ? 1 : 0),
      denied: s.denied + (status === 'denied' ? 1 : 0),
      added: s.added + counts.added,
      removed: s.removed + counts.removed,
      streak,
      bestStreak: Math.max(s.bestStreak, streak),
    }
  })

  if (changes.length > 0) await celebrate($, 'first-edit', `✎ Premier fichier modifié : ${basename(changes[0]?.path ?? '')}`)
  if (ev.isTest === true && status === 'ok') await celebrate($, 'tests-green', '✅ Tests au vert — bien joué !')
  await checkMilestones($)
  await refreshStatus($)

  // Claude just drove the simulator: refresh the Screen tab if it is in view.
  if (touchesDevice(tool, str(input.command) ?? '')) {
    const ui = await read($, uiAtom)
    if (ui.tab === 'screen') $.clock.after(400, () => void captureDevice($))
  }
}

/** The call itself rejected (aborted, its worker gone): close the row and the counter. */
const onToolAbort = async ($: $T, ev: CockpitEvent, err: unknown): Promise<void> => {
  const now = await $.clock.now()
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const done: CockpitEvent = {
    ...ev,
    status: 'error',
    endedAt: now,
    output: `⏹ interrompu${message !== '' ? ` — ${clip(clean(message), 400)}` : ''}`,
  }
  await $.state.set({ plugin: 'cockpit', key: 'event', id: ev.id }, done)
  await statsQ($, s => ({ ...s, running: Math.max(0, s.running - 1), streak: 0 }))
}

/** How far back a reconciliation looks for rows left running. */
const RECONCILE_WINDOW = 120

/**
 * A loop's turn ended: none of its calls can still run. Rows left `running`
 * (a call whose end this module never saw: a reload mid-call, a dropped
 * dispatch) are closed as interrupted and the counter is brought back.
 */
const reconcile = async ($: $T, agentId: string | undefined): Promise<void> => {
  const refs = await read($, feedAtom)
  const mine = refs.slice(-RECONCILE_WINDOW).filter(r => r.agent === agentId)
  if (mine.length === 0) return
  const now = await $.clock.now()
  let fixed = 0
  for (const ref of mine) {
    const ev = await read($, { plugin: 'cockpit', key: 'event', id: ref.id })
    if (ev === null || ev === undefined || ev.status !== 'running') continue
    await $.state.set({ plugin: 'cockpit', key: 'event', id: ref.id }, {
      ...ev,
      status: 'error',
      endedAt: now,
      output: ev.output ?? '⏹ interrompu (fin non observée)',
    })
    fixed += 1
  }
  if (fixed > 0) await statsQ($, s => ({ ...s, running: Math.max(0, s.running - fixed) }))
}

/** /clear: the conversation is new, so is the picture (the tab stays). */
const resetForClear = async ($: $T, deadline: () => boolean): Promise<void> => {
  const now = await $.clock.now()
  const refs = await read($, feedAtom)
  const files = await read($, filesAtom)
  await statsQ($, s => ({ ...EMPTY_STATS, startedAt: now, milestones: s.milestones }))
  await feedQ($, () => [])
  await filesQ($, () => [])
  await agentsQ($, () => [])
  await update($, workflowsAtom, () => [])
  await setScreen($, s => ({ ...EMPTY_SCREEN, isLive: s.isLive }))
  await update($, uiAtom, u => ({ ...u, filter: 'all', expanded: null, file: null, agent: null, limit: EMPTY_UI.limit, openRuns: [], showAllAgents: false }))
  await $.state.set({ plugin: 'cockpit', key: 'now' }, now)
  lastStatus = ''
  // The members the lists pointed at, while the end's short bound allows.
  for (const ref of refs) {
    if (deadline()) return
    await $.state.set({ plugin: 'cockpit', key: 'event', id: ref.id }, null)
  }
  for (const file of files) {
    if (deadline()) return
    await $.state.set({ plugin: 'cockpit', key: 'changes', id: file.path }, null)
  }
}

/** Opens the pane once per session, where the surface docks it as a sidebar. */
const autoOpen = async ($: $T): Promise<void> => {
  const ui = await read($, uiAtom)
  if (ui.autoOpened === true) return
  await update($, uiAtom, u => ({ ...u, autoOpened: true }))
  ensureTicker($)
  await $.ui.open({ id: PANE, title: 'Cockpit' })
}

// ================================================================ the pane
const TAB_WORDS: Record<string, CockpitTab> = {
  feed: 'feed',
  log: 'feed',
  commands: 'feed',
  files: 'files',
  fichiers: 'files',
  diff: 'files',
  diffs: 'files',
  agents: 'agents',
  agent: 'agents',
  screen: 'screen',
  ecran: 'screen',
  écran: 'screen',
  sim: 'screen',
  live: 'screen',
}

// ================================================================ registration
export const register: Register = (on, options) => {
  // userConfig `autoOpen` (default on): open the pane unasked where it docks.
  const isAutoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await quiet(async () => {
      if (e.surface !== null) await $.state.set({ plugin: 'cockpit', key: 'surface' }, e.surface)
      await $.command.register({
        name: 'cockpit',
        description: 'Live view of what Claude is doing: commands, diffs, agents, screen',
        argumentHint: '[feed|files|agents|screen|live|close]',
        immediate: true,
      })
      const now = await $.clock.now()
      await statsQ($, s => (s.startedAt === 0 ? { ...s, startedAt: now } : s))
      // A reload keeps the state but not the module: rows the old module
      // left running in the main loop can no longer end through it.
      await reconcile($, undefined)
      await markNow($, now)
      ensureTicker($)
      // The desktop app runs the session headless (surface null here) and
      // attaches later: it opens from session.attach. The terminal says
      // nothing at start about docking, so it waits for /cockpit.
      // A mod (re)loaded mid-session missed that attach: if the desktop is
      // already here, open now.
      if (isAutoOpen && (await $.session.surfaces()).includes('desktop')) {
        await $.state.set({ plugin: 'cockpit', key: 'surface' }, 'desktop')
        await autoOpen($)
      }
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The desktop app (or another remote surface) joined: open the pane there,
  // once per session, when that surface docks panes as a sidebar.
  on('session.attach', async ($, e, next) => {
    await quiet(async () => {
      await $.state.set({ plugin: 'cockpit', key: 'surface' }, e.surface)
      const docks =
        e.viewport?.isFullscreen === true || (e.surface === 'desktop' && e.viewport?.isFullscreen !== false)
      if (isAutoOpen && docks) await autoOpen($)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear: a fresh conversation in the same process, and no session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const budget = next.budget
      await quiet(() => resetForClear($, () => budget.remainingMs < 300))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // The row is written beside the call, never ahead of it: the tool starts
    // at once, whatever the state writes cost.
    let started: Promise<CockpitEvent | undefined>
    try {
      ensureTicker($)
      started = onToolStart($, e).catch(() => undefined)
    } catch {
      started = Promise.resolve(undefined)
    }
    let r: ToolCallResult
    try {
      r = await next(e)
    } catch (err) {
      const ev = await started
      if (ev !== undefined) await quiet(() => onToolAbort($, ev, err))
      throw err
    }
    const ev = await started
    if (ev !== undefined) await quiet(() => onToolEnd($, e, ev, r))
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await quiet(async () => {
      if (!('agentId' in r) || r.agentId === undefined) return
      const id = r.agentId
      const now = await $.clock.now()
      const runId = e.workflow !== undefined && e.workflow.runId !== '' ? e.workflow.runId : undefined
      const description = clip(clean(e.description), 160)
      const type = clean(e.isTeammate === true ? `teammate · ${e.subagentType}` : e.subagentType)
      await agentsQ($, list =>
        upsertAgent(list, id, now, a => ({
          ...a,
          description: description !== '' ? description : a.description,
          type,
          status: 'running',
          startedAt: a.tools === 0 ? now : a.startedAt,
          parentId: e.parentAgentId,
          runId,
          workflowIndex: e.workflow?.agentIndex,
          isBackground: e.background,
          isTeammate: e.isTeammate,
          name: e.name !== undefined ? clip(clean(e.name), 80) : undefined,
          model: r.model,
          toolUseId: e.tool_use_id,
        })),
      )
      if (runId !== undefined) {
        await update($, workflowsAtom, list =>
          list.some(w => w.runId === runId)
            ? list
            : [...list, { runId, toolUseId: e.tool_use_id, startedAt: now }].slice(-MAX_WORKFLOWS),
        )
      }
      await checkMilestones($)
      await refreshStatus($)
    })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await quiet(() => statsQ($, s => ({ ...s, isWorking: true, turns: s.turns + 1 })))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await quiet(async () => {
      const now = await $.clock.now()
      // Every call of the loop that just ended has ended too.
      await reconcile($, e.agentId)
      if (e.agentId === undefined) {
        await statsQ($, s => ({ ...s, isWorking: false }))
        await markNow($, now)
        await refreshStatus($)
        return
      }
      const id = e.agentId
      const status = agentStatusOf(e.reason)
      const tokens = tokensOf(e.usage)
      const answer = clip(clean(e.answer), 400)
      await agentsQ($, list =>
        upsertAgent(list, id, now, a => ({
          ...a,
          status: a.isTeammate === true && status === 'done' ? 'idle' : status,
          endedAt: now,
          tokens: tokens > 0 ? tokens : a.tokens,
          answer: answer !== '' ? answer : a.answer,
        })),
      )
      await refreshStatus($)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Screenshots returned by browser / simulator / computer-use tools.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    try {
      const origin = e.origin as { kind?: string; tool?: string }
      if (origin.kind === 'tool' && typeof origin.tool === 'string' && isScreenTool(origin.tool)) {
        const images = findImages(e.message.content)
        const last = images[images.length - 1]
        if (last !== undefined) {
          const label = origin.tool.split('__').slice(1).join(' · ').replace(/_/g, ' ')
          $.clock.after(0, () => void takeToolImage($, last, label))
        }
      }
    } catch {
      // never in the way of the row
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    ensureTicker($)
    const word = e.args.trim().toLowerCase().split(/\s+/)[0] ?? ''
    if (word === 'close' || word === 'off') {
      await $.ui.close({ id: PANE })
      return { text: 'Cockpit fermé.' }
    }
    const tab = TAB_WORDS[word]
    if (tab !== undefined) await update($, uiAtom, u => ({ ...u, tab }))
    if (word === 'live') await update($, screenAtom, s => ({ ...s, isLive: !s.isLive }))
    const opened = await $.ui.open({ id: PANE, title: 'Cockpit', focus: true })
    if (tab === 'screen') $.clock.after(0, () => void captureDevice($))
    const ui = await read($, uiAtom)
    if (opened.isPlaced) return { text: `Cockpit ouvert (${ui.tab}).` }
    return { text: `Cockpit n’a pas pu s’ouvrir ici : ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'cockpit' }, async ($, e) => {
    const els = $.ui.resolve(e)
    // Pick pictures by surface: a table may carry a stand-in under a key the
    // surface cannot draw (the terminal's `Svg` draws an empty box).
    const tables =
      e.surface === 'terminal'
        ? { Image: $.ui.resolve(e).Image, Svg: undefined }
        : { Svg: $.ui.resolve(e).Svg, Image: undefined }
    const ui = await read($, uiAtom)
    const stats = await read($, statsAtom)
    const agents = await read($, agentsAtom)
    const files = await read($, filesAtom)
    const refs = await read($, feedAtom)
    const workflows = await read($, workflowsAtom)
    const screen = await read($, screenAtom)
    const now = await read($, nowAtom)
    let cwd = ''
    try {
      cwd = await $.session.cwd()
    } catch {
      cwd = ''
    }
    const act: CockpitActions = {
      setUi: change => {
        void update($, uiAtom, change).catch(() => undefined)
      },
      toggleLive: () => {
        void toggleLive($)
      },
      capture: () => {
        void captureDevice($)
      },
    }
    const k: Kit = {
      Box: els.Box,
      Text: els.Text,
      Button: els.Button,
      Code: els.Code,
      Svg: tables.Svg,
      Image: tables.Image,
      surface: e.surface,
      W: Math.max(24, e.props.bodyColumns - 2),
      H: Math.max(10, e.props.scroll.bodyRows),
      now,
      cwd,
      ui,
      act,
    }
    const running = agents.filter(a => a.status === 'running').length
    const counts: Record<CockpitTab, string> = {
      feed: refs.length > 0 ? String(refs.length) : '',
      files: files.length > 0 ? String(files.length) : '',
      agents: agents.length > 0 ? (running > 0 ? `${running}▸` : String(agents.length)) : '',
      screen: screen.isLive ? '●' : screen.b64 !== undefined ? '◼' : '',
    }

    // Read only what the visible tab draws.
    let body: RenderElement
    if (ui.tab === 'files') {
      const sel = selectedFile(ui, files)
      const history = sel !== undefined ? ((await read($, { plugin: 'cockpit', key: 'changes', id: sel.path })) ?? []) : []
      body = filesView(k, files, agents, history)
    } else if (ui.tab === 'agents') {
      const mini: CockpitEvent[] = []
      if (ui.agent !== null) {
        for (const ref of agentRefs(ui.agent, refs)) {
          const ev = await read($, { plugin: 'cockpit', key: 'event', id: ref.id })
          if (ev !== null && ev !== undefined) mini.push(ev)
        }
      }
      body = agentsView(k, agents, workflows, refs, stats, mini)
    } else if (ui.tab === 'screen') {
      body = screenView(k, screen)
    } else {
      const { shown, total } = visibleRefs(ui, refs)
      const events: CockpitEvent[] = []
      for (const ref of shown) {
        const ev = await read($, { plugin: 'cockpit', key: 'event', id: ref.id })
        if (ev !== null && ev !== undefined) events.push(ev)
      }
      let change: CockpitChange | undefined
      const open = events.find(ev => ev.id === ui.expanded)
      if (open?.filePath !== undefined && open.cat === 'edit') {
        const list = await read($, { plugin: 'cockpit', key: 'changes', id: open.filePath })
        change = (list ?? []).find(c => c.id === open.id)
      }
      body = feedView(k, refs, agents, events, total, change)
    }
    const { Box } = els
    return (
      <Box key="cockpit" flexDirection="column" paddingX={1}>
        {header(k, { stats, agents, files: files.length })}
        {tabs(k, counts, () => {
          if (screen.b64 === undefined || screen.source !== 'tool') void captureDevice($)
        })}
        {body}
        <Box key="foot" marginTop={1}>
          {footer(k)}
        </Box>
      </Box>
    )
  })
}
