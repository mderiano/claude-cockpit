import { describe, expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { CockpitAgent, CockpitChange, CockpitEvent, CockpitFeedRef, CockpitFile, CockpitFrame, CockpitScreen, CockpitStats, CockpitUi, CockpitWorkflow } from '../types'

import { statusLine } from '../hooks/capture'
import { diffLines, diffTexts, renderHunks } from '../hooks/diff'
import { addFrameKey, fullCommand, momentKey, planLive, toggleOpen, trimDiff } from '../hooks/live'
import type { LiveInput } from '../hooks/live'
import { clean, EMPTY_SCREEN, EMPTY_STATS, sparkText } from '../hooks/model'
import { imageSize, parseSimctl, sipsError } from '../hooks/screen'
import { appCommandTitle, appForCall, appsFromConfig, appScreenshotTool, BINARY_EXT, BUILTIN_APPS, IMAGE_EXT, mergeApps, pathsInCommand, resolvePath, SCREEN_RECORDING_HELP } from '../hooks/apps'

const SURFACES = ['terminal', 'desktop'] as const
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

/** Every Svg the live view (desktop, vscode, mobile) drew, its markup joined. */
type Drawn = { findAll: (q: { type: string }) => Promise<{ key?: string; props: Record<string, unknown>; text?: string; children?: unknown[] }[]> }
const drawnSvg = async (ui: Drawn): Promise<string> => (await ui.findAll({ type: 'Svg' })).map(one => String(one.props.source)).join('\n')

const paneProps = (bodyColumns = 80, bodyRows = 40) => ({
  title: 'Cockpit',
  isFocused: true,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows },
  view: {},
})

/** A plugin that reads cockpit's state back through a `/spy <key> [id]` command. */
const spy: Plugin = {
  name: 'spy',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'spy', description: 'reads cockpit state' })
      await $.command.register({ name: 'spyset', description: 'writes cockpit state' })
      return next(e)
    })
    // `/spyset <key>[:<id>] <json>`: seeds a state the test cannot reach otherwise.
    on('command.run', { command: 'spyset' }, async ($, e) => {
      const at = e.args.indexOf(' ')
      const [key = '', id] = e.args.slice(0, at).split(':')
      const value = JSON.parse(e.args.slice(at + 1)) as never
      if (key === 'event' && id !== undefined) await $.state.set({ plugin: 'cockpit', key: 'event', id }, value)
      else if (key === 'feed') await $.state.set({ plugin: 'cockpit', key: 'feed' }, value)
      else if (key === 'stats') await $.state.set({ plugin: 'cockpit', key: 'stats' }, value)
      else if (key === 'screen') await $.state.set({ plugin: 'cockpit', key: 'screen' }, value)
      return { text: 'ok' }
    })
    on('command.run', { command: 'spy' }, async ($, e) => {
      const [key = '', ...rest] = e.args.split(' ')
      const id = rest.join(' ')
      let value: unknown
      if (key === 'feed') value = (await $.state.get({ plugin: 'cockpit', key: 'feed' })).value
      else if (key === 'files') value = (await $.state.get({ plugin: 'cockpit', key: 'files' })).value
      else if (key === 'agents') value = (await $.state.get({ plugin: 'cockpit', key: 'agents' })).value
      else if (key === 'workflows') value = (await $.state.get({ plugin: 'cockpit', key: 'workflows' })).value
      else if (key === 'stats') value = (await $.state.get({ plugin: 'cockpit', key: 'stats' })).value
      else if (key === 'ui') value = (await $.state.get({ plugin: 'cockpit', key: 'ui' })).value
      else if (key === 'screen') value = (await $.state.get({ plugin: 'cockpit', key: 'screen' })).value
      else if (key === 'event') value = (await $.state.get({ plugin: 'cockpit', key: 'event', id })).value
      else if (key === 'changes') value = (await $.state.get({ plugin: 'cockpit', key: 'changes', id })).value
      else if (key === 'frame') value = (await $.state.get({ plugin: 'cockpit', key: 'frame', id })).value
      else if (key === 'frameKeys') value = (await $.state.get({ plugin: 'cockpit', key: 'frameKeys' })).value
      return { text: JSON.stringify(value ?? null) }
    })
  },
}
const WITH_SPY = { plugins: [spy] }

type Peek = {
  feed: CockpitFeedRef[]
  files: CockpitFile[]
  agents: CockpitAgent[]
  workflows: CockpitWorkflow[]
  stats: CockpitStats
  ui: CockpitUi
  screen: CockpitScreen
  event: CockpitEvent | null
  changes: CockpitChange[] | null
  frame: CockpitFrame | null
  frameKeys: string[]
}
const ORIGIN = { kind: 'composer' as const }
const PRESENTATION = { isFullscreen: true, columns: 120 }
type CommandRunner = { command: { run: (input: { command: string; args: string; origin: typeof ORIGIN; presentation: typeof PRESENTATION }) => Promise<{ text?: string }> } }
const seed = async ($: CommandRunner, key: string, value: unknown): Promise<void> => {
  await $.command.run({ command: 'spyset', args: `${key} ${JSON.stringify(value)}`, origin: ORIGIN, presentation: PRESENTATION })
}
const peek = async <K extends keyof Peek>($: CommandRunner, key: K, id = ''): Promise<Peek[K] | null> => {
  const r = await $.command.run({ command: 'spy', args: id === '' ? key : `${key} ${id}`, origin: ORIGIN, presentation: PRESENTATION })
  return JSON.parse(r.text ?? 'null') as Peek[K] | null
}

type RunOut = { exitCode?: number; stdout?: string; stderr?: string }
type StatOut = { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }
/** What a test scripts of the world: processes, files, the session's tools. */
type World = {
  run?: (argv: readonly string[]) => RunOut | undefined
  stat?: (path: string) => StatOut | undefined
  read?: (path: string) => string | { base64: string } | undefined
  tools?: string[]
}

/** The engine beneath the plugin: everything it may ask, answered from memory. */
const engine = (on: On, world: World = {}) => {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { TMPDIR: '/tmp/', HOME: '/Users/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  const closed: string[] = []
  const pane = { isUp: false }
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: pane.isUp ? [{ id: 'cockpit', title: 'Cockpit', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/proj' }))
  // No simulator, no adb: the capture reports it plainly.
  const argvs: string[][] = []
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    const custom = world.run?.(e.argv)
    if (custom !== undefined)
      return { value: { exitCode: 0, stdout: '', stderr: '', ...custom, isStdoutTruncated: false, isStderrTruncated: false } }
    return {
      value: {
        exitCode: e.argv[0] === 'xcrun' ? 0 : 1,
        stdout: e.argv[0] === 'xcrun' ? '{"devices":{}}' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  // No file unless the test says so (no config, no image).
  on('fs.stat', ($, e) => {
    const s = world.stat?.(e.path)
    if (s === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { ...s, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const v = world.read?.(e.path)
    if (v === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: v }
  })
  on('tool.list', () => ({ value: (world.tools ?? []).map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) }))
  return { toasts, statuses, clock, opened, closed, pane, argvs }
}

describe('cockpit', () => {
  test('a Bash call lands in the feed with its output and an ok status', WITH_SPY, async ($, on) => {
    const { statuses, clock } = engine(on)
    on('tool.call', ($, e) => ({
      result: { stdout: 'PASS src/a.test.ts\nAll good: 12 tests', stderr: '', interrupted: false },
      text: 'All good',
    }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests', tool_use_id: 'b1' })
    // The result reaches the model untouched.
    expect(r.text).toBe('All good')
    // The bookkeeping follows the result, once its dispatch resolved.
    await clock.settle()
    const ev = { value: await peek($, 'event', 'b1') }
    expect(ev.value).toMatchObject({ tool: 'Bash', cat: 'shell', status: 'ok', exitCode: 0, isTest: true })
    expect(ev.value?.output).toContain('All good: 12 tests')
    const stats = { value: await peek($, 'stats') }
    expect(stats.value).toMatchObject({ calls: 1, commands: 1, running: 0, errors: 0, streak: 1 })
    expect(stats.value?.milestones).toContain('tests-green')
    // No status line: the engine would print the plugin's name before it.
    expect(statuses.every(s => s === undefined)).toBe(true)
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: paneProps() })
      if (surface === 'terminal') {
        expect(await ui.find({ text: /Run the tests/ })).toBeDefined()
        expect(await ui.find({ text: /All good: 12 tests/ })).toBeDefined()
        expect(await ui.find({ text: /\$ npm test/ })).toBeDefined()
        // Expanding the row shows the command and the full output.
        await ui.press({ key: 'ev-b1' })
        const codes = await ui.findAll({ type: 'Code' })
        expect(codes.some(c => c.props.source === 'npm test')).toBe(true)
        expect(codes.some(c => String(c.props.source).includes('PASS src/a.test.ts'))).toBe(true)
        await ui.press({ key: 'ev-b1' })
      } else {
        // The live view: nothing runs, so no NOW; the command just made tops
        // the history, drawn as a terminal with its output.
        const svg = await drawnSvg(ui)
        expect(svg).not.toContain('NOW')
        expect(svg).toContain('HISTORY')
        expect(svg).toContain('Run the tests')
        expect(svg).toContain('npm test')
        expect(svg).toContain('All good: 12 tests')
        expect(await ui.find({ key: 'tab-feed' })).toBeUndefined()
        // Short and whole: nothing more to unfold.
        expect(await ui.find({ key: 'cmd:b1' })).toBeUndefined()
      }
      await ui.unmount()
    }
  })

  test('a failing or denied call is shown as such and the answer is relayed unchanged', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', ($, e) =>
      e.tool_use_id === 'd1' ? { deny: 'nope' } : { isError: true as const, result: 'Exit code 2\nboom', text: 'Exit code 2\nboom' },
    )
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const failed = await $.tool.call({ tool: 'Bash', command: 'false', tool_use_id: 'e1' })
    expect(failed.isError).toBe(true)
    expect(failed.text).toBe('Exit code 2\nboom')
    const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf x', tool_use_id: 'd1' })
    expect(denied.deny).toBe('nope')
    await clock.settle()
    const e1 = { value: await peek($, 'event', 'e1') }
    expect(e1.value).toMatchObject({ status: 'error', exitCode: 2 })
    const d1 = { value: await peek($, 'event', 'd1') }
    expect(d1.value?.status).toBe('denied')
    const stats = { value: await peek($, 'stats') }
    expect(stats.value).toMatchObject({ errors: 1, denied: 1, streak: 0 })
  })

  test('an Edit records the file and a unified diff', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', ($, e) => ({
      result: {
        filePath: '/proj/src/app.ts',
        oldString: 'const a = 1',
        newString: 'const a = 2',
        originalFile: 'line1\nconst a = 1\nline3\n',
        structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' line1', '-const a = 1', '+const a = 2', ' line3'] }],
        userModified: false,
        replaceAll: false,
      },
      text: 'The file was updated.',
    }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/app.ts', old_string: 'const a = 1', new_string: 'const a = 2', tool_use_id: 'ed1' })
    await clock.settle()
    const files = { value: await peek($, 'files') }
    expect(files.value?.[0]).toMatchObject({ path: '/proj/src/app.ts', added: 1, removed: 1, edits: 1 })
    const changes = { value: await peek($, 'changes', '/proj/src/app.ts') }
    const diff = changes.value?.[0]?.diff ?? ''
    expect(diff.startsWith('@@ -1,3 +1,3 @@')).toBe(true)
    expect(diff).toContain('+const a = 2')
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      if (surface === 'terminal') await ui.press({ key: 'tab-files' })
      // On the live view the fresh edit is under NOW, its diff the native Code.
      const code = await ui.find({ type: 'Code' })
      expect(code?.props.format).toBe('diff')
      expect(String(code?.props.source).startsWith('@@')).toBe(true)
      expect(String(code?.props.source)).toContain('+const a = 2')
      if (surface === 'terminal') {
        expect(await ui.find({ text: /app\.ts/ })).toBeDefined()
        await ui.press({ key: 'tab-feed' })
      } else {
        expect(code?.props.path).toBe('/proj/src/app.ts')
        expect(await drawnSvg(ui)).toContain('app.ts')
      }
      await ui.unmount()
    }
  })

  test('a Write that creates a file is all added lines', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', () => ({
      result: { type: 'create', filePath: '/proj/new.md', content: '# Hi\nthere\n', structuredPatch: [], originalFile: null },
      text: 'created',
    }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Write', file_path: '/proj/new.md', content: '# Hi\nthere\n', tool_use_id: 'w1' })
    await clock.settle()
    const changes = { value: await peek($, 'changes', '/proj/new.md') }
    expect(changes.value?.[0]?.diff).toBe('@@ -0,0 +1,2 @@\n+# Hi\n+there\n')
    const files = { value: await peek($, 'files') }
    expect(files.value?.[0]).toMatchObject({ isCreated: true, added: 2, removed: 0 })
  })

  test('a Write over a file too large to diff is no creation; a staged one is no change', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', ($, e) => ({
      result: {
        type: 'update',
        filePath: '/proj/big.txt',
        content: 'a\nb\nc\n',
        structuredPatch: [],
        originalFile: null,
        ...(e.tool_use_id === 'w-staged' ? { staged: true } : {}),
      },
      text: 'updated',
    }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Write', file_path: '/proj/big.txt', content: 'a\nb\nc\n', tool_use_id: 'w-big' })
    await $.tool.call({ tool: 'Write', file_path: '/proj/held.txt', content: 'x', tool_use_id: 'w-staged' })
    await clock.settle()
    const files = await peek($, 'files')
    expect(files).toHaveLength(1)
    expect(files?.[0]).toMatchObject({ path: '/proj/big.txt', added: 0, removed: 0 })
    expect(files?.[0]?.isCreated).not.toBe(true)
    expect((await peek($, 'changes', '/proj/big.txt'))?.[0]).toMatchObject({ diff: '', isTooLarge: true })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      if (surface === 'terminal') await ui.press({ key: 'tab-files' })
      expect(await ui.find({ text: /too large for a diff/ })).toBeDefined()
      if (surface !== 'terminal') expect(await drawnSvg(ui)).toContain('big.txt')
      await ui.unmount()
    }
  })

  test('a subagent and its tool calls are attributed to its agentId', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('agent.spawn', () => ({ model: 'claude-haiku', agentId: 'ag-1' }))
    on('tool.call', () => ({ result: { type: 'text', file: { filePath: '/proj/x.ts', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'x' }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const spawned = await $.agent.spawn({
      tool_use_id: 'agent-call-1',
      prompt: 'Find the bug',
      description: 'Bug hunter',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus',
      background: true,
      fork: false,
    })
    expect(spawned).toMatchObject({ agentId: 'ag-1' })
    await $.tool.call({ tool: 'Read', file_path: '/proj/x.ts', tool_use_id: 'r1', agentId: 'ag-1' } as never)
    await clock.settle()
    const feed = { value: await peek($, 'feed') }
    expect(feed.value).toContainEqual({ id: 'r1', agent: 'ag-1' })
    const r1 = { value: await peek($, 'event', 'r1') }
    expect(r1.value?.agentId).toBe('ag-1')
    let agents = { value: await peek($, 'agents') }
    expect(agents.value?.[0]).toMatchObject({ id: 'ag-1', description: 'Bug hunter', type: 'Explore', status: 'running', tools: 1, lastTool: 'Read' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      if (surface !== 'terminal') {
        // The live view: the running subagent's card, its call a native row under it.
        const svg = await drawnSvg(ui)
        expect(svg).toContain('Agent running')
        expect(svg).toContain('Bug hunter')
        expect((await ui.find({ key: 'row:r1' }))?.text).toContain('x.ts')
        expect(await ui.find({ key: 'f-ag-1' })).toBeUndefined()
        await ui.unmount()
        continue
      }
      // The feed offers the agent as a filter; picking it keeps its call.
      await ui.press({ key: 'f-ag-1' })
      expect(await ui.find({ text: /x\.ts/ })).toBeDefined()
      await ui.press({ key: 'f-main' })
      expect(await ui.find({ text: /x\.ts/ })).toBeUndefined()
      await ui.press({ key: 'f-all' })
      await ui.press({ key: 'tab-agents' })
      expect(await ui.find({ text: /Bug hunter/ })).toBeDefined()
      await ui.press({ key: 'ag-ag-1' })
      expect(await ui.find({ text: /id ag-1/ })).toBeDefined()
      await ui.press({ key: 'ag-ag-1' })
      await ui.press({ key: 'tab-feed' })
      await ui.unmount()
    }
    await $.turn.complete({ answer: 'Found it', durationMs: 1200, isAborted: false, turnId: 't-1', agentId: 'ag-1', reason: 'answer' })
    agents = { value: await peek($, 'agents') }
    expect(agents.value?.[0]).toMatchObject({ status: 'done', answer: 'Found it' })
  })

  test('workflow agents are grouped under their run', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    let n = 0
    on('agent.spawn', () => ({ model: 'm', agentId: `wf-agent-${++n}` }))
    on('tool.call', () => ({ result: { status: 'async_launched', taskId: 'task-1', runId: 'wf_123', workflowName: 'ultra-review' }, text: 'launched' }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Workflow', name: 'ultra-review', tool_use_id: 'wf-call' })
    await clock.settle()
    for (const i of [1, 2, 3]) {
      await $.agent.spawn({
        tool_use_id: 'wf-call',
        prompt: `part ${i}`,
        description: `Part ${i}`,
        subagentType: 'general-purpose',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'm',
        background: true,
        fork: false,
        workflow: { runId: 'wf_123', agentIndex: i },
      })
    }
    const workflows = { value: await peek($, 'workflows') }
    expect(workflows.value?.[0]).toMatchObject({ runId: 'wf_123', name: 'ultra-review' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps(90) })
      if (surface === 'terminal') {
        await ui.press({ key: 'tab-agents' })
        expect(await ui.find({ text: /ultra-review/ })).toBeDefined()
        expect(await ui.find({ text: /#2 Part 2/ })).toBeDefined()
        expect(await ui.find({ text: /0\/3/ })).toBeDefined()
      } else {
        // The live view: the run's card under NOW, its agents at work listed.
        const svg = await drawnSvg(ui)
        expect(svg).toContain('ultra-review')
        expect(svg).toContain('#2 Part 2')
        expect(svg).toContain('0/3 done')
      }
      await ui.unmount()
    }
  })

  test('concurrent calls all land (no lost writes)', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    on('tool.call', async ($, e) => {
      if (e.tool_use_id === 'slow') await gate
      return { result: { stdout: e.tool_use_id, stderr: '', interrupted: false }, text: e.tool_use_id }
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const slow = $.tool.call({ tool: 'Bash', command: 'sleep 1', tool_use_id: 'slow' })
    await $.tool.call({ tool: 'Bash', command: 'echo a', tool_use_id: 'fast-a' })
    await $.tool.call({ tool: 'Bash', command: 'echo b', tool_use_id: 'fast-b' })
    release()
    await slow
    await clock.settle()
    const feed = { value: await peek($, 'feed') }
    expect(feed.value?.map((f: CockpitFeedRef) => f.id)).toEqual(['slow', 'fast-a', 'fast-b'])
    const stats = { value: await peek($, 'stats') }
    expect(stats.value).toMatchObject({ calls: 3, running: 0, commands: 3 })
    const ev = { value: await peek($, 'event', 'slow') }
    expect(ev.value?.status).toBe('ok')
  })

  test('the pane draws on every surface: tabs on the terminal, one live view elsewhere', WITH_SPY, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps(surface === 'mobile' ? 40 : 80) })
      if (surface !== 'terminal') {
        const svg = await drawnSvg(ui)
        expect(svg).toContain('Cockpit')
        // Nothing has happened yet: no NOW, no history, one friendly line.
        expect(svg).not.toContain('NOW')
        expect(svg).not.toContain('HISTORY')
        expect(await ui.find({ text: /Waiting for Claude/ })).toBeDefined()
        // No tabs: the screen's two buttons instead.
        expect(await ui.find({ key: 'tab-files' })).toBeUndefined()
        expect(await ui.find({ key: 'live' })).toBeDefined()
        // A capture with no device says so.
        await ui.press({ key: 'snap' })
        expect(await ui.find({ text: /No iOS simulator or Android emulator/ })).toBeDefined()
        await ui.unmount()
        continue
      }
      expect(await ui.find({ text: /COCKPIT/ })).toBeDefined()
      expect(await ui.find({ text: /waiting for Claude/ })).toBeDefined()
      await ui.press({ key: 'tab-files' })
      expect(await ui.find({ text: /No files changed/ })).toBeDefined()
      await ui.press({ key: 'tab-agents' })
      expect(await ui.find({ text: /No subagents yet/ })).toBeDefined()
      await ui.press({ key: 'tab-screen' })
      expect(await ui.find({ key: 'live' })).toBeDefined()
      expect(await ui.find({ text: /No iOS simulator or Android emulator/ })).toBeDefined()
      await ui.press({ key: 'tab-feed' })
      expect(await ui.find({ text: /waiting for Claude/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('/cockpit opens the pane on the asked tab', WITH_SPY, async ($, on) => {
    const { opened, toasts, clock } = engine(on)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const run = (args: string) => $.command.run({ command: 'cockpit', args, origin: ORIGIN, presentation: PRESENTATION })
    // The pane is the answer: no transcript row for the model to read.
    const r = await run('agents')
    expect(r.text).toBeUndefined()
    expect(opened).toContain('cockpit')
    const ui = { value: await peek($, 'ui') }
    expect(ui.value?.tab).toBe('agents')
    // An unknown word says what the command takes, and opens nothing.
    const unknown = await run('diffz')
    expect(unknown.text).toContain('live [on|off]')
    expect(opened).toHaveLength(1)
    // Live is set, not flipped, and says where it stands.
    await run('live on')
    await run('live on')
    await clock.settle()
    expect((await peek($, 'screen'))?.isLive).toBe(true)
    expect(toasts.filter(t => t.includes('Live ● on'))).toHaveLength(2)
    await run('live off')
    expect((await peek($, 'screen'))?.isLive).toBe(false)
    expect((await peek($, 'ui'))?.tab).toBe('screen')
  })

  test('a browser screenshot in a tool result reaches the live view', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    // The tool's own record holds no picture; the transcript row does.
    on('tool.call', () => ({ result: [{ type: 'text', text: 'ok' }], text: 'ok' }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.turn.start({ text: 'look at the page', turnId: 't-shot' })
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    await $.tool.call({ tool: 'mcp__Claude_Browser__computer', action: 'screenshot', tool_use_id: 'shot-1' } as never)
    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'shot-1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
          },
        ],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'mcp__Claude_Browser__computer' },
      uuid: 'row-1',
    })
    await clock.advance(10)
    await clock.settle()
    const screen = { value: await peek($, 'screen') }
    expect(screen.value).toMatchObject({ source: 'tool', mime: 'image/png', width: 1, height: 1 })
    expect(await peek($, 'frameKeys')).toEqual(['tool:Claude_Browser'])
    expect(await peek($, 'frame', 'tool:Claude_Browser')).toMatchObject({ source: 'tool', eventId: 'shot-1', b64: expect.any(String) })
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      const svgs = await ui.findAll({ type: 'Svg' })
      const at = svgs.findIndex(one => String(one.props.source).includes('<image'))
      expect(at).toBeGreaterThan(-1)
      expect(String(svgs[at]?.props.source)).toContain('<image href="data:image/png;base64,')
      // Claude is at work: the screen leads NOW, only the header and the section label before it.
      expect(String(svgs[1]?.props.source)).toContain('NOW')
      expect(at).toBe(2)
      await ui.unmount()
    }
    // The turn is over: the screen is history, a smaller card above the call that took it.
    await $.turn.complete({ answer: 'seen', durationMs: 10, isAborted: false, turnId: 't-shot', reason: 'answer' })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(String(svgs[1]?.props.source)).toContain('HISTORY')
    expect(String(svgs[2]?.props.source)).toContain('<image')
    expect(Number(svgs[2]?.props.height)).toBeLessThanOrEqual(240)
    expect(await ui.find({ type: 'Box', key: 'frame:tool:Claude_Browser' })).toBeDefined()
    await ui.unmount()
  })
})

describe('cockpit screen and bounds', () => {
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  test('a booted simulator is captured through simctl and sips', WITH_SPY, async ($, on) => {
    const argvs: string[][] = []
    const toasts: string[] = []
    mock.clock(on, { now: 1_700_000_000_000 })
    mock.env(on, { TMPDIR: '/tmp/x/' })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('ui.panes', () => ({ value: [] }))
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('session.cwd', () => ({ value: '/proj' }))
    on('process.run', ($, e) => {
      argvs.push([...e.argv])
      const booted = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'U-1', name: 'iPhone 17 Pro', state: 'Booted' }] } })
      return { value: { exitCode: 0, stdout: e.argv[2] === 'list' ? booted : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.read', () => ({ value: { base64: PNG } }))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      if (surface === 'terminal') await ui.press({ key: 'tab-screen' })
      await ui.press({ key: 'snap' })
      if (surface === 'terminal') {
        expect(await ui.find({ text: /iPhone 17 Pro/ })).toBeDefined()
        const image = await ui.find({ type: 'Image' })
        expect(image?.props.source).toMatchObject({ file: expect.stringContaining('ios-U-1.png'), format: 'png' })
      } else {
        // The capture asked for shows under NOW at once, its caption native text.
        const svg = await drawnSvg(ui)
        expect(svg).toContain('NOW')
        expect(svg).toContain('<image href="data:image/jpeg;base64,')
        expect(svg).not.toContain('iPhone 17 Pro')
        expect(await ui.find({ type: 'Text', text: /iPhone 17 Pro/ })).toBeDefined()
        expect(await ui.find({ type: 'Box', key: 'frame:ios:U-1' })).toBeDefined()
      }
      await ui.unmount()
    }
    expect(argvs).toContainEqual(['xcrun', 'simctl', 'io', 'U-1', 'screenshot', '--type=png', expect.stringContaining('/tmp/x/cockpit-')])
    expect(argvs.some(a => a[0] === 'sips' && a.includes('jpeg'))).toBe(true)
    const screen = await peek($, 'screen')
    expect(screen).toMatchObject({ source: 'ios', label: 'iPhone 17 Pro' })
    expect(screen?.error).toBeUndefined()
  })

  test('Live keeps refreshing the desktop live view, which has no Screen tab', WITH_SPY, async ($, on) => {
    const shots: string[][] = []
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    mock.env(on, { TMPDIR: '/tmp/x/' })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    // The pane is open and shown: the ticker runs.
    on('ui.panes', () => ({ value: [{ id: 'cockpit', isShown: true, isPlaced: true }] as never }))
    on('session.cwd', () => ({ value: '/proj' }))
    on('process.run', ($, e) => {
      if (e.argv[2] === 'io') shots.push([...e.argv])
      const booted = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'U-1', name: 'iPhone 17', state: 'Booted' }] } })
      return { value: { exitCode: 0, stdout: e.argv[2] === 'list' ? booted : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.read', () => ({ value: { base64: PNG } }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
    await ui.press({ key: 'live' })
    await clock.settle()
    expect((await peek($, 'ui'))?.tab).not.toBe('screen')
    const first = shots.length
    expect(first).toBe(1)
    await clock.advance(4000)
    await clock.settle()
    expect(shots.length).toBeGreaterThan(first)
    expect(await drawnSvg(ui)).toContain('<image href="data:image/jpeg;base64,')
    await ui.unmount()
  })

  test('Live never turns itself off: it waits for a device, shows it, and lets it go', WITH_SPY, async ($, on) => {
    let booted: { udid: string; name: string }[] = []
    const listing = () => JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': booted.map(d => ({ ...d, state: 'Booted' })) } })
    const { clock, pane, argvs } = engine(on, {
      run: argv => (argv[0] === 'xcrun' && argv[2] === 'list' ? { stdout: listing() } : argv[0] === 'xcrun' || argv[0] === 'sips' ? {} : undefined),
      read: path => (path.endsWith('.jpg') ? { base64: PNG } : undefined),
    })
    pane.isUp = true
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
    const looks = () => argvs.filter(a => a[0] === 'xcrun' && a[2] === 'list').length
    const wait = async (seconds: number) => {
      for (let i = 0; i < seconds; i += 1) {
        await clock.advance(1000)
        await clock.settle()
      }
    }
    await ui.press({ key: 'live' })
    await clock.settle()
    expect(await ui.find({ type: 'Button', key: 'live' })).toMatchObject({ props: expect.objectContaining({ label: 'Live screen: on' }) })
    // No device for half a minute: Live keeps looking, slower and slower, and stays on.
    const first = looks()
    await wait(30)
    expect(looks() - first).toBeGreaterThanOrEqual(3)
    expect(looks() - first).toBeLessThanOrEqual(6)
    expect(await peek($, 'screen')).toMatchObject({ isLive: true, isWaiting: true })
    expect((await peek($, 'screen'))?.error).toBeUndefined()
    expect(await drawnSvg(ui)).toContain('NOW')
    expect(await ui.find({ text: /Live screen — waiting for a simulator or emulator/ })).toBeDefined()
    // A simulator boots: its frame shows at Live's next look (10 s at most).
    booted = [{ udid: 'U-7', name: 'iPhone 17' }]
    await wait(11)
    expect(await ui.find({ type: 'Box', key: 'frame:ios:U-7' })).toBeDefined()
    expect(await ui.find({ text: /waiting for a simulator/ })).toBeUndefined()
    expect(await peek($, 'frameKeys')).toEqual(['ios:U-7'])
    // While it runs, a look every 2 s.
    const during = looks()
    await wait(6)
    expect(looks() - during).toBeGreaterThanOrEqual(2)
    // It shuts down: its frame goes, Live stays on and waits again.
    booted = []
    await wait(3)
    expect(await ui.find({ type: 'Box', key: 'frame:ios:U-7' })).toBeUndefined()
    expect(await peek($, 'frameKeys')).toEqual([])
    expect(await peek($, 'frame', 'ios:U-7')).toBeNull()
    expect(await peek($, 'screen')).toMatchObject({ isLive: true, isWaiting: true })
    expect(await ui.find({ text: /waiting for a simulator/ })).toBeDefined()
    // A failing tool is said, and Live still stays on.
    await ui.unmount()
    // Only the person turns it off.
    await $.command.run({ command: 'cockpit', args: 'live off', origin: ORIGIN, presentation: PRESENTATION })
    expect((await peek($, 'screen'))?.isLive).toBe(false)
    const off = looks()
    await wait(12)
    expect(looks()).toBe(off)
  })

  test('Live says what failed, backs off and stays on', WITH_SPY, async ($, on) => {
    const { clock, pane } = engine(on, {
      run: argv => (argv[0] === 'xcrun' && argv[2] === 'list' ? { exitCode: 1, stderr: 'CoreSimulatorService connection became invalid' } : undefined),
    })
    pane.isUp = true
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.command.run({ command: 'cockpit', args: 'live on', origin: ORIGIN, presentation: PRESENTATION })
    for (let i = 0; i < 20; i += 1) {
      await clock.advance(1000)
      await clock.settle()
    }
    const screen = await peek($, 'screen')
    expect(screen).toMatchObject({ isLive: true, error: 'CoreSimulatorService connection became invalid' })
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
    expect(await ui.find({ text: /CoreSimulatorService connection became invalid/ })).toBeDefined()
    await ui.unmount()
  })

  test('two booted simulators are two frames, side by side where there is room', WITH_SPY, async ($, on) => {
    // A 368x800 PNG header: portrait phones.
    const PORTRAIT = 'iVBORw0KGgoAAAANSUhEUgAAAXAAAAMgCAIAAAC1aq62'
    const listing = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [{ udid: 'TV', name: 'Apple TV', state: 'Booted' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
          { udid: 'U-1', name: 'iPhone 17', state: 'Booted' },
          { udid: 'U-2', name: 'iPhone Air', state: 'Booted' },
          { udid: 'U-3', name: 'iPad', state: 'Shutdown' },
        ],
      },
    })
    const { clock, argvs } = engine(on, {
      run: argv => (argv[0] === 'xcrun' && argv[2] === 'list' ? { stdout: listing } : argv[0] === 'xcrun' || argv[0] === 'sips' ? {} : undefined),
      read: path => (path.endsWith('.jpg') ? { base64: PORTRAIT } : undefined),
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.command.run({ command: 'cockpit', args: 'live on', origin: ORIGIN, presentation: PRESENTATION })
    await clock.settle()
    // Each booted simulator, in files of its own; never the Apple TV.
    const shots = argvs.filter(a => a[0] === 'xcrun' && a[2] === 'io')
    expect(shots.map(a => a[3])).toEqual(['U-1', 'U-2'])
    expect(new Set(shots.map(a => a[6])).size).toBe(2)
    expect(await peek($, 'frameKeys')).toEqual(['ios:U-1', 'ios:U-2'])
    expect(await peek($, 'frame', 'ios:U-2')).toMatchObject({ source: 'ios', label: 'iPhone Air', width: 368, height: 800 })
    // The single screen (the terminal's) shows the first.
    expect(await peek($, 'screen')).toMatchObject({ source: 'ios', label: 'iPhone 17' })
    const cardsOf = async (ui: Drawn) => (await ui.findAll({ type: 'Svg' })).filter(one => String(one.props.source).includes('<image'))
    const framesOf = async (ui: Drawn) => (await ui.findAll({ type: 'Box' })).filter(one => String(one.key).startsWith('frame:')).map(one => one.key)
    // Wide: two cards in one row, each half the width, the first device first.
    const wide = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps(80) })
    expect(await framesOf(wide)).toEqual(['frame:ios:U-1', 'frame:ios:U-2'])
    const cards = await cardsOf(wide)
    expect(cards).toHaveLength(2)
    const px = Math.floor((80 - 2) * 7.3)
    for (const card of cards) expect(Number(card.props.width)).toBeLessThanOrEqual(Math.floor((px - 2 * 7.3) / 2))
    const row = (await wide.findAll({ type: 'Box' })).find(one => String(one.key).startsWith('frames:'))
    expect(row?.props.flexDirection).toBe('row')
    expect(await wide.find({ type: 'Text', text: /iPhone Air/ })).toBeDefined()
    await wide.unmount()
    // Narrow: one under the other, each the whole width.
    const narrow = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps(50) })
    expect((await narrow.findAll({ type: 'Box' })).some(one => String(one.key).startsWith('frames:'))).toBe(false)
    expect(await framesOf(narrow)).toEqual(['frame:ios:U-1', 'frame:ios:U-2'])
    for (const card of await cardsOf(narrow)) expect(Number(card.props.width)).toBe(Math.floor((50 - 2) * 7.3))
    await narrow.unmount()
  })

  test('the feed keeps a bounded window of events', { ...WITH_SPY, timeoutMs: 120_000 }, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', ($, e) => ({ result: { stdout: 'x'.repeat(9000), stderr: '', interrupted: false }, text: 'x' }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    for (let i = 0; i < 305; i += 1) await $.tool.call({ tool: 'Bash', command: `echo ${i}`, tool_use_id: `n${i}` })
    await clock.settle()
    const feed = await peek($, 'feed')
    expect(feed).toHaveLength(300)
    expect(feed?.[0]?.id).toBe('n5')
    expect(await peek($, 'event', 'n0')).toBeNull()
    const last = await peek($, 'event', 'n304')
    expect((last?.output ?? '').length).toBeLessThan(4200)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: paneProps(30) })
    expect(await ui.find({ text: /echo 304/ })).toBeDefined()
    expect(await ui.find({ key: 'newer' })).toBeUndefined()
    // Older rows come a page at a time, never all at once.
    await ui.press({ key: 'more' })
    expect(await ui.find({ text: /echo 304/ })).toBeUndefined()
    expect(await ui.find({ text: /echo 264/ })).toBeDefined()
    expect(await peek($, 'ui')).toMatchObject({ limit: 40, offset: 40 })
    await ui.press({ key: 'newer' })
    expect(await ui.find({ text: /echo 304/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('diff', () => {
  test('a line diff makes hunks the Code element parses', async () => {
    const hunks = diffTexts('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nB\nc\nd\ne\nf\ng\nH\n')
    const text = renderHunks(hunks, 10_000)
    expect(text.diff).toBe('@@ -1,8 +1,8 @@\n a\n-b\n+B\n c\n d\n e\n f\n g\n-h\n+H\n')
    expect(text).toMatchObject({ added: 2, removed: 2, isTruncated: false })
    const far = diffTexts(
      Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'),
      Array.from({ length: 30 }, (_, i) => (i === 2 || i === 25 ? `L${i}` : `l${i}`)).join('\n'),
    )
    expect(far).toHaveLength(2)
    expect(renderHunks(far, 10_000).diff.split('\n')[0]).toBe('@@ -1,6 +1,6 @@')
  })

  test('a cut diff stays parseable', async () => {
    const big = diffTexts('', Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'))
    const text = renderHunks(big, 400)
    expect(text.isTruncated).toBe(true)
    const [head, ...rest] = text.diff.trimEnd().split('\n')
    expect(head).toBe(`@@ -0,0 +1,${rest.length} @@`)
  })

  test('image headers and simctl listings', async () => {
    expect(imageSize('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')).toEqual({ width: 1, height: 1 })
    const out = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [{ udid: 'TV', name: 'Apple TV', state: 'Booted' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'PHONE', name: 'iPhone 17', state: 'Booted' }],
      },
    })
    expect(parseSimctl(out)).toEqual({ kind: 'ios', udid: 'PHONE', name: 'iPhone 17' })
    // An Apple TV alone is no screen to capture (simctl io hangs on it).
    const tvOnly = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [{ udid: 'TV', name: 'Apple TV', state: 'Booted' }] } })
    expect(parseSimctl(tvOnly)).toBeUndefined()
    // sips exits 0 on an input it cannot read: its warning is the failure.
    expect(sipsError({ exitCode: 0, stdout: '', stderr: 'Warning: x.png not a valid file - skipping\n' })).toContain('not a valid file')
    expect(sipsError({ exitCode: 0, stdout: '/a.png\n  /a.jpg\n', stderr: '' })).toBeUndefined()
  })

  test('counts read in the singular at one', async () => {
    expect(statusLine({ ...EMPTY_STATS, calls: 1 }, 1, [])).toBe('◆ 1 call · ✎ 1 file +0 −0')
    expect(statusLine({ ...EMPTY_STATS, calls: 2 }, 2, [])).toBe('◆ 2 calls · ✎ 2 files +0 −0')
    // An idle bucket is a baseline, not a gap.
    expect(sparkText([0, 4, 0, 1])).toBe('▁█▁▃')
  })
})

describe('cockpit robustness', () => {
  test('ANSI colours and control characters in tool output never break the pane', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', ($, e) =>
      e.tool_use_id === 'c1'
        ? { result: { stdout: '\x1b[32mok\x1b[0m done\r\nline\x07two\nprogress 10%\rprogress 100%', stderr: '', interrupted: false }, text: 'ok' }
        : { isError: true as const, result: '\x1b[31mfailed\x1b[0m', text: '\x1b[31mfailed\x1b[0m' },
    )
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build \x1b[1mbold\x1b[0m', tool_use_id: 'c1' })
    await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x', tool_use_id: 'c2' })
    await clock.settle()
    const ev = await peek($, 'event', 'c1')
    expect(ev?.output).toBe('ok done\nlinetwo\nprogress 100%')
    expect(ev?.title).toBe('Build bold')
    expect((await peek($, 'event', 'c2'))?.output).toBe('failed')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      if (surface === 'terminal') {
        expect(await ui.find({ text: /progress 100%/ })).toBeDefined()
        await ui.press({ key: 'ev-c1' })
        const codes = await ui.findAll({ type: 'Code' })
        expect(codes.some(c => String(c.props.source).includes('progress 100%'))).toBe(true)
        await ui.press({ key: 'ev-c1' })
      } else {
        // The failed fetch is NOW; the build folds into the history, its output
        // in the row's tooltip. No control character reaches the markup.
        const svg = await drawnSvg(ui)
        expect(svg).toContain('Build bold')
        expect(svg).toContain('progress 100%')
        expect(svg).toContain('failed')
        // eslint-disable-next-line no-control-regex
        expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(svg)).toBe(false)
      }
      await ui.unmount()
    }
    expect(clean('a\x1b]0;title\x07b\x00c\td')).toBe('abc\td')
  })

  test('a call that rejects is closed as interrupted and the running count comes back', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', ($, e) => {
      if (e.tool_use_id === 'boom') throw new Error('worker gone')
      return { result: { stdout: 'fine', stderr: '', interrupted: false }, text: 'fine' }
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await expect($.tool.call({ tool: 'Bash', command: 'x', tool_use_id: 'boom' })).rejects.toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'y', tool_use_id: 'ok1' })
    await clock.settle()
    expect((await peek($, 'event', 'boom'))?.status).toBe('error')
    expect(await peek($, 'stats')).toMatchObject({ running: 0, calls: 2 })
  })

  test('a row left running is reconciled when its loop turn completes', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('turn.complete', ($, e) => ({ text: e.answer }))
    // A call whose end the module never sees in time (a reload mid-call).
    let release: () => void = () => undefined
    const hang = new Promise<void>(resolve => {
      release = resolve
    })
    on('tool.call', async () => {
      await hang
      return { result: { stdout: 'late', stderr: '', interrupted: false }, text: 'late' }
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const pending = $.tool.call({ tool: 'Bash', command: 'sleep 99', tool_use_id: 'lost' })
    for (let i = 0; i < 50 && (await peek($, 'stats'))?.running !== 1; i += 1) await peek($, 'feed')
    expect((await peek($, 'event', 'lost'))?.status).toBe('running')
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't-9', reason: 'answer' })
    expect((await peek($, 'event', 'lost'))?.status).toBe('error')
    expect(await peek($, 'stats')).toMatchObject({ running: 0, isWorking: false })
    // Its late end does not count it twice.
    release()
    await pending
    await clock.settle()
    expect(await peek($, 'stats')).toMatchObject({ running: 0 })
  })

  test('/clear starts a fresh picture', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', () => ({ result: { stdout: 'x', stderr: '', interrupted: false }, text: 'x' }))
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    for (const id of ['a', 'b', 'c']) await $.tool.call({ tool: 'Bash', command: id, tool_use_id: id })
    await $.command.run({ command: 'cockpit', args: 'agents', origin: ORIGIN, presentation: PRESENTATION })
    await clock.advance(60_000)
    await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
    expect(await peek($, 'feed')).toEqual([])
    expect(await peek($, 'event', 'a')).toBeNull()
    const stats = await peek($, 'stats')
    expect(stats).toMatchObject({ calls: 0, running: 0 })
    expect(stats?.startedAt).toBe(1_700_000_060_000)
    expect((await peek($, 'ui'))?.tab).toBe('agents')
  })

  test('the desktop app opens the pane when it attaches, once', WITH_SPY, async ($, on) => {
    const { opened } = engine(on)
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    // The desktop hosts the session headless: no surface at start.
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    expect(opened).toEqual([])
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 120, rows: 40, isFullscreen: true } })
    expect(opened).toEqual(['cockpit'])
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 120, rows: 40, isFullscreen: true } })
    expect(opened).toEqual(['cockpit'])
  })

  test('no pane opens unasked on a terminal, or with autoOpen off', { ...WITH_SPY, options: { autoOpen: false } }, async ($, on) => {
    const { opened } = engine(on)
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 120, rows: 40, isFullscreen: true } })
    expect(opened).toEqual([])
  })

  test('a phone that does not dock gets no unasked pane', WITH_SPY, async ($, on) => {
    const { opened } = engine(on)
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    await $.session.attach({ surface: 'mobile', clientId: 'phone', viewport: { columns: 40, rows: 30, isFullscreen: false } })
    expect(opened).toEqual([])
  })

  test('a large PNG screenshot shows on the terminal from its decoded file', WITH_SPY, async ($, on) => {
    const argvs: string[][] = []
    const clock = mock.clock(on, { now: 1_700_000_000_000 })
    mock.env(on, { TMPDIR: '/tmp/x/' })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.panes', () => ({ value: [] }))
    on('session.cwd', () => ({ value: '/proj' }))
    on('process.run', ($, e) => {
      argvs.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    on('fs.read', () => ({ value: { base64: PNG } }))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const big = PNG + 'A'.repeat(200_000)
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'mcp__Claude_Browser__computer' },
      uuid: 'row-big',
    })
    await clock.advance(10)
    await clock.settle()
    const screen = await peek($, 'screen')
    expect(screen?.pngPath).toContain('tool-raw.png')
    expect(argvs.some(a => a[0] === 'sips' && a.includes('png'))).toBe(false)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: paneProps(46, 38) })
    await ui.press({ key: 'tab-screen' })
    const image = await ui.find({ type: 'Image' })
    expect(image?.props.source).toMatchObject({ file: expect.stringContaining('tool-raw.png'), format: 'png' })
    await ui.unmount()
  })

  test('a portrait frame fits the pane height', WITH_SPY, async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    mock.env(on, { TMPDIR: '/tmp/x/' })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.panes', () => ({ value: [] }))
    on('session.cwd', () => ({ value: '/proj' }))
    on('process.run', ($, e) => {
      const booted = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'U-1', name: 'iPhone 17', state: 'Booted' }] } })
      return { value: { exitCode: 0, stdout: e.argv[2] === 'list' ? booted : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    // A 368x800 PNG header: a portrait phone.
    on('fs.read', () => ({ value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAXAAAAMgCAIAAAC1aq62' } }))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps(80, 38) })
      if (surface === 'terminal') await ui.press({ key: 'tab-screen' })
      await ui.press({ key: 'snap' })
      if (surface === 'terminal') {
        const image = await ui.find({ type: 'Image' })
        expect(Number(image?.props.rows)).toBeLessThanOrEqual(24)
        expect(Number(image?.props.columns)).toBeLessThan(30)
      } else {
        const svg = (await ui.findAll({ type: 'Svg' })).find(one => String(one.props.source).includes('<image'))
        expect(Number(svg?.props.height)).toBeGreaterThan(0)
        expect(Number(svg?.props.height)).toBeLessThanOrEqual(24 * 19)
      }
      await ui.unmount()
    }
  })

  test('running workflow runs come first; finished runs fold to one line', WITH_SPY, async ($, on) => {
    engine(on)
    let n = 0
    on('agent.spawn', () => ({ model: 'm', agentId: `a-${++n}` }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const spawn = (runId: string, i: number) =>
      $.agent.spawn({
        tool_use_id: `wf-${runId}`,
        prompt: 'p',
        description: `${runId} part ${i}`,
        subagentType: 'general-purpose',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'm',
        background: true,
        fork: false,
        workflow: { runId, agentIndex: i },
      })
    for (const i of [1, 2]) await spawn('old', i)
    for (const id of ['a-1', 'a-2']) await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, agentId: id, reason: 'answer' })
    for (const i of [1, 2]) await spawn('new', i)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: paneProps(46) })
    await ui.press({ key: 'tab-agents' })
    // The finished run is one line; its agents are not drawn until unfolded.
    expect(await ui.find({ key: 'wf-old' })).toBeDefined()
    expect(await ui.find({ text: /old part 1/ })).toBeUndefined()
    expect(await ui.find({ text: /new part 2/ })).toBeDefined()
    // Narrow: no repeated type chip on the rows.
    expect(await ui.find({ text: /^ general-purpose $/ })).toBeUndefined()
    await ui.press({ key: 'wf-old' })
    expect(await ui.find({ text: /old part 1/ })).toBeDefined()
    await ui.unmount()
  })

  test('fifty parallel agent calls fold into few writes and all count', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    let sets = 0
    on('state.set', ($, e, next) => {
      if (e.plugin === 'cockpit' && (e.key === 'stats' || e.key === 'feed')) sets += 1
      return next(e)
    })
    on('tool.call', ($, e) => ({ result: { stdout: e.tool_use_id, stderr: '', interrupted: false }, text: e.tool_use_id }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const t0 = Date.now()
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => $.tool.call({ tool: 'Bash', command: `echo ${i}`, tool_use_id: `p${i}`, agentId: `ag-${i % 5}` } as never)),
    )
    await clock.settle()
    expect(await peek($, 'stats')).toMatchObject({ calls: 50, commands: 50, running: 0, streak: 50 })
    expect(await peek($, 'feed')).toHaveLength(50)
    expect((await peek($, 'agents'))?.reduce((n, a) => n + a.tools, 0)).toBe(50)
    expect(sets).toBeGreaterThan(0)
    expect(sets).toBeLessThan(150)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  test('a lopsided diff stays cheap', async () => {
    const a = Array.from({ length: 100 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 40_000 }, (_, i) => `b${i}`)
    const ops = diffLines(a, b)
    expect(ops).toHaveLength(40_100)
    const ops2 = diffLines(['x', 'a', 'b', 'c'], ['a', 'b', 'y', 'c'])
    expect(ops2.filter(o => o.kind !== '+').map(o => o.text)).toEqual(['x', 'a', 'b', 'c'])
    expect(ops2.filter(o => o.kind !== '-').map(o => o.text)).toEqual(['a', 'b', 'y', 'c'])
  })
})

describe('live plan', () => {
  const T0 = 1_700_000_000_000
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const call = (id: string, over: Partial<CockpitEvent> = {}): CockpitEvent => ({
    id,
    tool: 'Bash',
    cat: 'shell',
    title: id,
    status: 'ok',
    startedAt: T0,
    endedAt: T0 + 100,
    input: '',
    ...over,
  })
  const edit = (id: string, over: Partial<CockpitEvent> = {}): CockpitEvent =>
    call(id, { tool: 'Edit', cat: 'edit', filePath: `/proj/${id}.ts`, added: 1, removed: 1, ...over })
  const frame = (key: string, over: Partial<CockpitFrame> = {}): CockpitFrame => ({
    key,
    source: key.startsWith('ios:') ? 'ios' : key.startsWith('android:') ? 'android' : key.startsWith('window:') ? 'window' : 'tool',
    label: key,
    b64: PNG,
    mime: 'image/png',
    width: 1,
    height: 1,
    at: T0,
    ...over,
  })
  /** `events` newest first, as the render hook hands them. */
  const plan = (events: CockpitEvent[], over: Partial<LiveInput> = {}) =>
    planLive({ events, agents: [], workflows: [], frames: [], changes: new Map(), now: T0 + 1000, isLive: false, isWorking: false, ...over })
  type Loose = { kind: string; ev?: CockpitEvent; events?: CockpitEvent[]; frame?: CockpitFrame }
  const ids = (moments: Loose[]) =>
    moments.map(m =>
      m.kind === 'run'
        ? `run(${(m.events ?? []).map(e => e.id).join(',')})`
        : m.kind === 'frame'
          ? `frame(${m.frame?.key ?? '?'})`
          : m.kind === 'liveWait'
            ? 'wait'
            : (m.ev?.id ?? '?'),
    )

  test('a running command is now; what ran before goes to history, the last command keeping its terminal', async () => {
    const p = plan([call('b2', { status: 'running', endedAt: undefined }), call('b1'), call('b0')])
    expect(ids(p.now)).toEqual(['b2'])
    expect(p.now[0]).toMatchObject({ kind: 'call' })
    expect(ids(p.history)).toEqual(['b1', 'run(b0)'])
    expect(p.history[0]).toMatchObject({ kind: 'call' })
  })

  test('NOW is only what runs: finished calls go straight to the history', async () => {
    // Nothing runs: no NOW at all, the newest finished call tops the history.
    const p = plan([call('sub', { agentId: 'ag-1', tool: 'Read', cat: 'read' }), call('m2'), call('m1', { tool: 'Grep', cat: 'search' })])
    expect(p.now).toEqual([])
    expect(ids(p.history)).toEqual(['run(sub)', 'm2', 'run(m1)'])
    expect(plan([])).toEqual({ now: [], history: [] })
    // A running read is now, drawn large; once done it folds into a run.
    expect(ids(plan([call('r1', { tool: 'Read', cat: 'read', status: 'running', endedAt: undefined })]).now)).toEqual(['r1'])
    expect(ids(plan([call('r1', { tool: 'Read', cat: 'read' })]).history)).toEqual(['run(r1)'])
  })

  test('a finished edit tops the history with its change; a running one is now, its head alone', async () => {
    const change: CockpitChange = { id: 'e1', at: T0, tool: 'Edit', diff: '@@ -1,1 +1,1 @@\n-a\n+b\n', added: 1, removed: 1 }
    const done = plan([edit('e1'), call('b1')], { changes: new Map([['e1', change]]) })
    expect(done.now).toEqual([])
    expect(done.history[0]).toMatchObject({ kind: 'file', ev: { id: 'e1' }, change, isNew: false })
    expect(ids(done.history)).toEqual(['e1', 'b1'])
    // A subagent's finished edit too: no "fresh edit stays now" any more.
    const sub = plan([edit('e2', { agentId: 'ag-9' })], { changes: new Map([['e2', { ...change, id: 'e2' }]]) })
    expect(sub.now).toEqual([])
    expect(sub.history[0]).toMatchObject({ kind: 'file', ev: { id: 'e2' } })
    const running = plan([edit('e3', { status: 'running', endedAt: undefined })])
    expect(running.now).toEqual([{ kind: 'file', ev: expect.objectContaining({ id: 'e3' }), change: undefined, isNew: false }])
  })

  test('a running subagent is live now: its current call, its latest ones, its fresh edit', async () => {
    const agent: CockpitAgent = { id: 'ag-1', description: 'Bug hunter', type: 'Explore', status: 'running', startedAt: T0, tools: 4, errors: 0, toolUseId: 'spawn' }
    const events = [
      call('a4', { agentId: 'ag-1', status: 'running', endedAt: undefined }),
      edit('a3', { agentId: 'ag-1' }),
      call('a2', { agentId: 'ag-1', tool: 'Read', cat: 'read' }),
      call('m1'),
      call('spawn', { tool: 'Agent', cat: 'agent' }),
    ]
    const change: CockpitChange = { id: 'a3', at: T0, tool: 'Edit', diff: '@@ -1,1 +1,1 @@\n-a\n+b\n', added: 1, removed: 1 }
    const p = plan(events, { agents: [agent], changes: new Map([['a3', change]]) })
    const live = p.now.find(m => m.kind === 'agentLive')
    expect(live).toMatchObject({ kind: 'agentLive', agent: { id: 'ag-1' }, current: { id: 'a4' }, edit: { ev: { id: 'a3' }, change: { id: 'a3' } } })
    expect(live?.kind === 'agentLive' ? live.recent.map(e => e.id) : []).toEqual(['a3', 'a2'])
    // Its calls and its spawn call are not repeated below.
    const below = JSON.stringify(p.history)
    for (const id of ['a4', 'a3', 'a2', 'spawn']) expect(below).not.toContain(`"id":"${id}"`)
    // A finished agent is no longer live.
    expect(plan(events.map(e => ({ ...e, status: 'ok' as const })), { agents: [{ ...agent, status: 'done' }] }).now.some(m => m.kind === 'agentLive')).toBe(false)
  })

  test('a workflow run is now while one of its agents runs, though its call returned at launch', async () => {
    const wf: CockpitWorkflow = { runId: 'r1', name: 'ultra', toolUseId: 'w1', startedAt: T0 }
    const agents: CockpitAgent[] = [1, 2, 3].map(i => ({ id: `wa${i}`, description: `part ${i}`, type: 'gp', status: i === 3 ? 'done' : 'running', startedAt: T0, tools: i, errors: 0, runId: 'r1', workflowIndex: i, lastAt: T0 + i }))
    const p = plan([call('w1', { tool: 'Workflow', cat: 'agent' })], { agents, workflows: [wf] })
    expect(p.now.map(m => m.kind)).toEqual(['workflow', 'agentLive', 'agentLive'])
    expect(p.history).toEqual([])
    const over = plan([call('w1', { tool: 'Workflow', cat: 'agent' })], { agents: agents.map(a => ({ ...a, status: 'done' as const })), workflows: [wf] })
    expect(over.now).toEqual([])
    expect(over.history[0]).toMatchObject({ kind: 'workflow', wf: { runId: 'r1' } })
  })

  test('frames are now while Live follows them, while their call runs, while Claude works on a fresh one', async () => {
    const sim = frame('ios:U-1')
    // Live on: the simulator is now; no device yet: Live is waiting, and says so.
    expect(ids(plan([], { frames: [sim], isLive: true }).now)).toEqual(['frame(ios:U-1)'])
    expect(ids(plan([], { isLive: true }).now)).toEqual(['wait'])
    // Live off: a device frame with no call behind it is shown nowhere.
    expect(plan([], { frames: [sim] })).toEqual({ now: [], history: [] })
    // A capture the person asked for shows a minute.
    expect(ids(plan([], { frames: [{ ...sim, isManual: true }] }).now)).toEqual(['frame(ios:U-1)'])
    expect(plan([], { frames: [{ ...sim, isManual: true }], now: T0 + 61_000 }).now).toEqual([])
    // A tool's picture: now while its call runs, or while Claude works and it is fresh ...
    const shot = frame('tool:Claude_Browser', { eventId: 'nav' })
    const nav = call('nav', { tool: 'mcp__Claude_Browser__navigate', cat: 'browser' })
    expect(ids(plan([{ ...nav, status: 'running', endedAt: undefined }], { frames: [shot] }).now)).toEqual(['frame(tool:Claude_Browser)', 'nav'])
    expect(ids(plan([nav], { frames: [shot], isWorking: true }).now)).toEqual(['frame(tool:Claude_Browser)'])
    // ... else a smaller card at the place of the call that made it.
    const later = plan([call('b2'), nav, call('b0')], { frames: [shot], isWorking: true, now: T0 + 61_000 })
    expect(later.now).toEqual([])
    expect(ids(later.history)).toEqual(['b2', 'frame(tool:Claude_Browser)', 'run(nav,b0)'])
    // Its call out of the window: shown nowhere.
    expect(plan([call('b2')], { frames: [shot] }).history.some(m => m.kind === 'frame')).toBe(false)
    // The watched window is now; once the watch stops, it is not.
    const win = frame('window:Finder')
    expect(ids(plan([], { frames: [win], watch: 'Finder' }).now)).toEqual(['frame(window:Finder)'])
    expect(plan([], { frames: [win] }).now).toEqual([])
    // Several at once, newest first.
    expect(ids(plan([], { frames: [frame('ios:U-2'), sim, win], isLive: true, watch: 'Finder' }).now)).toEqual(['frame(ios:U-2)', 'frame(ios:U-1)', 'frame(window:Finder)'])
  })

  test('small calls fold into one run; an edit splits them', async () => {
    const reads = [call('r3', { tool: 'Read', cat: 'read' }), call('g2', { tool: 'Grep', cat: 'search' }), call('b1')]
    const p = plan([call('last'), ...reads])
    expect(ids(p.history)).toEqual(['last', 'run(r3,g2,b1)'])
    const split = plan([call('last'), call('r2', { tool: 'Read', cat: 'read' }), edit('old', { endedAt: T0 - 60_000 }), call('b1')])
    expect(ids(split.history)).toEqual(['last', 'run(r2)', 'old', 'run(b1)'])
  })

  test('moment keys come from ids; a run keeps its key as it grows at its newest end', async () => {
    const read = (id: string) => call(id, { tool: 'Read', cat: 'read' })
    const first = plan([read('r2'), read('r1')])
    expect(first.history.map(momentKey)).toEqual(['run:r1'])
    const grown = plan([read('r4'), read('r3'), read('r2'), read('r1')])
    expect(grown.history.map(momentKey)).toEqual(['run:r1'])
    const change: CockpitChange = { id: 'e1', at: T0, tool: 'Edit', diff: '@@ -1,1 +1,1 @@\n-a\n+b\n', added: 1, removed: 1 }
    const mixed = plan([call('b9'), edit('e1'), read('r1')], { changes: new Map([['e1', change]]), frames: [frame('ios:U-1')], isLive: true })
    expect([...mixed.now, ...mixed.history].map(momentKey)).toEqual(['frame:ios:U-1', 'call:b9', 'file:e1', 'run:r1'])
    expect(momentKey({ kind: 'liveWait' })).toBe('live-wait')
  })

  test('unfolded keys toggle and stay bounded; frame keys keep their place and evict the oldest', async () => {
    expect(toggleOpen(undefined, 'call:a')).toEqual(['call:a'])
    expect(toggleOpen(['call:a', 'run:b'], 'call:a')).toEqual(['run:b'])
    const many = Array.from({ length: 40 }, (_, i) => `call:${i}`)
    expect(toggleOpen(many, 'diff:x')).toEqual([...many.slice(1), 'diff:x'])
    expect(addFrameKey(['b', 'a'], 'a')).toEqual({ keys: ['b', 'a'], evicted: [] })
    expect(addFrameKey(['b', 'a'], 'c')).toEqual({ keys: ['c', 'b', 'a'], evicted: [] })
    const six = ['f', 'e', 'd', 'c', 'b', 'a']
    expect(addFrameKey(six, 'g')).toEqual({ keys: ['g', 'f', 'e', 'd', 'c', 'b'], evicted: ['a'] })
    // A frame Live follows is never the one evicted while another can go.
    expect(addFrameKey(six, 'g', key => key === 'a')).toEqual({ keys: ['g', 'f', 'e', 'd', 'c', 'a'], evicted: ['b'] })
  })

  test('the whole command of a Bash call comes from its input', async () => {
    const long = `cat > x.sh <<'EOF'\n${'echo hi\n'.repeat(80)}EOF`
    expect(fullCommand(call('c', { input: JSON.stringify({ command: long }, null, 2), detail: '$ cat > x.sh <<…' }))).toBe(long)
    expect(fullCommand(call('c', { input: '{ cut short', detail: '$ npm test ⏎ echo done' }))).toBe('npm test\necho done')
  })
})

describe('trimDiff', () => {
  /** Each hunk's header counts what its body holds. */
  const checkHunks = (diff: string): void => {
    const lines = diff.replace(/\n$/, '').split('\n')
    let at = 0
    while (at < lines.length) {
      const m = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(lines[at] ?? '')
      expect(m).not.toBeNull()
      let end = at + 1
      while (end < lines.length && !(lines[end] ?? '').startsWith('@@')) end += 1
      const body = lines.slice(at + 1, end)
      expect(body.filter(l => !l.startsWith('+')).length).toBe(Number(m?.[1]))
      expect(body.filter(l => !l.startsWith('-')).length).toBe(Number(m?.[2]))
      at = end
    }
  }
  const old = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
  const now = Array.from({ length: 60 }, (_, i) => (i === 3 || i === 40 ? `LINE ${i}` : `line ${i}`)).join('\n')
  const diff = renderHunks(diffTexts(old, now), 10_000).diff

  test('a diff that fits is left whole', async () => {
    expect(trimDiff(diff, 100)).toEqual({ diff, hidden: 0 })
    // Its closing newline is no line of its own.
    const lineCount = diff.trimEnd().split('\n').length
    expect(trimDiff(diff, lineCount)).toEqual({ diff, hidden: 0 })
  })

  test('a cut keeps whole hunks, then recounts the cut one', async () => {
    const hunks = diff.trimEnd().split('\n')
    const first = hunks.findIndex((l, i) => i > 0 && l.startsWith('@@'))
    expect(first).toBeGreaterThan(0)
    const bodyLines = hunks.filter(l => !l.startsWith('@@')).length
    // Whole first hunk plus a header and three lines of the second.
    const cut = trimDiff(diff, first + 4)
    checkHunks(cut.diff)
    expect(cut.diff.endsWith('\n')).toBe(true)
    const shown = cut.diff.trimEnd().split('\n')
    expect(shown).toHaveLength(first + 4)
    expect(shown.slice(0, first)).toEqual(hunks.slice(0, first))
    expect(cut.hidden).toBe(bodyLines - shown.filter(l => !l.startsWith('@@')).length)
    // Inside the first hunk: one header, recounted, and the lines that fit.
    const head = trimDiff(diff, 3)
    checkHunks(head.diff)
    expect(head.diff.trimEnd().split('\n')).toHaveLength(3)
    expect(head.hidden).toBe(bodyLines - 2)
    // A two-line hunk cut to one line: one line hidden, not two.
    expect(trimDiff('@@ -1,2 +1,2 @@\n-a\n+b\n', 2)).toEqual({ diff: '@@ -1,1 +1,0 @@\n-a\n', hidden: 1 })
  })
})

describe('cockpit screen follow-up', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  type Seen = { tool: string; action?: string; tool_use_id?: string }

  test('an MCP browser result carrying an image updates the screen, with no extra screenshot', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    const calls: Seen[] = []
    on('tool.call', ($, e) => {
      calls.push({ ...(e as unknown as Seen) })
      return { result: { content: [{ type: 'text', text: 'clicked' }, { type: 'image', data: PNG, mimeType: 'image/png' }] }, text: 'clicked' }
    })
    on('tool.check', () => ({ decision: 'allow' as const }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'mcp__Claude_Browser__computer', action: 'left_click', coordinate: [10, 20], tool_use_id: 'click-1' } as never)
    await clock.advance(10)
    await clock.settle()
    expect(await peek($, 'screen')).toMatchObject({ source: 'tool', label: 'Claude Browser · computer', mime: 'image/png', b64: PNG, width: 1, height: 1 })
    await clock.advance(2000)
    await clock.settle()
    expect(calls.map(c => c.tool_use_id)).toEqual(['click-1'])
  })

  for (const decision of ['allow', 'ask'] as const) {
    test(`a navigate with no picture asks for a screenshot only when the check says allow (${decision})`, WITH_SPY, async ($, on) => {
      const { clock } = engine(on)
      const calls: Seen[] = []
      const checks: { tool: string; input: unknown }[] = []
      on('tool.check', ($, e) => {
        checks.push({ tool: e.tool, input: e.input })
        return { decision }
      })
      on('tool.call', ($, e) => {
        calls.push({ ...(e as unknown as Seen) })
        return e.tool === 'mcp__Claude_Browser__computer'
          ? { result: [{ type: 'image', data: PNG, mimeType: 'image/png' }], text: '' }
          : { result: [{ type: 'text', text: 'navigated' }], text: 'navigated' }
      })
      await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
      await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com', tool_use_id: 'nav-1' } as never)
      await clock.settle()
      // Not at once: the shot waits for the actions to pause.
      expect(calls).toHaveLength(1)
      await clock.advance(1000)
      await clock.settle()
      expect(checks).toEqual([{ tool: 'mcp__Claude_Browser__computer', input: expect.objectContaining({ action: 'screenshot' }) }])
      const shots = calls.filter(c => c.tool === 'mcp__Claude_Browser__computer')
      if (decision === 'allow') {
        expect(shots).toEqual([expect.objectContaining({ action: 'screenshot' })])
        expect(await peek($, 'screen')).toMatchObject({ source: 'tool', b64: PNG })
      } else {
        expect(shots).toEqual([])
        expect((await peek($, 'screen'))?.b64).toBeUndefined()
      }
      // Either way, the feed holds Claude's call alone.
      expect((await peek($, 'feed'))?.map(f => f.id)).toEqual(['nav-1'])
      expect(await peek($, 'stats')).toMatchObject({ calls: 1, running: 0 })
    })
  }

  test("the plugin's own screenshot is no feed event, and Claude's calls during it still are", WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.check', () => ({ decision: 'allow' as const }))
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let isShooting = false
    on('tool.call', async ($, e) => {
      if (e.tool === 'mcp__Claude_Browser__computer') {
        isShooting = true
        await gate
        return { result: [{ type: 'image', data: PNG, mimeType: 'image/png' }], text: '' }
      }
      return { result: { stdout: 'x', stderr: '', interrupted: false }, text: 'x' }
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com', tool_use_id: 'nav-1' } as never)
    await clock.advance(1000)
    for (let i = 0; i < 50 && !isShooting; i += 1) await peek($, 'feed')
    expect(isShooting).toBe(true)
    // Claude goes on while the screenshot is in flight.
    await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b-during' })
    release()
    await clock.settle()
    expect((await peek($, 'feed'))?.map(f => f.id)).toEqual(['nav-1', 'b-during'])
    expect(await peek($, 'stats')).toMatchObject({ calls: 2, running: 0 })
    expect((await peek($, 'screen'))?.b64).toBe(PNG)
  })
})

describe('cockpit footer chip', () => {
  test('the chip beside the modes toggles the pane; an opener shows above the prompt while it is closed', WITH_SPY, async ($, on) => {
    const { opened, clock, closed, pane } = engine(on)
    on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
    // The engine's own drawing, where the plugin hands a site back.
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      const modes = (e.props as { modes?: readonly string[] }).modes
      return Text({ children: modes !== undefined ? modes.join(' & ') : '' })
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    // Terminal: a button beside the modes.
    let ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
    expect((await ui.find({ key: 'cockpit-toggle' }))?.text).toContain('Cockpit')
    expect(await ui.find({ text: /focus/ })).toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List', tool_use_id: 'c1' })
    await clock.settle()
    await ui.unmount()
    ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    const chip = await ui.find({ key: 'cockpit-toggle' })
    expect(chip?.text).toContain('◆ 1')
    expect(chip?.text).not.toContain('Cockpit')
    const before = opened.length
    await ui.press({ key: 'cockpit-toggle' })
    expect(opened.length).toBe(before + 1)
    pane.isUp = true
    await ui.press({ key: 'cockpit-toggle' })
    expect(closed).toContain('cockpit')
    await ui.unmount()
    pane.isUp = false
    // Desktop: the same button beside the modes ...
    const label = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
    expect((await label.find({ key: 'cockpit-toggle' }))?.text).toContain('◆ 1')
    await label.unmount()
    // ... and above the prompt, while the pane is closed, one opener.
    const band = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    const opener = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'AbovePrompt', props: band })
    expect((await opener.find({ key: 'cockpit-open' }))?.text).toContain('Open Cockpit')
    const n = opened.length
    await opener.press({ key: 'cockpit-open' })
    expect(opened.length).toBe(n + 1)
    expect(await opener.find({ key: 'cockpit-open' })).toBeUndefined()
    await opener.unmount()
  })
})

describe('cockpit desktop live view', () => {
  const T = 1_700_000_000_000
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const mountDesktop = ($: { ui: { mount: (input: never) => Promise<unknown> } }, columns = 80) =>
    $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps(columns) } as never) as Promise<
      Drawn & {
        find: (q: { type?: string; key?: string; text?: string | RegExp }) => Promise<{ key?: string; props: Record<string, unknown>; text: string } | undefined>
        press: (q: { key: string }) => Promise<unknown>
        unmount: () => Promise<void>
      }
    >

  test('a run, a row and a diff unfold on a press', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    const minus = Array.from({ length: 30 }, (_, i) => `-old ${i}`)
    const plus = Array.from({ length: 30 }, (_, i) => `+new ${i}`)
    const long = "printf '%s\\n' alpha beta gamma | sort | uniq -c\necho done"
    on('tool.call', ($, e) =>
      e.tool === 'Edit'
        ? { result: { filePath: '/proj/big.ts', structuredPatch: [{ oldStart: 1, oldLines: 30, newStart: 1, newLines: 30, lines: [...minus, ...plus] }] }, text: 'updated' }
        : { result: { stdout: `out of ${e.tool_use_id}`, stderr: '', interrupted: false }, text: 'ok' },
    )
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: long, tool_use_id: 'x-b1' })
    for (let i = 1; i <= 8; i += 1) await $.tool.call({ tool: 'Grep', pattern: `p${i}`, tool_use_id: `x-g${i}` } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/proj/big.ts', old_string: 'a', new_string: 'b', tool_use_id: 'x-e1' })
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List', tool_use_id: 'x-b2' })
    await clock.settle()
    const ui = await mountDesktop($)
    const rows = async () => (await ui.findAll({ type: 'Button' })).map(one => String(one.key)).filter(key => key.startsWith('row:'))
    // The run folds: its newest three rows, then « + 6 more ».
    expect(await rows()).toEqual(['row:x-g8', 'row:x-g7', 'row:x-g6'])
    expect((await ui.find({ key: 'runmore:x-b1' }))?.text).toBe('+ 6 more')
    await ui.press({ key: 'runmore:x-b1' })
    expect(await rows()).toHaveLength(9)
    expect(await ui.find({ key: 'runmore:x-b1' })).toBeUndefined()
    expect(await ui.find({ key: 'runless:x-b1' })).toBeDefined()
    expect((await peek($, 'ui'))?.open).toEqual(['run:x-b1'])
    // A row unfolds under it: its facts, the whole command, its output.
    expect((await ui.findAll({ type: 'Code' })).some(one => one.props.source === long)).toBe(false)
    await ui.press({ key: 'row:x-b1' })
    const codes = await ui.findAll({ type: 'Code' })
    expect(codes.some(one => one.props.language === 'bash' && one.props.source === long)).toBe(true)
    expect(codes.some(one => one.props.source === 'out of x-b1')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^Bash · done · .+ · exit 0$/ })).toBeDefined()
    await ui.press({ key: 'row:x-b1' })
    expect((await ui.findAll({ type: 'Code' })).some(one => one.props.source === long)).toBe(false)
    await ui.press({ key: 'runless:x-b1' })
    expect(await rows()).toHaveLength(3)
    // The diff: twenty lines, the rest a press away, and back.
    const diffOf = async () => String((await ui.findAll({ type: 'Code' })).find(one => one.props.format === 'diff')?.props.source)
    expect((await diffOf()).trimEnd().split('\n')).toHaveLength(20)
    expect((await ui.find({ key: 'diffmore:x-e1' }))?.text).toBe('Show 41 more lines')
    await ui.press({ key: 'diffmore:x-e1' })
    expect(await diffOf()).toContain('+new 29')
    expect(await ui.find({ key: 'diffmore:x-e1' })).toBeUndefined()
    await ui.press({ key: 'diffless:x-e1' })
    expect(await diffOf()).not.toContain('+new 29')
    // The last command keeps its terminal; short and whole, nothing to unfold.
    expect(await drawnSvg(ui)).toContain('List')
    expect(await ui.find({ key: 'cmd:x-b2' })).toBeUndefined()
    await ui.press({ key: 'diffmore:x-e1' })
    await ui.unmount()
    // What was unfolded goes with /clear.
    await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
    expect((await peek($, 'ui'))?.open).toEqual([])
  })

  test('a long command unfolds under its terminal', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    const steps = Array.from({ length: 12 }, (_, i) => `echo step-${i} && sleep 0`).join(' && ')
    on('tool.call', () => ({ result: { stdout: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), stderr: '', interrupted: false }, text: 'ok' }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: steps, description: 'Run the steps', tool_use_id: 'y-b1' })
    await clock.settle()
    const ui = await mountDesktop($)
    expect((await ui.find({ key: 'cmd:y-b1' }))?.text).toBe('Show full command and output')
    expect(await drawnSvg(ui)).not.toContain('line 0<')
    await ui.press({ key: 'cmd:y-b1' })
    const codes = await ui.findAll({ type: 'Code' })
    expect(codes.some(one => one.props.source === steps && one.props.language === 'bash')).toBe(true)
    expect(codes.some(one => String(one.props.source).startsWith('line 0\nline 1'))).toBe(true)
    expect((await ui.find({ key: 'cmd:y-b1' }))?.text).toBe('Hide details')
    await ui.unmount()
  })

  test('moments keep id-based keys from one drawing to the next', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', ($, e) =>
      e.tool === 'Edit'
        ? { result: { filePath: '/proj/k.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, text: 'updated' }
        : { result: { type: 'text', file: { filePath: '/proj/x.ts', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'x' },
    )
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    for (const id of ['k-r1', 'k-r2']) await $.tool.call({ tool: 'Read', file_path: `/proj/${id}.ts`, tool_use_id: id })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/k.ts', old_string: 'a', new_string: 'b', tool_use_id: 'k-e1' })
    await clock.settle()
    const ui = await mountDesktop($)
    const momentKeys = async () => (await ui.findAll({ type: 'Box' })).map(one => String(one.key)).filter(key => /^(call|file|run|agent|wf|frame):/.test(key))
    expect(await momentKeys()).toEqual(['file:k-e1', 'run:k-r1'])
    // A new call lands: drawn again, what was there keeps its key.
    await $.tool.call({ tool: 'Read', file_path: '/proj/k-r3.ts', tool_use_id: 'k-r3' })
    await clock.settle()
    expect(await momentKeys()).toEqual(['run:k-r3', 'file:k-e1', 'run:k-r1'])
    expect((await ui.findAll({ type: 'Button' })).map(one => String(one.key)).filter(key => key.startsWith('row:'))).toEqual(['row:k-r3', 'row:k-r2', 'row:k-r1'])
    // Every top-level piece is a keyed Box; no key is a position.
    const keys = (await ui.findAll({ type: 'Box' })).map(one => one.key).filter((key): key is string => key !== undefined)
    expect(keys).toEqual(expect.arrayContaining(['live-view', 'header', 'screen-tools', 'sec-history']))
    for (const key of keys) expect(key).not.toMatch(/^(now|h)-\d+$/)
    await ui.unmount()
  })

  test('no drawing is interactive on the desktop, however busy', WITH_SPY, async ($, on) => {
    const listing = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'N-1', name: 'iPhone 17', state: 'Booted' }] } })
    const { clock } = engine(on, {
      run: argv => (argv[0] === 'xcrun' && argv[2] === 'list' ? { stdout: listing } : argv[0] === 'xcrun' || argv[0] === 'sips' ? {} : undefined),
      read: path => (path.endsWith('.jpg') ? { base64: PNG } : undefined),
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let spawned = 0
    on('agent.spawn', () => ({ model: 'm', agentId: spawned++ === 0 ? 'n-ag' : 'n-wa' }))
    on('tool.call', async ($, e) => {
      if (e.tool === 'Workflow') return { result: { status: 'async_launched', taskId: 't', runId: 'n-run', workflowName: 'ultra' }, text: 'launched' }
      if (e.tool === 'Edit') return { result: { filePath: '/proj/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, text: 'updated' }
      if (['n-b1', 'n-a1', 'n-s1'].includes(e.tool_use_id)) await gate
      return { result: { stdout: 'built', stderr: '', interrupted: false }, text: 'ok' }
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.command.run({ command: 'cockpit', args: 'live on', origin: ORIGIN, presentation: PRESENTATION })
    await $.tool.call({ tool: 'Read', file_path: '/proj/r.ts', tool_use_id: 'n-r1' })
    await $.tool.call({ tool: 'Bash', command: 'npm run build', tool_use_id: 'n-b0' })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'a', new_string: 'b', tool_use_id: 'n-e1' })
    await $.tool.call({ tool: 'Workflow', name: 'ultra', tool_use_id: 'n-w1' } as never)
    const spawn = { prompt: 'p', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } as const, parentModel: 'm', background: true, fork: false }
    await $.agent.spawn({ ...spawn, tool_use_id: 'n-sp', description: 'Helper' })
    await $.agent.spawn({ ...spawn, tool_use_id: 'n-w1', description: 'Part 1', workflow: { runId: 'n-run', agentIndex: 1 } })
    const pending = [
      $.tool.call({ tool: 'Agent', description: 'Scout', prompt: 'look', subagent_type: 'Explore', tool_use_id: 'n-s1' } as never),
      $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'n-a1', agentId: 'n-ag' } as never),
      $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'n-b1' }),
    ]
    for (let i = 0; i < 50 && (await peek($, 'stats'))?.running !== 3; i += 1) await peek($, 'feed')
    await clock.settle()
    const ui = await mountDesktop($)
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBeGreaterThanOrEqual(10)
    for (const one of svgs) expect(one.props.isInteractive).toBeUndefined()
    // Every kind of moment is there, each under its own key.
    const keys = (await ui.findAll({ type: 'Box' })).map(one => String(one.key))
    expect(keys).toEqual(expect.arrayContaining(['frame:ios:N-1', 'agent:n-ag', 'wf:n-run', 'agent:n-wa', 'agent:n-s1', 'call:n-b1', 'call:n-b0', 'file:n-e1', 'run:n-r1']))
    // The subagent's call is a native row, its running command a terminal under its card.
    expect((await ui.find({ key: 'row:n-a1' }))?.text).toContain('make')
    expect(await drawnSvg(ui)).toContain('npm test')
    await ui.unmount()
    release()
    await Promise.all(pending)
    await clock.settle()
  })

  test("the pane's clock moves each second while something runs, else every 30 s", WITH_SPY, async ($, on) => {
    const { clock, pane } = engine(on)
    let writes = 0
    on('state.set', ($, e, next) => {
      if (e.plugin === 'cockpit' && e.key === 'now') writes += 1
      return next(e)
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    on('tool.call', async () => {
      await gate
      return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
    })
    pane.isUp = true
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await clock.settle()
    const wait = async (seconds: number) => {
      for (let i = 0; i < seconds; i += 1) await clock.advance(1000)
    }
    // Nothing runs: two moves in a minute.
    writes = 0
    await wait(60)
    expect(writes).toBe(2)
    // A command runs: a move each second, its time ticking.
    const pending = $.tool.call({ tool: 'Bash', command: 'sleep 9', tool_use_id: 'c-slow' })
    for (let i = 0; i < 50 && (await peek($, 'stats'))?.running !== 1; i += 1) await peek($, 'feed')
    writes = 0
    await wait(10)
    expect(writes).toBeGreaterThanOrEqual(9)
    release()
    await pending
    await clock.settle()
  })
})

describe('app registry', () => {
  const bash = (command: string) => ({ tool: 'Bash', command })
  test('MCP servers, commands and file extensions name their app', async () => {
    const apps = [...BUILTIN_APPS]
    expect(appForCall(apps, 'mcp__blender__execute_blender_code', {})?.id).toBe('blender')
    expect(appForCall(apps, 'mcp__godot-mcp__run_project', {})?.id).toBe('godot')
    expect(appForCall(apps, 'mcp__Claude_Browser__navigate', {})?.id).toBe('claude-browser')
    expect(appForCall(apps, 'mcp__Claude_Code_iOS_Simulator__control', {})?.id).toBe('ios-simulator')
    expect(appForCall(apps, 'mcp__linear__list_issues', {})).toBeUndefined()
    expect(appForCall(apps, 'Bash', bash('openscad -o out/p.png part.scad'))?.id).toBe('openscad')
    expect(appForCall(apps, 'Bash', bash('/Applications/Blender.app/Contents/MacOS/Blender -b x.blend -f 1'))?.id).toBe('blender')
    expect(appForCall(apps, 'Bash', bash('cd game && godot --headless --export-release "Web" build/index.html'))?.id).toBe('godot')
    expect(appForCall(apps, 'Bash', bash('UnrealEditor-Cmd Game.uproject -run=cook'))?.id).toBe('unreal')
    expect(appForCall(apps, 'Bash', bash('/Applications/Unity/Hub/Editor/6000.0/Unity.app/Contents/MacOS/Unity -batchmode -runTests'))?.id).toBe('unity')
    expect(appForCall(apps, 'Bash', bash('kicad-cli pcb export gerbers board.kicad_pcb'))?.id).toBe('kicad')
    expect(appForCall(apps, 'Bash', bash('xcrun simctl list'))?.id).toBe('ios-simulator')
    expect(appForCall(apps, 'Bash', bash('ls -la'))).toBeUndefined()
    // A folder named after an app is no app.
    expect(appForCall(apps, 'Bash', bash('ls blender-assets/'))).toBeUndefined()
    expect(appForCall(apps, 'Edit', { file_path: '/p/scenes/main.tscn' })?.id).toBe('godot')
    expect(appForCall(apps, 'Write', { file_path: '/p/Part.FCStd' })?.id).toBe('freecad')
    expect(appForCall(apps, 'Read', { file_path: '/p/board.kicad_sch' })?.id).toBe('kicad')
    expect(appForCall(apps, 'Edit', { file_path: '/p/a.ts' })).toBeUndefined()
  })

  test("an app's command is titled by what it does", async () => {
    const app = (id: string) => BUILTIN_APPS.find(a => a.id === id)!
    expect(appCommandTitle(app('blender'), 'blender -b x.blend -o //render_####.png -f 1')).toBe('Blender · Render')
    expect(appCommandTitle(app('godot'), 'godot --headless --export-release "Web" build/index.html')).toBe('Godot · Export')
    expect(appCommandTitle(app('openscad'), 'openscad -o out/preview.png part.scad')).toBe('OpenSCAD · Render')
    expect(appCommandTitle(app('openscad'), 'openscad -o out/part.stl part.scad')).toBe('OpenSCAD · Export')
    expect(appCommandTitle(app('unity'), 'Unity -batchmode -runTests -projectPath .')).toBe('Unity · Test')
    expect(appCommandTitle(app('unreal'), 'RunUAT.sh BuildCookRun -project=G.uproject')).toBe('Unreal Engine · Build')
    // `export VAR=` is the shell's, not the app's.
    expect(appCommandTitle(app('blender'), 'export PATH=/x:$PATH; blender --version')).toBeUndefined()
  })

  test('image and asset paths are read off a command', async () => {
    expect(pathsInCommand('openscad -o out/preview.png part.scad', IMAGE_EXT)).toEqual(['out/preview.png'])
    expect(pathsInCommand('blender -b x.blend -o //render_####.png -f 1', IMAGE_EXT)).toEqual([])
    expect(pathsInCommand('blender -b scenes/x.blend -o //shots/a.png -f 1', IMAGE_EXT)).toEqual(['scenes/shots/a.png'])
    expect(pathsInCommand('tool --output=/tmp/a.jpg && convert x > "b c.webp"', IMAGE_EXT)).toEqual(['/tmp/a.jpg', 'b c.webp'])
    expect(pathsInCommand('magick *.png out.gif', IMAGE_EXT)).toEqual(['out.gif'])
    expect(pathsInCommand('freecadcmd make.py Part.FCStd', BINARY_EXT)).toEqual(['Part.FCStd'])
    expect(resolvePath('out/p.png', '/proj', '/Users/me')).toBe('/proj/out/p.png')
    expect(resolvePath('~/x/../y.png', '/proj', '/Users/me')).toBe('/Users/me/y.png')
  })

  test("the user's config adds apps, replaces built-ins by id and ignores bad entries", async () => {
    const user = appsFromConfig({
      apps: [
        { name: 'Krita', color: '#3bacd4', glyph: 'K', match: { command: '(^|[\\s/])krita(\\s|$)', files: ['.kra'] }, window: 'krita' },
        { id: 'blender', name: 'Blender 4', color: '#ff7700', match: { mcp: 'blender' } },
        { name: 'Broken', match: { command: '([' } },
        { color: '#000000', match: { mcp: 'x' } },
        { name: 'Nothing to match' },
        'not an object',
      ],
    })
    expect(user.apps.map(a => a.id)).toEqual(['krita', 'blender'])
    expect(user.ignored).toBe(4)
    expect(appsFromConfig({ nope: true })).toEqual({ apps: [], ignored: 0 })
    const merged = mergeApps(BUILTIN_APPS, user.apps)
    expect(appForCall(merged, 'Bash', { command: 'krita --export a.png x.kra' })?.name).toBe('Krita')
    expect(appForCall(merged, 'Write', { file_path: '/p/x.kra' })?.id).toBe('krita')
    expect(appForCall(merged, 'mcp__blender__get_scene_info', {})?.name).toBe('Blender 4')
    expect(merged.filter(a => a.id === 'blender')).toHaveLength(1)
  })

  test('a screenshot tool is found on the same server, never the call itself', async () => {
    const blender = BUILTIN_APPS.find(a => a.id === 'blender')!
    const tools = ['mcp__blender__get_scene_info', 'mcp__blender__get_viewport_screenshot', 'mcp__other__screenshot']
    expect(appScreenshotTool(blender, 'mcp__blender__get_scene_info', tools)).toBe('mcp__blender__get_viewport_screenshot')
    expect(appScreenshotTool(blender, 'mcp__blender__get_viewport_screenshot', tools)).toBeUndefined()
    const godot = BUILTIN_APPS.find(a => a.id === 'godot')!
    expect(appScreenshotTool(godot, 'mcp__godot__run', ['mcp__godot__run', 'mcp__godot__capture_viewport'])).toBe('mcp__godot__capture_viewport')
    expect(appScreenshotTool(godot, 'mcp__godot__run', ['mcp__godot__run'])).toBeUndefined()
  })
})

describe('cockpit universal screen', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const T0 = 1_700_000_000_000
  const ok = { result: { stdout: '', stderr: '', interrupted: false }, text: '' }

  test('an OpenSCAD render that writes out/p.png puts that image on the screen', WITH_SPY, async ($, on) => {
    const { clock } = engine(on, {
      stat: path => (path === '/proj/out/p.png' ? { kind: 'file', size: PNG.length, mtimeMs: T0 + 40 } : undefined),
      read: path => (path === '/proj/out/p.png' ? { base64: PNG } : undefined),
    })
    on('tool.call', () => ok)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const r = await $.tool.call({ tool: 'Bash', command: 'openscad -o out/p.png part.scad', description: 'Render the part', tool_use_id: 'scad-1' })
    expect(r).toEqual(ok)
    await clock.settle()
    expect(await peek($, 'event', 'scad-1')).toMatchObject({ app: 'openscad', title: 'OpenSCAD · Render', status: 'ok' })
    const screen = await peek($, 'screen')
    expect(screen).toMatchObject({ source: 'file', app: 'OpenSCAD', eventId: 'scad-1', b64: PNG, mime: 'image/png', width: 1, height: 1 })
    expect(screen?.label).toContain('OpenSCAD')
    expect(screen?.label).toContain('out/p.png')
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      if (surface === 'terminal') {
        await ui.press({ key: 'tab-screen' })
        expect(await ui.find({ text: /OpenSCAD · out\/p\.png/ })).toBeDefined()
      } else {
        // The frame leads NOW, the command's terminal under it, both badged.
        const svgs = (await ui.findAll({ type: 'Svg' })).map(one => String(one.props.source))
        expect(svgs[2]).toContain('<image href="data:image/png;base64,')
        expect(svgs[2]).toContain('OpenSCAD')
        expect(svgs.some(s => s.includes('openscad -o out/p.png') && s.includes('OpenSCAD') && s.includes('Render'))).toBe(true)
      }
      await ui.unmount()
    }
  })

  test('an image the command did not write this time stays off the screen', WITH_SPY, async ($, on) => {
    const { clock } = engine(on, {
      stat: path => (path === '/proj/out/p.png' ? { kind: 'file', size: 100, mtimeMs: T0 - 3_600_000 } : undefined),
      read: () => ({ base64: PNG }),
    })
    on('tool.call', () => ok)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'ls out/p.png', tool_use_id: 'ls-1' })
    await clock.settle()
    expect((await peek($, 'screen'))?.b64).toBeUndefined()
  })

  test('a Read of a PNG puts it on the screen', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    on('tool.call', () => ({ result: { type: 'image', file: { base64: PNG, type: 'image/png', originalSize: 70 } }, text: '' }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Read', file_path: '/proj/shots/home.png', tool_use_id: 'rd-1' })
    await clock.settle()
    const screen = await peek($, 'screen')
    expect(screen).toMatchObject({ source: 'tool', label: 'Read · shots/home.png', b64: PNG, eventId: 'rd-1' })
    // The same picture in the transcript row is not taken twice.
    const gen = screen?.generation
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'rd-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'row-rd',
    })
    await clock.settle()
    expect((await peek($, 'screen'))?.generation).toBe(gen)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
    // Claude's turn is over: the picture is history, a smaller card above the read that made it.
    const svgs = (await ui.findAll({ type: 'Svg' })).map(one => String(one.props.source))
    expect(svgs[1]).toContain('HISTORY')
    expect(svgs[2]).toContain('<image href="data:image/png;base64,')
    expect(await ui.find({ type: 'Box', key: 'frame:read:/proj/shots/home.png' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Read · shots\/home\.png|shots\/home\.png/ })).toBeDefined()
    await ui.unmount()
  })

  test("any tool's image in its transcript row reaches the screen", WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fig-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'mcp__figma__get_image' },
      uuid: 'row-fig',
    })
    await clock.settle()
    expect(await peek($, 'screen')).toMatchObject({ source: 'tool', label: 'figma · get image', b64: PNG })
  })

  for (const decision of ['allow', 'ask'] as const) {
    test(`a Blender MCP action with no image asks for its viewport only when allowed (${decision})`, WITH_SPY, async ($, on) => {
      const { clock } = engine(on, { tools: ['mcp__blender__execute_blender_code', 'mcp__blender__get_viewport_screenshot'] })
      const calls: { tool: string; max_size?: number }[] = []
      on('tool.check', () => ({ decision }))
      on('tool.call', ($, e) => {
        calls.push(e as unknown as { tool: string; max_size?: number })
        return (e.tool as string) === 'mcp__blender__get_viewport_screenshot'
          ? { result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }, text: '' }
          : { result: { content: [{ type: 'text', text: 'done' }] }, text: 'done' }
      })
      await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
      await $.tool.call({ tool: 'mcp__blender__execute_blender_code', code: 'bpy.ops.mesh.primitive_cube_add()', tool_use_id: 'bl-1' } as never)
      await clock.settle()
      expect(calls).toHaveLength(1)
      await clock.advance(1000)
      await clock.settle()
      const shots = calls.filter(c => c.tool === 'mcp__blender__get_viewport_screenshot')
      expect((await peek($, 'event', 'bl-1'))?.app).toBe('blender')
      if (decision === 'allow') {
        expect(shots).toEqual([expect.objectContaining({ max_size: 800 })])
        expect(await peek($, 'screen')).toMatchObject({ source: 'tool', app: 'Blender', label: 'Blender · get viewport screenshot', eventId: 'bl-1', b64: PNG })
        const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
        expect((await ui.findAll({ type: 'Svg' })).map(one => String(one.props.source))[2]).toContain('<image')
        await ui.unmount()
      } else {
        expect(shots).toEqual([])
        expect((await peek($, 'screen'))?.b64).toBeUndefined()
      }
      expect((await peek($, 'feed'))?.map(f => f.id)).toEqual(['bl-1'])
    })
  }

  const finder = JSON.stringify({ id: 500, width: 1056, height: 436, title: 'Downloads', named: 14, count: 20 })

  test('/cockpit watch Finder captures its window through osascript and screencapture', WITH_SPY, async ($, on) => {
    const { clock, argvs, pane, toasts } = engine(on, {
      run: argv => (argv[0] === 'osascript' ? { stdout: finder } : argv[0] === 'screencapture' || argv[0] === 'sips' ? {} : undefined),
      stat: path => (path.endsWith('window.png') ? { kind: 'file', size: 173_126, mtimeMs: T0 + 10 } : undefined),
      read: path => (path.endsWith('window.jpg') ? { base64: PNG } : undefined),
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const r = await $.command.run({ command: 'cockpit', args: 'watch Finder', origin: ORIGIN, presentation: PRESENTATION })
    expect(r.text).toBeUndefined()
    await clock.settle()
    expect(toasts.some(t => t.includes('watching Finder'))).toBe(true)
    const osa = argvs.find(a => a[0] === 'osascript')
    expect(osa?.slice(0, 4)).toEqual(['osascript', '-l', 'JavaScript', '-e'])
    expect(osa?.[4]).toContain('CGWindowListCopyWindowInfo')
    expect(osa?.[5]).toBe('Finder')
    expect(argvs).toContainEqual(['screencapture', '-x', '-o', '-l', '500', expect.stringContaining('window.png')])
    // Never the whole screen: every capture names a window.
    expect(argvs.filter(a => a[0] === 'screencapture').every(a => a.includes('-l'))).toBe(true)
    const screen = await peek($, 'screen')
    expect(screen).toMatchObject({ source: 'window', watch: 'Finder', app: 'Finder', label: 'Finder · Downloads', mime: 'image/jpeg' })
    expect(screen?.error).toBeUndefined()
    // The live view shows it, and the watch keeps polling while the pane is up.
    pane.isUp = true
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
    const svg = await drawnSvg(ui)
    expect(svg).toContain('aria-label="Finder"')
    expect(svg).toContain('NOW')
    expect(await ui.find({ type: 'Text', text: /Finder · Downloads · Watching/ })).toBeDefined()
    const before = argvs.filter(a => a[0] === 'screencapture').length
    await clock.advance(4000)
    await clock.settle()
    expect(argvs.filter(a => a[0] === 'screencapture').length).toBeGreaterThan(before)
    await ui.unmount()
    await $.command.run({ command: 'cockpit', args: 'watch off', origin: ORIGIN, presentation: PRESENTATION })
    expect((await peek($, 'screen'))?.watch).toBeUndefined()
    const after = argvs.filter(a => a[0] === 'screencapture').length
    await clock.advance(4000)
    await clock.settle()
    expect(argvs.filter(a => a[0] === 'screencapture').length).toBe(after)
  })

  for (const failure of ['no window titles', 'screencapture fails'] as const) {
    test(`a missing Screen Recording permission says so and stops the watch (${failure})`, WITH_SPY, async ($, on) => {
      const listing = failure === 'no window titles' ? JSON.stringify({ id: 500, width: 10, height: 10, title: '', named: 0, count: 20 }) : finder
      const { clock, argvs } = engine(on, {
        run: argv =>
          argv[0] === 'osascript' ? { stdout: listing } : argv[0] === 'screencapture' ? { exitCode: 1, stderr: 'could not create image from window' } : undefined,
        stat: () => undefined,
      })
      await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
      await $.command.run({ command: 'cockpit', args: 'watch Finder', origin: ORIGIN, presentation: PRESENTATION })
      await clock.settle()
      const screen = await peek($, 'screen')
      expect(screen?.error).toBe(SCREEN_RECORDING_HELP)
      expect(screen?.watch).toBeUndefined()
      expect(screen?.b64).toBeUndefined()
      expect(argvs.filter(a => a[0] === 'screencapture')).toHaveLength(failure === 'no window titles' ? 0 : 1)
      const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
      expect(await ui.find({ text: /Screen Recording permission for Claude/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('a registry app with a window is captured after a command that drives it', WITH_SPY, async ($, on) => {
    const config = { apps: [{ name: 'Krita', color: '#3bacd4', glyph: 'K', match: { command: '(^|[\\s/])krita(\\s|$)' }, window: 'krita' }, { name: 'bad', match: { command: '((' } }] }
    const krita = JSON.stringify({ id: 77, width: 800, height: 600, title: 'untitled.kra', named: 9, count: 12 })
    const { clock, argvs } = engine(on, {
      run: argv => (argv[0] === 'osascript' ? { stdout: krita } : argv[0] === 'screencapture' || argv[0] === 'sips' ? {} : undefined),
      stat: path => (path.endsWith('window.png') ? { kind: 'file', size: 50_000, mtimeMs: T0 + 900 } : undefined),
      read: path => (path === '/Users/test/.claude/cockpit.json' ? JSON.stringify(config) : path.endsWith('window.jpg') ? { base64: PNG } : undefined),
    })
    on('tool.call', () => ok)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'krita --nosplash x.kra', tool_use_id: 'kr-1' })
    await clock.settle()
    expect((await peek($, 'event', 'kr-1'))?.app).toBe('krita')
    await clock.advance(1000)
    await clock.settle()
    expect(argvs.find(a => a[0] === 'osascript')?.[5]).toBe('krita')
    expect(await peek($, 'screen')).toMatchObject({ source: 'window', app: 'Krita', appColor: '#3bacd4', eventId: 'kr-1' })
  })

  test('a binary asset a command changed gets an asset card, not a diff', WITH_SPY, async ($, on) => {
    const { clock } = engine(on, {
      stat: path => (path === '/proj/scene.blend' ? { kind: 'file', size: 3_355_443, mtimeMs: T0 + 500 } : undefined),
    })
    on('tool.call', () => ok)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'blender -b scene.blend --python add_cube.py', description: 'Add a cube', tool_use_id: 'bl-2' })
    await clock.settle()
    expect((await peek($, 'event', 'bl-2'))?.title).toBe('Add a cube')
    const changes = await peek($, 'changes', '/proj/scene.blend')
    expect(changes?.[0]).toMatchObject({ isBinary: true, size: 3_355_443, diff: '', added: 0, removed: 0 })
    expect((await peek($, 'files'))?.[0]).toMatchObject({ path: '/proj/scene.blend' })
    expect((await peek($, 'feed'))?.map(f => f.id)).toEqual(['bl-2', 'bl-2~asset0'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      if (surface === 'terminal') {
        await ui.press({ key: 'tab-files' })
        expect(await ui.find({ text: /binary asset changed · 3\.2 MB/ })).toBeDefined()
      } else {
        const svg = await drawnSvg(ui)
        expect(svg).toContain('Asset changed')
        expect(svg).toContain('scene.blend')
        expect(svg).toContain('3.2 MB')
        expect(svg).toContain('Blender')
        expect(await ui.find({ type: 'Code' })).toBeUndefined()
      }
      await ui.unmount()
    }
  })

  test('an image a command wrote is now while Claude works, then sits above its command', async () => {
    const shot: CockpitFrame = { key: 'file:/proj/out/p.png', source: 'file', label: 'OpenSCAD · out/p.png', b64: PNG, mime: 'image/png', eventId: 'scad', at: T0 }
    const scad: CockpitEvent = { id: 'scad', tool: 'Bash', cat: 'shell', title: 'OpenSCAD · Render', status: 'ok', startedAt: T0, endedAt: T0 + 100, input: '', app: 'openscad' }
    const base = { agents: [], workflows: [], changes: new Map(), now: T0 + 1000, isLive: false }
    // Claude is still at it: the picture is now, the command (done) tops the history.
    const working = planLive({ ...base, events: [scad], frames: [shot], isWorking: true })
    expect(working.now.map(m => m.kind)).toEqual(['frame'])
    expect(working.history.map(m => m.kind)).toEqual(['call'])
    // Its turn over: the picture sits above the command that made it.
    const after = planLive({ ...base, events: [scad], frames: [shot], isWorking: false })
    expect(after.now).toEqual([])
    expect(after.history.map(m => m.kind)).toEqual(['frame', 'call'])
  })
})
