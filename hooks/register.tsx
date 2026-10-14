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
import type { EngineInterface, RenderElement, Register, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

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
  footerChip,
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
  sparkSeries,
} from './model'
import { deepImages, findImages, firstErrorLine, imageSize, parseAdb, parseSimctl, sipsError } from './screen'
import type { Device } from './screen'
import { agentRefs, agentsView } from './ui/agents'
import { feedView, visibleRefs } from './ui/feed'
import { filesView, selectedFile } from './ui/files'
import { footer, header, tabs } from './ui/header'
import type { CockpitActions, Kit } from './ui/kit'
import { screenView } from './ui/screen'
import { planLive } from './live'
import { liveView } from './ui/live'
import { PX_PER_CELL } from './svg/base'

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
/** The device the last capture found, probed again only after a failure. */
let device: Device | undefined
/** Captures failed in a row: Live stops at LIVE_MAX_FAILURES. */
let captureFailures = 0
/** Device tools this session showed missing (the spawn itself rejected). */
const missingTools = new Set<string>()
/** The newest tool screenshot waiting to be taken; one is taken at a time. */
type ToolImage = { image: { data: string; mime: string }; label: string }
let pendingImage: ToolImage | undefined
let isTakingImage = false
/** Newest calls the desktop's live view reads. */
const LIVE_EVENTS = 60
/** After a browser action, a screenshot follows once the actions pause. */
const SHOT_DELAY_MS = 700
let shotTimer: Timer | undefined
/** This plugin's name: a `tool.call` it raised itself (its screenshot) is no call of Claude's. */
const SELF = 'cockpit'

const LIVE_MAX_FAILURES = 3
const NO_DEVICE = 'No iOS simulator or Android emulator running.'

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

/** A spawn that rejected for want of the command, not for running too long. */
const isMissing = (err: unknown): boolean => !/time/i.test(err instanceof Error ? err.message : String(err))

const findDevice = async ($: $T): Promise<Device | undefined> => {
  if (device !== undefined) return device
  if (!missingTools.has('xcrun')) {
    try {
      const r = await $.process.run(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs: 10_000 })
      const sim = r.exitCode === 0 ? parseSimctl(r.stdout) : undefined
      if (sim !== undefined) return sim
    } catch (err) {
      // no Xcode: not asked again this session; try Android
      if (isMissing(err)) missingTools.add('xcrun')
    }
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
    if (missingTools.has(adb)) continue
    try {
      const r = await $.process.run([adb, 'devices'], { timeoutMs: 8000 })
      if (r.exitCode === 0) return parseAdb(r.stdout, adb)
    } catch (err) {
      if (isMissing(err)) missingTools.add(adb)
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
    // Else `jpg` still holds the previous frame.
    const failed = sipsError(r)
    if (failed !== undefined) throw new Error(failed)
    const { base64 } = await $.fs.read(jpg, { as: 'bytes' })
    if (base64.length <= MAX_SVG_B64) {
      const dims = imageSize(base64)
      return { b64: base64, width: dims?.width, height: dims?.height }
    }
  }
  throw new Error('image too large even compressed')
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
    const found = await findDevice($)
    if (found === undefined) throw new Error(NO_DEVICE)
    device = found
    let label: string
    if (found.kind === 'ios') {
      const r = await $.process.run(['xcrun', 'simctl', 'io', found.udid, 'screenshot', '--type=png', png], {
        timeoutMs: 15_000,
      })
      if (r.exitCode !== 0) throw new Error(firstErrorLine(r.stderr || r.stdout) || `simctl failed (${r.exitCode})`)
      label = clean(found.name)
    } else {
      const remote = '/sdcard/cockpit-frame.png'
      const shot = await $.process.run([found.adb, '-s', found.serial, 'shell', 'screencap', '-p', remote], {
        timeoutMs: 15_000,
      })
      if (shot.exitCode !== 0) throw new Error(firstErrorLine(shot.stderr || shot.stdout) || 'screencap failed')
      const pull = await $.process.run([found.adb, '-s', found.serial, 'pull', remote, png], { timeoutMs: 15_000 })
      if (pull.exitCode !== 0) throw new Error(firstErrorLine(pull.stderr || pull.stdout) || 'adb pull failed')
      label = `Android ${found.serial}`
    }
    const frame = await toSvgFrame($, png, jpg)
    const at = await $.clock.now()
    captureFailures = 0
    await setScreen($, s => ({
      ...s,
      source: found.kind,
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
    // The device may be gone: look again next time; Live gives up after a few.
    device = undefined
    captureFailures += 1
    const message = clean(err instanceof Error ? err.message : String(err)).slice(0, 200)
    const stops = captureFailures >= LIVE_MAX_FAILURES
    await quiet(() =>
      setScreen($, s => ({
        ...s,
        isBusy: false,
        isLive: stops ? false : s.isLive,
        error:
          stops && s.isLive
            ? `${message} Live stopped after ${LIVE_MAX_FAILURES} failed captures.`
            : message === NO_DEVICE && s.source === 'tool'
              ? undefined
              : message,
      })),
    )
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
      if (decode.exitCode !== 0) throw new Error(firstErrorLine(decode.stderr) || 'base64 decode failed')
      if (needsFile && isPng) pngPath = raw
      else if (needsFile) {
        const png = `${base}tool.png`
        const r = await $.process.run(['sips', '-s', 'format', 'png', raw, '--out', png], { timeoutMs: 15_000 })
        if (sipsError(r) === undefined) pngPath = png
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
    await quiet(() => setScreen($, s => ({ ...s, error: `Tool screenshot: ${clean(message).slice(0, 160)}` })))
  }
}

/**
 * Tool screenshots one at a time, through the same files: a frame arriving
 * while one is taken replaces any still waiting (only the newest shows).
 */
const queueToolImage = async ($: $T, image: { data: string; mime: string }, label: string): Promise<void> => {
  pendingImage = { image, label }
  if (isTakingImage) return
  isTakingImage = true
  try {
    for (let next: ToolImage | undefined = pendingImage; next !== undefined; next = pendingImage as ToolImage | undefined) {
      pendingImage = undefined
      await takeToolImage($, next.image, next.label)
    }
  } finally {
    isTakingImage = false
  }
}

/** Turns Live on or off; on, the caller takes the first frame. */
const setLive = async ($: $T, isLive: (was: boolean) => boolean): Promise<boolean> => {
  const next = await update($, screenAtom, s => ({ ...s, isLive: isLive(s.isLive) }))
  if (next.isLive) {
    captureFailures = 0
    ensureTicker($)
  }
  return next.isLive
}

/** The screenshot call that shows what a screen tool just did, if any. */
const screenshotCallFor = (e: ToolCallInput): { tool: string; args: Record<string, unknown> } | undefined => {
  const input = e as unknown as { action?: unknown; tabId?: unknown }
  if (input.action === 'screenshot' || input.action === 'zoom') return undefined
  const tab = typeof input.tabId === 'string' || typeof input.tabId === 'number' ? { tabId: input.tabId } : {}
  if (e.tool.startsWith('mcp__Claude_Browser__')) return { tool: 'mcp__Claude_Browser__computer', args: { action: 'screenshot', scale: 0.6, ...tab } }
  if (e.tool.startsWith('mcp__claude-in-chrome__') && 'tabId' in tab) return { tool: 'mcp__claude-in-chrome__computer', args: { action: 'screenshot', ...tab } }
  return undefined
}

/**
 * After a screen action whose result held no picture, look at the screen:
 * the simulator through simctl, a browser through its own screenshot tool
 * (only where that call is allowed without asking the person).
 */
const scheduleShot = ($: $T, e: ToolCallInput, r: ToolCallResult): void => {
  if (r.deny !== undefined) return
  const images = deepImages(r.result)
  if (images.length > 0) {
    const last = images[images.length - 1]
    if (last !== undefined) $.clock.after(0, () => void queueToolImage($, last, e.tool.split('__').slice(1).join(' · ').replace(/_/g, ' ')))
    return
  }
  const isSim = e.tool.startsWith('mcp__Claude_Code_iOS_Simulator__')
  const call = isSim ? undefined : screenshotCallFor(e)
  if (!isSim && call === undefined) return
  shotTimer?.cancel()
  shotTimer = $.clock.after(SHOT_DELAY_MS, () => {
    shotTimer = undefined
    void quiet(async () => {
      if (isSim) return void (await captureDevice($))
      if (call === undefined) return
      const verdict = await $.tool.check({ tool: call.tool, input: call.args })
      if (verdict.decision !== 'allow') return
      const shot: ToolCallResult = await $.tool.call({ tool: call.tool, ...call.args } as never)
      const found = deepImages(shot.result)
      const last = found[found.length - 1]
      if (last !== undefined) await queueToolImage($, last, call.tool.split('__').slice(1).join(' · ').replace(/_/g, ' '))
    })
  })
}

// ================================================================ status, milestones, ticker
/** The short summary pinned under the prompt (the app prints the plugin's name before it). */
const refreshStatus = async ($: $T): Promise<void> => {
  const stats = await read($, statsAtom)
  const agents = await read($, agentsAtom)
  const text = footerChip(stats, agents)
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** Opens the pane, or closes it when it is up: what the footer chip does. */
const togglePane = async ($: $T): Promise<void> => {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE && p.isShown)) {
    await $.ui.close({ id: PANE })
    await update($, uiAtom, u => ({ ...u, isPaneShown: false }))
    return
  }
  ensureTicker($)
  const opened = await $.ui.open({ id: PANE, title: 'Cockpit' })
  if (opened.isPlaced) await update($, uiAtom, u => ({ ...u, isPaneShown: true }))
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

/**
 * Once a second while the pane is open: the clock for elapsed times, live
 * capture, agent statuses. Stops once the pane is closed; whatever opens it
 * again (or a tool call) starts it.
 */
const tick = async ($: $T): Promise<void> => {
  if (isTicking) return
  isTicking = true
  tickCount += 1
  try {
    const panes = await $.ui.panes()
    const pane = panes.find(p => p.id === PANE)
    if (pane === undefined) {
      ticker?.cancel()
      ticker = undefined
      return
    }
    if (!pane.isShown || !pane.isPlaced) return
    const stats = await read($, statsAtom)
    const agents = await read($, agentsAtom)
    const ui = await read($, uiAtom)
    const isBusy = stats.running > 0 || stats.isWorking || agents.some(a => a.status === 'running')
    // Each write of `now` redraws the pane; on the Screen tab that resends
    // the frame, and nothing there needs the second: every 10 s will do.
    if ((isBusy && ui.tab !== 'screen') || tickCount % 10 === 0) await markNow($, await $.clock.now())
    if (tickCount % 2 === 0) {
      const screen = await read($, screenAtom)
      // The desktop's live view has no Screen tab: Live refreshes it there.
      if (screen.isLive && (ui.tab === 'screen' || !(await drawsOnTerminal($)))) void captureDevice($)
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
    const rendered = renderHunks(change.hunks, MAX_DIFF)
    const text = { ...rendered, added: change.added ?? rendered.added, removed: change.removed ?? rendered.removed }
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
      isTooLarge: change.isTooLarge,
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
  // Gone (evicted from the feed, or a /clear) while it ran: not written back.
  if (current !== null && current !== undefined) await $.state.set({ plugin: 'cockpit', key: 'event', id: ev.id }, done)

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

  if (changes.length > 0) await celebrate($, 'first-edit', `✎ First file changed: ${basename(changes[0]?.path ?? '')}`)
  if (ev.isTest === true && status === 'ok') await celebrate($, 'tests-green', '✅ Tests passing — nice one!')
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
    output: `⏹ interrupted${message !== '' ? ` — ${clip(clean(message), 400)}` : ''}`,
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
      output: ev.output ?? '⏹ interrupted (end not observed)',
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
  await update($, uiAtom, u => ({ ...u, filter: 'all', expanded: null, file: null, agent: null, limit: EMPTY_UI.limit, offset: 0, openRuns: [], showAllAgents: false }))
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
  const opened = await $.ui.open({ id: PANE, title: 'Cockpit' })
  if (opened.isPlaced) await update($, uiAtom, u => ({ ...u, isPaneShown: true }))
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
const COMMAND_WORDS = 'feed, files, agents, screen, live [on|off], close'

// ================================================================ registration
export const register: Register = (on, options) => {
  // userConfig `autoOpen` (default on): open the pane unasked where it docks.
  const isAutoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await quiet(async () => {
      // The summary shows from the load on, not from the next tool call.
      lastStatus = ''
      await refreshStatus($)
      // A reload finds the pane as the engine kept it.
      const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
      await update($, uiAtom, u => ({ ...u, isPaneShown: isUp }))
      if (e.surface !== null) await $.state.set({ plugin: 'cockpit', key: 'surface' }, e.surface)
      await $.command.register({
        name: 'cockpit',
        description: 'Live view of what Claude is doing: commands, diffs, agents, screen',
        argumentHint: '[feed|files|agents|screen|live [on|off]|close]',
        immediate: true,
      })
      const now = await $.clock.now()
      await statsQ($, s => (s.startedAt === 0 ? { ...s, startedAt: now } : s))
      // A reload keeps the state but not the module: rows the old module
      // left running in the main loop can no longer end through it.
      await reconcile($, undefined)
      await markNow($, now)
      // Where frames go, settled once before any capture can race for it.
      await tmpBase($)
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
    // The plugin's own look at the screen is no call of Claude's. Told by who
    // raised it, not by a flag: Claude's calls meanwhile are still recorded.
    if (next.origin.plugin === SELF) return next(e)
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
    // The result goes to the model now; the bookkeeping (a score of state
    // round-trips) follows once this dispatch resolved.
    const ev = await started
    try {
      if (isScreenTool(e.tool)) scheduleShot($, e, r)
    } catch {
      // the screen stays as it was
    }
    try {
      if (ev !== undefined) $.clock.after(0, () => void quiet(() => onToolEnd($, e, ev, r)))
    } catch {
      // a lost end: the turn's reconcile closes the row
    }
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
          $.clock.after(0, () => void queueToolImage($, last, label))
        }
      }
    } catch {
      // never in the way of the row
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The pane is the answer: no transcript row (the model would read it too),
  // save to say what went wrong.
  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const [word = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'close' || word === 'off') {
      await $.ui.close({ id: PANE })
      await update($, uiAtom, u => ({ ...u, isPaneShown: false }))
      return {}
    }
    const tab = TAB_WORDS[word]
    const live = word !== 'live' ? undefined : arg === 'on' ? true : arg === 'off' ? false : 'toggle'
    if (word !== '' && (tab === undefined || (word === 'live' && arg !== '' && live === 'toggle'))) {
      return { text: `/cockpit: unknown "${clip(clean(e.args.trim()), 40)}". Try ${COMMAND_WORDS}.` }
    }
    ensureTicker($)
    if (tab !== undefined) await update($, uiAtom, u => ({ ...u, tab, offset: 0 }))
    const opened = await $.ui.open({ id: PANE, title: 'Cockpit', focus: true })
    if (!opened.isPlaced) return { text: `Cockpit could not open here: ${opened.reason}` }
    await update($, uiAtom, u => ({ ...u, isPaneShown: true }))
    if (live !== undefined) {
      const isLive = await setLive($, was => (live === 'toggle' ? !was : live))
      $.ui.toast(isLive ? 'Cockpit · Live ● on' : 'Cockpit · Live ○ off', { timeoutMs: 3000 })
    }
    if (tab === 'screen') $.clock.after(0, () => void captureDevice($))
    return {}
  })

  // The person closed the pane (its mark, a key): the opener shows again.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) await quiet(() => update($, uiAtom, u => ({ ...u, isPaneShown: false })))
    return r
  }).catch(($, e, next) => next(e))

  // On the terminal, a button beside the mode labels toggles the pane (the
  // desktop asks for this site but does not draw what a plugin puts there).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const stats = await read($, statsAtom)
    const agents = await read($, agentsAtom)
    const chip = footerChip(stats, agents)
    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = e.props.modes
    return (
      <Box key="modes" flexDirection="row" columnGap={1}>
        {modes.length > 0 ? <Text key="m" dimColor>{modes.join(' & ')}</Text> : null}
        <Button key="cockpit-toggle" plain onPress={() => void togglePane($).catch(() => undefined)}>
          {chip}
        </Button>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // Above the prompt, while the pane is closed: one button that opens it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const ui = await read($, uiAtom)
    if (ui.isPaneShown === true) return next(e)
    const stats = await read($, statsAtom)
    const agents = await read($, agentsAtom)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box key="opener" flexDirection="row">
        <Button key="cockpit-open" onPress={() => void togglePane($).catch(() => undefined)}>
          {`◆ Open Cockpit${stats.calls > 0 ? ` · ${footerChip(stats, agents).replace(/^◆ /, '')}` : ''}`}
        </Button>
      </Box>
    )
  }).catch(($, e, next) => next(e))

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
        void setLive($, was => !was)
          .then(isLive => (isLive ? captureDevice($) : undefined))
          .catch(() => undefined)
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
      // A desktop draws each row as its native button: leave room for its chrome.
      W: Math.max(24, e.props.bodyColumns - (e.surface === 'terminal' ? 2 : 6)),
      H: Math.max(10, e.props.scroll.bodyRows),
      now,
      cwd,
      ui,
      act,
    }
    // The desktop draws one live view: what Claude does now, then history.
    if (e.surface !== 'terminal' && tables.Svg !== undefined) {
      const recent = refs.slice(-LIVE_EVENTS).reverse()
      const events: CockpitEvent[] = []
      for (const ref of recent) {
        const ev = await read($, { plugin: 'cockpit', key: 'event', id: ref.id })
        if (ev !== null && ev !== undefined) events.push(ev)
      }
      // The change each recent edit made, read once per file.
      const changes = new Map<string, CockpitChange>()
      const byPath = new Map<string, readonly CockpitChange[]>()
      for (const ev of events) {
        if (ev.cat !== 'edit' || ev.filePath === undefined) continue
        let list = byPath.get(ev.filePath)
        if (list === undefined) {
          list = (await read($, { plugin: 'cockpit', key: 'changes', id: ev.filePath })) ?? []
          byPath.set(ev.filePath, list)
        }
        const change = list.find(c => c.id === ev.id)
        if (change !== undefined) changes.set(ev.id, change)
      }
      const plan = planLive({ events, agents, workflows, screen, changes, now })
      const px = Math.max(240, Math.floor((e.props.bodyColumns - 2) * PX_PER_CELL))
      const { Box } = els
      return (
        <Box key="cockpit" flexDirection="column" paddingX={1}>
          {liveView(k, {
            plan,
            stats,
            agents,
            files: files.length,
            series: sparkSeries(stats, now),
            screen,
            px,
            roomPx: Math.max(10, e.props.scroll.bodyRows) * 19,
          })}
        </Box>
      )
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
      const { shown, total, offset } = visibleRefs(ui, refs)
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
      body = feedView(k, refs, agents, events, total, offset, change)
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
