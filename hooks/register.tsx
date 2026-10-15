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
  CockpitFrame,
  CockpitScreen,
  CockpitStats,
  CockpitStatus,
  CockpitTab,
  CockpitUi,
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
import { deepImages, deviceKey, deviceLabel, findImages, firstErrorLine, imageSize, parseAdbAll, parseSimctlAll, safeName, sipsError } from './screen'
import type { Device } from './screen'
import {
  appCommandTitle,
  appForCall,
  appForWindow,
  appsFromConfig,
  appScreenshotTool,
  badgeOf,
  BINARY_EXT,
  BUILTIN_APPS,
  commandDir,
  frameKeyFor,
  IMAGE_EXT,
  isBinaryAsset,
  isShotTool,
  mcpServer,
  mcpToolName,
  mergeApps,
  mimeOfPath,
  parseWindowInfo,
  pathsInCommand,
  resolvePath,
  SCREEN_RECORDING_HELP,
  WINDOW_JXA,
} from './apps'
import type { AppDef } from './apps'
import { agentRefs, agentsView } from './ui/agents'
import { feedView, visibleRefs } from './ui/feed'
import { filesView, selectedFile } from './ui/files'
import { footer, header, tabs } from './ui/header'
import type { CockpitActions, Kit } from './ui/kit'
import { screenView } from './ui/screen'
import { addFrameKey, planLive } from './live'
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
const frameKeysAtom = atom({ plugin: 'cockpit', key: 'frameKeys' } as const, [])
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
let lastStatus = ''
/** One look at the devices at a time; a press or a call asking meanwhile is looked at next. */
let isCapturingDevices = false
let deviceAgain: DeviceAsk | undefined
/** Live's looks in a row that found no device (or failed): its pace slows, it never stops. */
let liveMisses = 0
/** The tick Live looks again at. */
let liveNextTick = 0
/** Device tools this session showed missing (the spawn itself rejected). */
const missingTools = new Set<string>()
/**
 * An image to show: base64 a tool returned, or a file a command wrote. One
 * waits per frame key (the newest); they are taken one at a time.
 */
type ImageIn = { data?: string; mime: string; path?: string; size?: number }
/** Where a frame comes from: its source, its frame's key, the app it shows, the call behind it. */
type FrameMeta = { source: 'tool' | 'file'; key: string; app?: AppDef; eventId?: string }
type ToolImage = { image: ImageIn; label: string; meta: FrameMeta }
const pendingImages = new Map<string, ToolImage>()
let isTakingImage = false
/** The last image shown, by its call (or its bytes): the same picture seen twice is shown once. */
let lastImageKey = ''
/** The app registry: built-ins merged with ~/.claude/cockpit.json and <cwd>/.cockpit.json. */
let apps: AppDef[] = [...BUILTIN_APPS]
/** Each app server's screenshot tool, once found. */
const shotTools = new Map<string, string>()
/** Servers seen without one: not listed again before this time (a server may connect later). */
const noShotUntil = new Map<string, number>()
/** Window capture: one at a time, backing off after failures. */
let isCapturingWindow = false
let windowFailures = 0
let windowRetryTick = 0
/** Screen Recording is missing: no capture unasked until the next /cockpit watch. */
let windowDenied = false
/** Newest calls the desktop's live view reads. */
const LIVE_EVENTS = 60
/** After a browser action, a screenshot follows once the actions pause. */
const SHOT_DELAY_MS = 700
let shotTimer: Timer | undefined
/** This plugin's name: a `tool.call` it raised itself (its screenshot) is no call of Claude's. */
const SELF = 'cockpit'
/** Pictures waiting to be taken at once, one per frame. */
const MAX_PENDING_IMAGES = 6

const NO_DEVICE = 'No iOS simulator or Android emulator running.'
/** Why a device is looked at: Live's beat, the person's press, a call that drove it. */
type DeviceAsk = { reason: 'live' | 'manual' | 'call'; only?: 'ios' | 'android'; eventId?: string }
/** Live looks every 2 s while devices answer; with none, after 2 s, 5 s, then every 10 s. */
const LIVE_EVERY = 2
const liveBackoff = (misses: number): number => (misses <= 1 ? 2 : misses === 2 ? 5 : 10)
/** Devices looked at in one pass: simulators, emulators, and both (frames are kept six at most). */
const MAX_SIMS = 4
const MAX_ANDROID = 4
const MAX_DEVICES = 6
/** Without anything running, the pane's clock moves every this many ticks. */
const NOW_SLOW_TICKS = 30

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

/** Changes the single screen's flags, writing only when they moved (each write redraws the pane). */
const patchScreen = async ($: $T, change: (s: CockpitScreen) => CockpitScreen): Promise<void> => {
  const s = await read($, screenAtom)
  const next = change(s)
  if (next.isBusy === s.isBusy && next.isWaiting === s.isWaiting && next.error === s.error) return
  await update($, screenAtom, change)
}

/** A frame shown on the single screen too: the terminal's Screen tab draws that one. */
type Shown = Pick<CockpitScreen, 'source' | 'label' | 'app' | 'appColor' | 'eventId' | 'b64' | 'mime' | 'width' | 'height' | 'pngPath'> & { at: number }

const showOnScreen = async ($: $T, shown: Shown): Promise<void> => {
  const s = await read($, screenAtom)
  const isSame =
    s.b64 === shown.b64 && s.source === shown.source && s.label === shown.label && s.eventId === shown.eventId && s.error === undefined && s.isBusy !== true
  if (!isSame) await setScreen($, cur => ({ ...cur, ...shown, generation: cur.generation + 1, error: undefined, isBusy: false }))
}

// ---------------------------------------------------------------- frames
/**
 * Puts a frame under its key: the same picture again writes nothing (a
 * still simulator costs no redraw); a new key goes first, and past six the
 * oldest goes, never a device Live follows or the window watched.
 */
const putFrame = async ($: $T, frame: CockpitFrame): Promise<void> => {
  const old = await read($, { plugin: 'cockpit', key: 'frame', id: frame.key })
  const isSame =
    old !== null &&
    old !== undefined &&
    old.b64 === frame.b64 &&
    old.label === frame.label &&
    old.eventId === frame.eventId &&
    old.app === frame.app &&
    old.isManual !== true &&
    frame.isManual !== true
  if (!isSame) await $.state.set({ plugin: 'cockpit', key: 'frame', id: frame.key }, frame)
  const keys = await read($, frameKeysAtom)
  if (keys.includes(frame.key)) return
  const screen = await read($, screenAtom)
  const isKept = (key: string): boolean =>
    (screen.isLive && (key.startsWith('ios:') || key.startsWith('android:'))) || (screen.watch !== undefined && key === `window:${screen.watch}`)
  let evicted: string[] = []
  await update($, frameKeysAtom, list => {
    const next = addFrameKey(list, frame.key, isKept)
    evicted = next.evicted
    return next.keys
  })
  for (const key of evicted) await $.state.set({ plugin: 'cockpit', key: 'frame', id: key }, null)
}

/** Removes frames: their keys first, then the members. */
const dropFrames = async ($: $T, keys: readonly string[]): Promise<void> => {
  if (keys.length === 0) return
  await update($, frameKeysAtom, list => list.filter(key => !keys.includes(key)))
  for (const key of keys) await $.state.set({ plugin: 'cockpit', key: 'frame', id: key }, null)
}

/**
 * Removes the frames of `isOf` that only Live or a watch kept (no call made
 * them, nobody asked for them): once those stop, they would show nowhere.
 */
const dropFollowed = async ($: $T, isOf: (key: string) => boolean): Promise<void> => {
  const stale: string[] = []
  for (const key of await read($, frameKeysAtom)) {
    if (!isOf(key)) continue
    const frame = await read($, { plugin: 'cockpit', key: 'frame', id: key })
    if (frame === null || frame === undefined || (frame.eventId === undefined && frame.isManual !== true)) stale.push(key)
  }
  await dropFrames($, stale)
}

// ---------------------------------------------------------------- devices
/** A spawn that rejected for want of the command, not for running too long. */
const isMissing = (err: unknown): boolean => !/time/i.test(err instanceof Error ? err.message : String(err))

const messageOf = (err: unknown): string => clean(err instanceof Error ? err.message : String(err)).slice(0, 200)

/** Where adb may be: the PATH, Android Studio's SDK, $ANDROID_HOME. */
const adbCandidates = async ($: $T): Promise<string[]> => {
  const out = ['adb']
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined) out.push(`${home}/Library/Android/sdk/platform-tools/adb`)
    const sdk = await $.env.get('ANDROID_HOME')
    if (sdk !== undefined) out.push(`${sdk}/platform-tools/adb`)
  } catch {
    // the PATH alone
  }
  return out
}

/** What a look found: the devices, which tools answered (a silent one keeps its frames), what failed. */
type Listing = { devices: Device[]; isIosListed: boolean; isAndroidListed: boolean; error?: string }

/** Every booted simulator (iOS first) and every connected Android device. */
const listDevices = async ($: $T, only?: 'ios' | 'android'): Promise<Listing> => {
  const devices: Device[] = []
  let isIosListed = false
  let isAndroidListed = false
  let error: string | undefined
  if (only !== 'android' && !missingTools.has('xcrun')) {
    try {
      const r = await $.process.run(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs: 10_000 })
      const sims = r.exitCode === 0 ? parseSimctlAll(r.stdout, MAX_SIMS) : undefined
      if (sims !== undefined) {
        devices.push(...sims)
        isIosListed = true
      } else if (r.exitCode !== 0) error = firstErrorLine(r.stderr || r.stdout) || `simctl failed (${r.exitCode})`
    } catch (err) {
      // no Xcode: not asked again this session; Android may still answer
      if (isMissing(err)) missingTools.add('xcrun')
      else error = 'Listing the simulators took too long.'
    }
  }
  if (only !== 'ios') {
    for (const adb of await adbCandidates($)) {
      if (missingTools.has(adb)) continue
      try {
        const r = await $.process.run([adb, 'devices'], { timeoutMs: 8000 })
        if (r.exitCode === 0) {
          devices.push(...parseAdbAll(r.stdout, adb, MAX_ANDROID))
          isAndroidListed = true
          break
        }
      } catch (err) {
        if (isMissing(err)) missingTools.add(adb)
      }
    }
  }
  return { devices: devices.slice(0, MAX_DEVICES), isIosListed, isAndroidListed, error }
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

/** One device's screen, through files of its own. */
const captureOneDevice = async ($: $T, d: Device, base: string): Promise<{ b64: string; width?: number; height?: number; png: string }> => {
  const name = `${d.kind}-${safeName(d.kind === 'ios' ? d.udid : d.serial)}`
  const png = `${base}${name}.png`
  const jpg = `${base}${name}.jpg`
  if (d.kind === 'ios') {
    const r = await $.process.run(['xcrun', 'simctl', 'io', d.udid, 'screenshot', '--type=png', png], { timeoutMs: 15_000 })
    if (r.exitCode !== 0) throw new Error(firstErrorLine(r.stderr || r.stdout) || `simctl failed (${r.exitCode})`)
  } else {
    const remote = '/sdcard/cockpit-frame.png'
    const shot = await $.process.run([d.adb, '-s', d.serial, 'shell', 'screencap', '-p', remote], { timeoutMs: 15_000 })
    if (shot.exitCode !== 0) throw new Error(firstErrorLine(shot.stderr || shot.stdout) || 'screencap failed')
    const pull = await $.process.run([d.adb, '-s', d.serial, 'pull', remote, png], { timeoutMs: 15_000 })
    if (pull.exitCode !== 0) throw new Error(firstErrorLine(pull.stderr || pull.stdout) || 'adb pull failed')
  }
  return { ...(await toSvgFrame($, png, jpg)), png }
}

/**
 * One look at every device: each booted simulator and connected emulator
 * gets its frame, the frames of those gone go. Live sets its next beat from
 * what it found and never turns itself off; a call's look stays quiet.
 */
const captureDevicesOnce = async ($: $T, ask: DeviceAsk): Promise<void> => {
  const isManual = ask.reason === 'manual'
  if (isManual) await quiet(() => patchScreen($, s => ({ ...s, isBusy: true })))
  const listed = await listDevices($, ask.only)
  const found = new Set(listed.devices.map(deviceKey))
  const keys = await read($, frameKeysAtom)
  const gone = keys.filter(
    key => !found.has(key) && ((listed.isIosListed && key.startsWith('ios:')) || (listed.isAndroidListed && key.startsWith('android:'))),
  )
  await dropFrames($, gone)
  let failure = listed.devices.length === 0 ? listed.error : undefined
  const shots: { frame: CockpitFrame; png: string }[] = []
  if (listed.devices.length > 0) {
    const base = await tmpBase($)
    for (const d of listed.devices) {
      try {
        const shot = await captureOneDevice($, d, base)
        const frame: CockpitFrame = { key: deviceKey(d), source: d.kind, label: clean(deviceLabel(d)), b64: shot.b64, mime: 'image/jpeg', width: shot.width, height: shot.height, at: await $.clock.now() }
        if (ask.eventId !== undefined) frame.eventId = ask.eventId
        if (isManual) frame.isManual = true
        shots.push({ frame, png: shot.png })
      } catch (err) {
        failure ??= messageOf(err)
      }
    }
  }
  // Live turned off while it looked: what it saw is no longer wanted.
  if (ask.reason === 'live' && !(await read($, screenAtom)).isLive) return
  // Last first: a new frame goes first, so the first device ends up first.
  for (const { frame } of [...shots].reverse()) await putFrame($, frame)
  const shown = shots.length
  // The single screen (the terminal's Screen tab) shows the first device.
  const lead = shots[0]
  if (lead !== undefined) {
    const f = lead.frame
    await showOnScreen($, { source: f.source, label: f.label, app: undefined, appColor: undefined, eventId: f.eventId, b64: f.b64, mime: f.mime, width: f.width, height: f.height, pngPath: lead.png, at: f.at })
  }
  if (ask.reason === 'live') {
    liveMisses = shown > 0 ? 0 : liveMisses + 1
    liveNextTick = tickCount + (shown > 0 ? LIVE_EVERY : liveBackoff(liveMisses))
  }
  const isNone = listed.devices.length === 0 && failure === undefined
  await quiet(() =>
    patchScreen($, s => {
      let error = s.error
      if (shown > 0) error = undefined
      // Asked by the person: say what is missing (unless another picture is shown).
      else if (isManual) error = isNone ? (s.source === 'tool' || s.source === 'file' || s.source === 'window' ? undefined : NO_DEVICE) : failure
      // Live keeps looking: a failure is said, no device is only waited for.
      else if (ask.reason === 'live') error = failure ?? (s.error === NO_DEVICE ? undefined : s.error)
      // Waiting: Live is on and a look at every kind of device found none.
      const isWaiting = !s.isLive ? undefined : ask.only === undefined ? listed.devices.length === 0 : s.isWaiting
      return { ...s, isBusy: isManual ? false : s.isBusy, isWaiting, error }
    }),
  )
}

/** Looks at the devices; a press or a call asking while a look runs is looked at right after it. */
const captureDevices = async ($: $T, ask: DeviceAsk): Promise<void> => {
  if (isCapturingDevices) {
    // Live looks again on its own beat.
    if (ask.reason !== 'live')
      deviceAgain =
        deviceAgain === undefined
          ? ask
          : { reason: deviceAgain.reason === 'manual' ? 'manual' : ask.reason, only: deviceAgain.only === ask.only ? ask.only : undefined, eventId: ask.eventId ?? deviceAgain.eventId }
    return
  }
  isCapturingDevices = true
  try {
    for (let next: DeviceAsk | undefined = ask; next !== undefined; ) {
      deviceAgain = undefined
      await quiet(() => captureDevicesOnce($, next as DeviceAsk))
      next = deviceAgain
    }
  } finally {
    isCapturingDevices = false
    deviceAgain = undefined
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

// ---------------------------------------------------------------- tool images
/**
 * An image to show: kept when small, else shrunk to a JPEG for the Svg
 * surfaces; on the terminal, a PNG file its `Image` reads whole (the image's
 * own file when it is one, or the decoded bytes when a tool sent a PNG).
 * A file is read as bytes only when small; else `sips` reads it in place.
 */
const takeToolImage = async ($: $T, image: ImageIn, label: string, meta: FrameMeta): Promise<void> => {
  try {
    const at = await $.clock.now()
    const isTerminal = await drawsOnTerminal($)
    const isPng = image.mime === 'image/png'
    let b64: string
    let mime = image.mime
    let pngPath: string | undefined
    if (image.path !== undefined) {
      const base = await tmpBase($)
      const isSmall = image.size !== undefined && image.size <= Math.floor((MAX_SVG_B64 * 3) / 4)
      const read = isSmall ? (await $.fs.read(image.path, { as: 'bytes' })).base64 : undefined
      if (read !== undefined && read.length <= MAX_SVG_B64) b64 = read
      else {
        const frame = await toSvgFrame($, image.path, `${base}file.jpg`)
        b64 = frame.b64
        mime = 'image/jpeg'
      }
      if (isTerminal && isPng) pngPath = image.path
      else if (isTerminal) {
        const png = `${base}file.png`
        const r = await $.process.run(['sips', '-s', 'format', 'png', image.path, '--out', png], { timeoutMs: 15_000 })
        if (sipsError(r) === undefined) pngPath = png
      }
    } else {
      const data = image.data ?? ''
      const needsShrink = data.length > MAX_SVG_B64
      // A small PNG draws from its base64 on the terminal; anything else as a file.
      const needsFile = isTerminal && (!isPng || needsShrink)
      b64 = data
      if (needsShrink || needsFile) {
        const base = await tmpBase($)
        const ext = isPng ? 'png' : image.mime === 'image/webp' ? 'webp' : image.mime === 'image/gif' ? 'gif' : 'jpg'
        const raw = `${base}tool-raw.${ext}`
        const decode = await $.process.run(['base64', '-D', '-o', raw], { stdin: data, timeoutMs: 15_000 })
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
    }
    const dims = imageSize(b64)
    const frame: CockpitFrame = { key: meta.key, source: meta.source, label, b64, mime, width: dims?.width, height: dims?.height, at }
    if (meta.eventId !== undefined) frame.eventId = meta.eventId
    if (meta.app !== undefined) {
      frame.app = meta.app.name
      frame.appColor = meta.app.color
    }
    await putFrame($, frame)
    await showOnScreen($, { source: meta.source, label, app: meta.app?.name, appColor: meta.app?.color, eventId: meta.eventId, b64, mime, width: dims?.width, height: dims?.height, pngPath, at })
  } catch (err) {
    const what = meta.source === 'file' ? 'Image file' : 'Tool screenshot'
    await quiet(() => setScreen($, s => ({ ...s, error: `${what}: ${messageOf(err).slice(0, 160)}` })))
  }
}

/** What tells one picture from another: its call, else its bytes or file. */
const imageKey = (image: ImageIn, meta: FrameMeta): string => {
  if (meta.eventId !== undefined) return `ev:${meta.eventId}`
  if (image.path !== undefined) return `file:${image.path}:${image.size ?? 0}`
  const data = image.data ?? ''
  return `b64:${data.length}:${data.slice(0, 48)}:${data.slice(-48)}`
}

/** The oldest image waiting, taken off the queue. */
const takePending = (): ToolImage | undefined => {
  for (const [key, one] of pendingImages) {
    pendingImages.delete(key)
    return one
  }
  return undefined
}

/**
 * Images one at a time: one waits per frame (a newer picture for the same
 * frame replaces it), so pictures of several sources all land. The same
 * picture twice (a result and its transcript row) is shown once.
 */
const queueToolImage = async ($: $T, image: ImageIn, label: string, meta: FrameMeta): Promise<void> => {
  const key = imageKey(image, meta)
  if (key === lastImageKey) return
  lastImageKey = key
  pendingImages.delete(meta.key)
  pendingImages.set(meta.key, { image, label, meta })
  while (pendingImages.size > MAX_PENDING_IMAGES) takePending()
  if (isTakingImage) return
  isTakingImage = true
  try {
    for (let next = takePending(); next !== undefined; next = takePending()) await takeToolImage($, next.image, next.label, next.meta)
  } finally {
    isTakingImage = false
  }
}

/** Turns Live on or off; on, its pace starts over and the caller takes the first look. */
const setLive = async ($: $T, isLive: (was: boolean) => boolean): Promise<boolean> => {
  const next = await update($, screenAtom, s => {
    const on = isLive(s.isLive)
    return { ...s, isLive: on, isWaiting: on ? s.isWaiting : undefined }
  })
  if (next.isLive) {
    liveMisses = 0
    liveNextTick = 0
    ensureTicker($)
  } else await quiet(() => dropFollowed($, key => key.startsWith('ios:') || key.startsWith('android:')))
  return next.isLive
}

// ---------------------------------------------------------------- labels
/** `get_viewport_screenshot` → `get viewport screenshot`. */
const pretty = (name: string): string => name.replace(/_/g, ' ')

/**
 * What a frame from a call is called: the app first when the registry knows
 * it ("Blender · get viewport screenshot", "OpenSCAD · out/p.png"), else the
 * MCP server and tool, the tool and its file, or the tool.
 */
const frameLabel = (tool: string, app: AppDef | undefined, file?: string): string => {
  const server = mcpServer(tool)
  const what = file !== undefined && file !== '' ? file : server !== undefined ? pretty(mcpToolName(tool)) : tool
  if (app !== undefined) return `${app.name} · ${what}`
  if (server !== undefined) return tool.split('__').slice(1).join(' · ').replace(/_/g, ' ')
  return file !== undefined && file !== '' ? `${tool} · ${file}` : tool
}

/** The file a call names, as the person would say it (relative to the session). */
const fileOfCall = (input: Record<string, unknown>, cwd: string): string | undefined => {
  const path = str(input.file_path) ?? str(input.notebook_path)
  if (path === undefined) return undefined
  return cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : basename(path)
}

/** A call's input as its row kept it (pretty JSON); nothing when it was cut short. */
const inputOf = (ev: CockpitEvent | null | undefined): Record<string, unknown> => {
  if (ev === null || ev === undefined) return {}
  try {
    return obj(JSON.parse(ev.input) as unknown)
  } catch {
    return {}
  }
}

const sessionCwd = async ($: $T): Promise<string> => {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

const homeDir = async ($: $T): Promise<string> => {
  try {
    return (await $.env.get('HOME')) ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- app registry
/** Built-ins, then ~/.claude/cockpit.json, then the project's .cockpit.json (each wins by id). */
const loadApps = async ($: $T, cwd: string): Promise<void> => {
  const lists: AppDef[][] = []
  const home = await homeDir($)
  const paths = [home !== '' ? `${home}/.claude/cockpit.json` : '', cwd !== '' ? `${cwd.replace(/\/$/, '')}/.cockpit.json` : '']
  for (const path of paths) {
    if (path === '') continue
    try {
      const text = await $.fs.read(path)
      lists.push(appsFromConfig(JSON.parse(text) as unknown).apps)
    } catch {
      // no file, or not JSON: the built-ins alone
    }
  }
  apps = mergeApps(BUILTIN_APPS, ...lists)
  shotTools.clear()
  noShotUntil.clear()
}

// ---------------------------------------------------------------- window capture (macOS)
/** One frame of an app's frontmost window, never the whole screen, into its frame `window:<name>`. */
const captureWindow = async ($: $T, name: string, opts: { eventId?: string; isManual?: boolean } = {}): Promise<void> => {
  if (isCapturingWindow) return
  isCapturingWindow = true
  const app = appForWindow(apps, name)
  try {
    if (opts.isManual === true) await patchScreen($, s => ({ ...s, isBusy: true }))
    const base = await tmpBase($)
    const png = `${base}window.png`
    const jpg = `${base}window.jpg`
    let listed: { exitCode: number; stdout: string; stderr: string }
    try {
      listed = await $.process.run(['osascript', '-l', 'JavaScript', '-e', WINDOW_JXA, name], { timeoutMs: 10_000 })
    } catch (err) {
      throw new Error(isMissing(err) ? 'Window capture works on macOS only (no osascript here).' : 'Listing the windows took too long.')
    }
    if (listed.exitCode !== 0) throw new Error(firstErrorLine(listed.stderr || listed.stdout) || `osascript failed (${listed.exitCode})`)
    const found = parseWindowInfo(listed.stdout)
    if (found === undefined) throw new Error('Could not read the window list.')
    if (found.id <= 0) throw new Error(`No on-screen window of ${name}.`)
    // Without Screen Recording no window title is visible: a capture would be blank.
    if (found.named === 0 && found.count > 0) throw new Error(SCREEN_RECORDING_HELP)
    const startedAt = await $.clock.now()
    let shot: { exitCode: number; stdout: string; stderr: string }
    try {
      shot = await $.process.run(['screencapture', '-x', '-o', '-l', String(found.id), png], { timeoutMs: 15_000 })
    } catch {
      throw new Error(SCREEN_RECORDING_HELP)
    }
    const stat = await $.fs.stat(png).catch(() => undefined)
    // A failed capture, an empty file or the previous frame left in place.
    const isFresh = stat !== undefined && stat.kind === 'file' && stat.size > 1000 && stat.mtimeMs >= startedAt - 5000
    if (shot.exitCode !== 0 || !isFresh) throw new Error(SCREEN_RECORDING_HELP)
    const frame = await toSvgFrame($, png, jpg)
    const at = await $.clock.now()
    windowFailures = 0
    const appName = app?.name ?? name
    const title = clean(found.title).slice(0, 120)
    const label = title !== '' && title !== appName ? `${appName} · ${title}` : appName
    const one: CockpitFrame = { key: `window:${name}`, source: 'window', label, b64: frame.b64, mime: 'image/jpeg', width: frame.width, height: frame.height, at, app: appName }
    if (app?.color !== undefined) one.appColor = app.color
    if (opts.eventId !== undefined) one.eventId = opts.eventId
    if (opts.isManual === true) one.isManual = true
    await putFrame($, one)
    await showOnScreen($, { source: 'window', label, app: appName, appColor: app?.color, eventId: opts.eventId, b64: frame.b64, mime: 'image/jpeg', width: frame.width, height: frame.height, pngPath: png, at })
  } catch (err) {
    const message = messageOf(err)
    const isDenied = message === SCREEN_RECORDING_HELP
    if (isDenied) windowDenied = true
    windowFailures += 1
    // Polled every 2 s; after failures, 4 s, 8 s, ... up to 30 s.
    windowRetryTick = tickCount + Math.min(30, 2 ** (windowFailures + 1))
    // Retrying without Screen Recording is pointless: that alone ends the watch, and says why.
    await quiet(() => setScreen($, s => ({ ...s, isBusy: false, watch: isDenied ? undefined : s.watch, error: message })))
  } finally {
    isCapturingWindow = false
  }
}

// ---------------------------------------------------------------- follow-ups after a call
/** The screenshot call that shows what a browser tool just did, if any. */
const screenshotCallFor = (e: ToolCallInput): { tool: string; args: Record<string, unknown> } | undefined => {
  const input = e as unknown as { action?: unknown; tabId?: unknown }
  if (input.action === 'screenshot' || input.action === 'zoom') return undefined
  const tab = typeof input.tabId === 'string' || typeof input.tabId === 'number' ? { tabId: input.tabId } : {}
  if (e.tool.startsWith('mcp__Claude_Browser__')) return { tool: 'mcp__Claude_Browser__computer', args: { action: 'screenshot', scale: 0.6, ...tab } }
  if (e.tool.startsWith('mcp__claude-in-chrome__') && 'tabId' in tab) return { tool: 'mcp__claude-in-chrome__computer', args: { action: 'screenshot', ...tab } }
  return undefined
}

/** The screenshot tool of an app's MCP server, among the session's tools. */
const findShotTool = async ($: $T, app: AppDef, tool: string): Promise<string | undefined> => {
  const server = mcpServer(tool)
  if (server === undefined) return undefined
  const known = shotTools.get(server)
  if (known !== undefined) return known === tool ? undefined : known
  const now = await $.clock.now()
  if ((noShotUntil.get(server) ?? 0) > now) return undefined
  const names = (await $.tool.list()).map(t => t.name)
  const found = appScreenshotTool(app, tool, names)
  if (found !== undefined) shotTools.set(server, found)
  // None at all on this server (asked as from no tool of it): not asked again for a minute.
  else if (appScreenshotTool(app, `mcp__${server}__`, names) === undefined) noShotUntil.set(server, now + 60_000)
  return found
}

/** Arguments a config may give a screenshot tool, the envelope's keys kept out. */
const shotArgs = (app: AppDef): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(app.screenshot?.args ?? {})) if (key !== 'tool' && key !== 'tool_use_id') out[key] = value
  return out
}

/**
 * Once an app's actions pause, look at it: its own MCP screenshot tool when
 * the check allows it without asking the person, else its window when the
 * registry names one.
 */
const scheduleAppShot = ($: $T, e: ToolCallInput, app: AppDef): void => {
  const isMcp = mcpServer(e.tool) !== undefined
  if (isMcp && isShotTool(e.tool)) return
  if (!isMcp && app.window === undefined) return
  shotTimer?.cancel()
  shotTimer = $.clock.after(SHOT_DELAY_MS, () => {
    shotTimer = undefined
    void quiet(async () => {
      if (isMcp) {
        const shotTool = await findShotTool($, app, e.tool)
        if (shotTool !== undefined) {
          const args = shotArgs(app)
          const verdict = await $.tool.check({ tool: shotTool, input: args })
          if (verdict.decision === 'allow') {
            const shot: ToolCallResult = await $.tool.call({ tool: shotTool, ...args } as never)
            const found = deepImages(shot.result)
            const last = found[found.length - 1]
            if (last !== undefined) {
              await queueToolImage($, last, frameLabel(shotTool, app), { source: 'tool', key: frameKeyFor(shotTool, args), app, eventId: e.tool_use_id })
              return
            }
          }
        }
      }
      if (app.window !== undefined && !windowDenied) await captureWindow($, app.window, { eventId: e.tool_use_id })
    })
  })
}

/**
 * After a browser action whose result held no picture, look at the screen:
 * the simulator through simctl, a browser through its own screenshot tool
 * (only where that call is allowed without asking the person).
 */
const scheduleShot = ($: $T, e: ToolCallInput): void => {
  const isSim = e.tool.startsWith('mcp__Claude_Code_iOS_Simulator__')
  const call = isSim ? undefined : screenshotCallFor(e)
  if (!isSim && call === undefined) return
  shotTimer?.cancel()
  shotTimer = $.clock.after(SHOT_DELAY_MS, () => {
    shotTimer = undefined
    void quiet(async () => {
      // The simulator Claude drove: every booted one is looked at, tied to the call.
      if (isSim) return void (await captureDevices($, { reason: 'call', only: 'ios', eventId: e.tool_use_id }))
      if (call === undefined) return
      const verdict = await $.tool.check({ tool: call.tool, input: call.args })
      if (verdict.decision !== 'allow') return
      const shot: ToolCallResult = await $.tool.call({ tool: call.tool, ...call.args } as never)
      const found = deepImages(shot.result)
      const last = found[found.length - 1]
      const app = appForCall(apps, call.tool, {})
      if (last !== undefined)
        await queueToolImage($, last, frameLabel(call.tool, app), { source: 'tool', key: frameKeyFor(call.tool, call.args), app, eventId: e.tool_use_id })
    })
  })
}

/**
 * What follows a call Claude made: any image in its result goes to the
 * screen (any tool: a Read of a PNG, an MCP render); else the screen it
 * drove is looked at. A command's files are looked at once it ended.
 */
const followUp = ($: $T, e: ToolCallInput, r: ToolCallResult, app: AppDef | undefined): void => {
  if (r.deny !== undefined) return
  const images = deepImages(r.result)
  const last = images[images.length - 1]
  if (last !== undefined) {
    const input = e as unknown as Record<string, unknown>
    $.clock.after(0, () =>
      void quiet(async () => {
        const file = fileOfCall(input, await sessionCwd($))
        await queueToolImage($, last, frameLabel(e.tool, app, file), { source: 'tool', key: frameKeyFor(e.tool, input), app, eventId: e.tool_use_id })
      }),
    )
    return
  }
  if (e.tool === 'Bash') return
  if (isScreenTool(e.tool) && app?.screenshot === undefined && app?.window === undefined) return scheduleShot($, e)
  if (app !== undefined) scheduleAppShot($, e, app)
}

/** Files a command named and changed since it started: newest first. */
const freshFiles = async ($: $T, paths: readonly string[], dir: string, home: string, since: number): Promise<{ path: string; size: number; mtimeMs: number }[]> => {
  const out: { path: string; size: number; mtimeMs: number }[] = []
  for (const p of paths) {
    const path = resolvePath(p, dir, home)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat !== undefined && stat.kind === 'file' && stat.mtimeMs >= since) out.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Adds a call's row to the feed index; rows past the bound are dropped. */
const pushFeed = async ($: $T, id: string, agentId: string | undefined): Promise<void> => {
  let evicted: string[] = []
  await feedQ($, list => {
    const next = [...list.filter(one => one.id !== id), agentId !== undefined ? { id, agent: agentId } : { id }]
    evicted = next.slice(0, Math.max(0, next.length - MAX_EVENTS)).map(one => one.id)
    return next.slice(-MAX_EVENTS)
  })
  for (const gone of evicted) await $.state.set({ plugin: 'cockpit', key: 'event', id: gone }, null)
}

/**
 * A command ended: the image it wrote goes to the screen (`openscad -o
 * out/p.png`, `blender -b x.blend -o //r.png -f 1`), the binary assets it
 * changed get an asset card. Returns whether an image was shown.
 */
const afterCommand = async ($: $T, ev: CockpitEvent, command: string, app: AppDef | undefined, now: number): Promise<boolean> => {
  const images = pathsInCommand(command, IMAGE_EXT)
  const assets = pathsInCommand(command, BINARY_EXT)
  if (images.length === 0 && assets.length === 0) return false
  const cwd = await sessionCwd($)
  const home = await homeDir($)
  const dir = commandDir(command, cwd, home)
  // Written during the call (a little slack for the file system's clock).
  const since = ev.startedAt - 2000
  let isShown = false
  const written = (await freshFiles($, images, dir, home, since))[0]
  const mime = written !== undefined ? mimeOfPath(written.path) : undefined
  if (written !== undefined && mime !== undefined) {
    const shown = cwd !== '' && written.path.startsWith(`${cwd}/`) ? written.path.slice(cwd.length + 1) : basename(written.path)
    await queueToolImage($, { path: written.path, size: written.size, mime }, frameLabel(ev.tool, app, shown), { source: 'file', key: `file:${written.path}`, app, eventId: ev.id })
    isShown = true
  }
  const changed = (await freshFiles($, assets, dir, home, since)).slice(0, 4)
  for (const [i, asset] of changed.entries()) {
    const own = appForCall(apps, 'Write', { file_path: asset.path }) ?? app
    const assetEv: CockpitEvent = {
      id: `${ev.id}~asset${i}`,
      tool: ev.tool,
      cat: 'edit',
      title: basename(asset.path),
      detail: asset.path,
      agentId: ev.agentId,
      status: 'ok',
      startedAt: ev.startedAt,
      endedAt: now,
      input: '',
      filePath: asset.path,
      added: 0,
      removed: 0,
      app: own?.id,
    }
    await $.state.set({ plugin: 'cockpit', key: 'event', id: assetEv.id }, assetEv)
    await pushFeed($, assetEv.id, ev.agentId)
    await recordChanges($, assetEv, [{ path: asset.path, hunks: [], isBinary: true, size: asset.size, added: 0, removed: 0 }], now)
  }
  return isShown
}

// ================================================================ status, milestones, ticker
/**
 * The summary lives beside the mode labels (SessionMode), which redraws from
 * the state it reads; the engine's status line, which would print the
 * plugin's name before it, is cleared once.
 */
const refreshStatus = async ($: $T): Promise<void> => {
  if (lastStatus === 'cleared') return
  lastStatus = 'cleared'
  $.ui.status(undefined)
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
 * Once a second while the pane is open: the clock for elapsed times, Live's
 * looks at the devices, the watched window, agent statuses. Stops once the
 * pane is closed; whatever opens it again (or a tool call) starts it.
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
    const isTerminal = await drawsOnTerminal($)
    // Each write of `now` redraws the pane: every second while something
    // runs (its elapsed time ticks), else every 30 s, enough for the ages
    // (to the minute) and for a frame to leave NOW. Never the second on the
    // terminal's Screen tab, which would send its picture again.
    const isRunning = stats.running > 0 || agents.some(a => a.status === 'running')
    if ((isRunning && !(isTerminal && ui.tab === 'screen')) || tickCount % NOW_SLOW_TICKS === 0) await markNow($, await $.clock.now())
    const screen = await read($, screenAtom)
    // The desktop's live view shows the screens at all times; the terminal on its Screen tab.
    const isInView = !isTerminal || ui.tab === 'screen'
    if (isInView && screen.watch !== undefined && tickCount % 2 === 0 && tickCount >= windowRetryTick) void captureWindow($, screen.watch)
    if (isInView && screen.isLive && !isCapturingDevices && tickCount >= liveNextTick) {
      liveNextTick = tickCount + LIVE_EVERY
      void captureDevices($, { reason: 'live' })
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
const onToolStart = async ($: $T, e: ToolCallInput, app: AppDef | undefined): Promise<CockpitEvent> => {
  const now = await $.clock.now()
  const input = e as unknown as Record<string, unknown>
  const tool = String(e.tool)
  const d = describe(input)
  // An app's command says what it does to the app: "Blender · Render".
  const appTitle = app !== undefined && tool === 'Bash' ? appCommandTitle(app, str(input.command) ?? '') : undefined
  const ev: CockpitEvent = {
    id: e.tool_use_id,
    tool,
    cat: categorize(tool),
    title: clip(clean(appTitle ?? d.title), 200),
    detail: d.detail !== undefined ? clip(clean(d.detail), 400) : undefined,
    agentId: e.agentId,
    status: 'running',
    startedAt: now,
    input: prettyInput(input),
    filePath: d.filePath !== undefined ? clean(d.filePath) : undefined,
    isTest: d.isTest,
    isBackground: d.isBackground,
    app: app?.id,
  }
  await $.state.set({ plugin: 'cockpit', key: 'event', id: ev.id }, ev)
  await pushFeed($, ev.id, e.agentId)
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
      isBinary: change.isBinary,
      size: change.size,
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

/** A binary asset a call wrote: its size, never a diff of its bytes as text. */
const asAsset = async ($: $T, change: FileChange): Promise<FileChange> => {
  if (!isBinaryAsset(change.path)) return change
  const stat = await $.fs.stat(change.path).catch(() => undefined)
  return { path: change.path, hunks: [], isCreated: change.isCreated, isBinary: true, size: stat?.size, added: 0, removed: 0 }
}

const onToolEnd = async ($: $T, e: ToolCallInput, ev: CockpitEvent, r: ToolCallResult, app: AppDef | undefined): Promise<void> => {
  const now = await $.clock.now()
  const input = e as unknown as Record<string, unknown>
  const tool = ev.tool
  const status: CockpitStatus = r.deny !== undefined ? 'denied' : r.isError === true ? 'error' : 'ok'
  // A turn's end may already have closed this row (reconcile): count it once.
  const current = await read($, { plugin: 'cockpit', key: 'event', id: ev.id })
  const wasRunning = current?.status !== 'error' || current.endedAt === undefined
  const { output, exitCode } = outputOf(tool, r)
  const changes: FileChange[] = []
  for (const change of status === 'ok' ? changesOf(input, r) : []) changes.push(await asAsset($, change))
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

  // A command: the image it wrote shows, the assets it changed get a card;
  // else an app with a window of its own is looked at.
  if (tool === 'Bash' && status !== 'denied' && ev.isBackground !== true) {
    const isShown = await afterCommand($, done, str(input.command) ?? '', app, now)
    if (!isShown && app !== undefined && app.window !== undefined) scheduleAppShot($, e, app)
  }

  // A command just drove a simulator or an emulator: look at it, tied to the
  // command, where its screen is in view (an MCP simulator call is looked at
  // by its follow-up).
  const command = str(input.command) ?? ''
  if (tool === 'Bash' && status !== 'denied' && touchesDevice(tool, command)) {
    const ui = await read($, uiAtom)
    if (ui.tab === 'screen' || !(await drawsOnTerminal($))) {
      const only = /\badb\b/.test(command) ? 'android' : 'ios'
      $.clock.after(400, () => void captureDevices($, { reason: 'call', only, eventId: ev.id }))
    }
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
  const frameKeys = await read($, frameKeysAtom)
  await statsQ($, s => ({ ...EMPTY_STATS, startedAt: now, milestones: s.milestones }))
  await feedQ($, () => [])
  await filesQ($, () => [])
  await agentsQ($, () => [])
  await update($, workflowsAtom, () => [])
  await setScreen($, s => ({ ...EMPTY_SCREEN, isLive: s.isLive, watch: s.watch }))
  await update($, frameKeysAtom, () => [])
  lastImageKey = ''
  pendingImages.clear()
  await update($, uiAtom, u => ({ ...u, filter: 'all', expanded: null, file: null, agent: null, limit: EMPTY_UI.limit, offset: 0, openRuns: [], showAllAgents: false, open: [] }))
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
  for (const key of frameKeys) {
    if (deadline()) return
    await $.state.set({ plugin: 'cockpit', key: 'frame', id: key }, null)
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
const COMMAND_WORDS = 'feed, files, agents, screen, live [on|off], watch <App>|off, close'

// ================================================================ registration
export const register: Register = (on, options) => {
  // userConfig `autoOpen` (default on): open the pane unasked where it docks.
  const isAutoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await quiet(async () => {
      // A status line left by an older copy of the module: gone at once.
      lastStatus = ''
      await refreshStatus($)
      // The summary beside the modes draws from the load on, not from the
      // next tool call: the sites this plugin draws are asked again.
      $.clock.after(0, () => $.ui.invalidate('ui.render'))
      // A reload finds the pane as the engine kept it.
      const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
      await update($, uiAtom, u => ({ ...u, isPaneShown: isUp }))
      if (e.surface !== null) await $.state.set({ plugin: 'cockpit', key: 'surface' }, e.surface)
      await $.command.register({
        name: 'cockpit',
        description: 'Live view of what Claude is doing: commands, diffs, agents, screen',
        argumentHint: '[feed|files|agents|screen|live [on|off]|watch <App>|watch off|close]',
        immediate: true,
      })
      // Which apps the session's tools and commands are recognised as.
      await loadApps($, e.cwd ?? (await sessionCwd($)))
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
    let app: AppDef | undefined
    try {
      ensureTicker($)
      app = appForCall(apps, e.tool, e as unknown as Record<string, unknown>)
      started = onToolStart($, e, app).catch(() => undefined)
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
      followUp($, e, r, app)
    } catch {
      // the screen stays as it was
    }
    try {
      if (ev !== undefined) $.clock.after(0, () => void quiet(() => onToolEnd($, e, ev, r, app)))
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

  // Any image a tool's result row carries: what Claude sees, the person sees.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    try {
      const origin = e.origin as { kind?: string; tool?: string }
      if (origin.kind === 'tool' && typeof origin.tool === 'string') {
        const tool = origin.tool
        const images = findImages(e.message.content)
        const last = images[images.length - 1]
        if (last !== undefined) {
          $.clock.after(0, () =>
            void quiet(async () => {
              // The call's own row says which file, tab and app it was.
              const ev = last.toolUseId !== undefined ? await read($, { plugin: 'cockpit', key: 'event', id: last.toolUseId }) : undefined
              const app = ev?.app !== undefined ? apps.find(a => a.id === ev.app) : appForCall(apps, tool, {})
              const isRead = ev?.detail !== undefined && ev.tool === 'Read'
              const file = isRead ? fileOfCall({ file_path: ev.detail }, await sessionCwd($)) : undefined
              const key = frameKeyFor(tool, isRead ? { file_path: ev.detail } : inputOf(ev))
              await queueToolImage($, last, frameLabel(tool, app, file), { source: 'tool', key, app, eventId: last.toolUseId })
            }),
          )
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
    if (word === 'watch') {
      // `/cockpit watch <App name>`: the name as typed (macOS names its windows' owner so).
      const name = clip(clean(e.args.trim().slice(5).trim()), 80)
      const screen = await read($, screenAtom)
      if (name === '') {
        return {
          text:
            screen.watch !== undefined
              ? `Cockpit is watching ${screen.watch}. /cockpit watch off stops.`
              : 'Usage: /cockpit watch <App name> (macOS; needs Screen Recording), /cockpit watch off.',
        }
      }
      if (name.toLowerCase() === 'off') {
        await setScreen($, s => ({ ...s, watch: undefined, error: undefined }))
        if (screen.watch !== undefined) await quiet(() => dropFollowed($, key => key === `window:${screen.watch}`))
        if (screen.watch !== undefined) $.ui.toast(`Cockpit · stopped watching ${screen.watch}`, { timeoutMs: 3000 })
        return {}
      }
      windowDenied = false
      windowFailures = 0
      windowRetryTick = 0
      await setScreen($, s => ({ ...s, watch: name, error: undefined }))
      ensureTicker($)
      await update($, uiAtom, (u): CockpitUi => ({ ...u, tab: 'screen', offset: 0 }))
      const opened = await $.ui.open({ id: PANE, title: 'Cockpit', focus: true })
      if (opened.isPlaced) await update($, uiAtom, u => ({ ...u, isPaneShown: true }))
      $.ui.toast(`Cockpit · watching ${name} ●`, { timeoutMs: 3000 })
      $.clock.after(0, () => void captureWindow($, name, { isManual: true }))
      return opened.isPlaced ? {} : { text: `Watching ${name}, but Cockpit could not open here: ${opened.reason}` }
    }
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
      if (isLive) $.clock.after(0, () => void captureDevices($, { reason: 'live' }))
    }
    if (tab === 'screen' && live === undefined) $.clock.after(0, () => void captureDevices($, { reason: 'manual' }))
    return {}
  })

  // The person closed the pane (its mark, a key): the opener shows again.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) await quiet(() => update($, uiAtom, u => ({ ...u, isPaneShown: false })))
    return r
  }).catch(($, e, next) => next(e))

  // The footer chip, beside the mode labels under the prompt: a glance at
  // the session and one click to open or close the pane.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
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
          .then(isLive => (isLive ? captureDevices($, { reason: 'live' }) : undefined))
          .catch(() => undefined)
      },
      capture: () => {
        // A watched window is what "capture" means while it is watched; the devices too while Live follows them.
        if (screen.watch !== undefined) void captureWindow($, screen.watch, { isManual: true })
        if (screen.watch === undefined || screen.isLive) void captureDevices($, { reason: 'manual' })
      },
    }
    const k: Kit = {
      apps: new Map(apps.map(a => [a.id, badgeOf(a)])),
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
      // The frames kept, newest first: the screens under NOW, or in the history at their call.
      const frames: CockpitFrame[] = []
      for (const key of await read($, frameKeysAtom)) {
        const frame = await read($, { plugin: 'cockpit', key: 'frame', id: key })
        if (frame !== null && frame !== undefined) frames.push(frame)
      }
      const plan = planLive({ events, agents, workflows, frames, changes, now, isLive: screen.isLive, watch: screen.watch, isWorking: stats.isWorking })
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
          if (screen.watch !== undefined) void captureWindow($, screen.watch, { isManual: true })
          else if (screen.b64 === undefined || screen.source === 'ios' || screen.source === 'android') void captureDevices($, { reason: 'manual' })
        })}
        {body}
        <Box key="foot" marginTop={1}>
          {footer(k)}
        </Box>
      </Box>
    )
  })
}
