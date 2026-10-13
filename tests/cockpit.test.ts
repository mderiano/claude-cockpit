import { describe, expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { CockpitAgent, CockpitChange, CockpitEvent, CockpitFeedRef, CockpitFile, CockpitScreen, CockpitStats, CockpitUi, CockpitWorkflow } from '../types'

import { diffLines, diffTexts, renderHunks } from '../hooks/diff'
import { clean } from '../hooks/model'
import { imageSize, parseSimctl } from '../hooks/screen'

const SURFACES = ['terminal', 'desktop'] as const
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

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

/** The engine beneath the plugin: everything it may ask, answered from memory. */
const engine = (on: On) => {
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
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
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
  on('process.run', ($, e) => ({
    value: {
      exitCode: e.argv[0] === 'xcrun' ? 0 : 1,
      stdout: e.argv[0] === 'xcrun' ? '{"devices":{}}' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  return { toasts, statuses, clock, opened }
}

describe('cockpit', () => {
  test('a Bash call lands in the feed with its output and an ok status', WITH_SPY, async ($, on) => {
    const { statuses } = engine(on)
    on('tool.call', ($, e) => ({
      result: { stdout: 'PASS src/a.test.ts\nAll good: 12 tests', stderr: '', interrupted: false },
      text: 'All good',
    }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests', tool_use_id: 'b1' })
    // The result reaches the model untouched.
    expect(r.text).toBe('All good')
    const ev = { value: await peek($, 'event', 'b1') }
    expect(ev.value).toMatchObject({ tool: 'Bash', cat: 'shell', status: 'ok', exitCode: 0, isTest: true })
    expect(ev.value?.output).toContain('All good: 12 tests')
    const stats = { value: await peek($, 'stats') }
    expect(stats.value).toMatchObject({ calls: 1, commands: 1, running: 0, errors: 0, streak: 1 })
    expect(stats.value?.milestones).toContain('tests-green')
    expect(statuses.some(s => s?.includes('1 call') === true)).toBe(true)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', viewport: { columns: 100, rows: 40, isFullscreen: true }, props: paneProps() })
      expect(await ui.find({ text: /Run the tests/ })).toBeDefined()
      expect(await ui.find({ text: /All good: 12 tests/ })).toBeDefined()
      expect(await ui.find({ text: /\$ npm test/ })).toBeDefined()
      // Expanding the row shows the command and the full output.
      await ui.press({ key: 'ev-b1' })
      const codes = await ui.findAll({ type: 'Code' })
      expect(codes.some(c => c.props.source === 'npm test')).toBe(true)
      expect(codes.some(c => String(c.props.source).includes('PASS src/a.test.ts'))).toBe(true)
      await ui.press({ key: 'ev-b1' })
      await ui.unmount()
    }
  })

  test('a failing or denied call is shown as such and the answer is relayed unchanged', WITH_SPY, async ($, on) => {
    engine(on)
    on('tool.call', ($, e) =>
      e.tool_use_id === 'd1' ? { deny: 'nope' } : { isError: true as const, result: 'Exit code 2\nboom', text: 'Exit code 2\nboom' },
    )
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const failed = await $.tool.call({ tool: 'Bash', command: 'false', tool_use_id: 'e1' })
    expect(failed.isError).toBe(true)
    expect(failed.text).toBe('Exit code 2\nboom')
    const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf x', tool_use_id: 'd1' })
    expect(denied.deny).toBe('nope')
    const e1 = { value: await peek($, 'event', 'e1') }
    expect(e1.value).toMatchObject({ status: 'error', exitCode: 2 })
    const d1 = { value: await peek($, 'event', 'd1') }
    expect(d1.value?.status).toBe('denied')
    const stats = { value: await peek($, 'stats') }
    expect(stats.value).toMatchObject({ errors: 1, denied: 1, streak: 0 })
  })

  test('an Edit records the file and a unified diff', WITH_SPY, async ($, on) => {
    engine(on)
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
    const files = { value: await peek($, 'files') }
    expect(files.value?.[0]).toMatchObject({ path: '/proj/src/app.ts', added: 1, removed: 1, edits: 1 })
    const changes = { value: await peek($, 'changes', '/proj/src/app.ts') }
    const diff = changes.value?.[0]?.diff ?? ''
    expect(diff.startsWith('@@ -1,3 +1,3 @@')).toBe(true)
    expect(diff).toContain('+const a = 2')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      await ui.press({ key: 'tab-files' })
      const code = await ui.find({ type: 'Code' })
      expect(code?.props.format).toBe('diff')
      expect(String(code?.props.source).startsWith('@@')).toBe(true)
      expect(await ui.find({ text: /app\.ts/ })).toBeDefined()
      await ui.press({ key: 'tab-feed' })
      await ui.unmount()
    }
  })

  test('a Write that creates a file is all added lines', WITH_SPY, async ($, on) => {
    engine(on)
    on('tool.call', () => ({
      result: { type: 'create', filePath: '/proj/new.md', content: '# Hi\nthere\n', structuredPatch: [], originalFile: null },
      text: 'created',
    }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Write', file_path: '/proj/new.md', content: '# Hi\nthere\n', tool_use_id: 'w1' })
    const changes = { value: await peek($, 'changes', '/proj/new.md') }
    expect(changes.value?.[0]?.diff).toBe('@@ -0,0 +1,2 @@\n+# Hi\n+there\n')
    const files = { value: await peek($, 'files') }
    expect(files.value?.[0]).toMatchObject({ isCreated: true, added: 2, removed: 0 })
  })

  test('a subagent and its tool calls are attributed to its agentId', WITH_SPY, async ($, on) => {
    engine(on)
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
    const feed = { value: await peek($, 'feed') }
    expect(feed.value).toContainEqual({ id: 'r1', agent: 'ag-1' })
    const r1 = { value: await peek($, 'event', 'r1') }
    expect(r1.value?.agentId).toBe('ag-1')
    let agents = { value: await peek($, 'agents') }
    expect(agents.value?.[0]).toMatchObject({ id: 'ag-1', description: 'Bug hunter', type: 'Explore', status: 'running', tools: 1, lastTool: 'Read' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
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
    engine(on)
    let n = 0
    on('agent.spawn', () => ({ model: 'm', agentId: `wf-agent-${++n}` }))
    on('tool.call', () => ({ result: { status: 'async_launched', taskId: 'task-1', runId: 'wf_123', workflowName: 'ultra-review' }, text: 'launched' }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Workflow', name: 'ultra-review', tool_use_id: 'wf-call' })
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
      await ui.press({ key: 'tab-agents' })
      expect(await ui.find({ text: /ultra-review/ })).toBeDefined()
      expect(await ui.find({ text: /#2 Part 2/ })).toBeDefined()
      expect(await ui.find({ text: /0\/3/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('concurrent calls all land (no lost writes)', WITH_SPY, async ($, on) => {
    engine(on)
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
    const feed = { value: await peek($, 'feed') }
    expect(feed.value?.map((f: CockpitFeedRef) => f.id)).toEqual(['slow', 'fast-a', 'fast-b'])
    const stats = { value: await peek($, 'stats') }
    expect(stats.value).toMatchObject({ calls: 3, running: 0, commands: 3 })
    const ev = { value: await peek($, 'event', 'slow') }
    expect(ev.value?.status).toBe('ok')
  })

  test('the pane draws on every surface and the tabs switch views', WITH_SPY, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps(surface === 'mobile' ? 40 : 80) })
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
    const { opened } = engine(on)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const r = await $.command.run({ command: 'cockpit', args: 'agents', origin: ORIGIN, presentation: PRESENTATION })
    expect(r.text).toContain('agents')
    expect(opened).toContain('cockpit')
    const ui = { value: await peek($, 'ui') }
    expect(ui.value?.tab).toBe('agents')
  })

  test('a browser screenshot in a tool result reaches the Screen tab', WITH_SPY, async ($, on) => {
    const { clock } = engine(on)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
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
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'cockpit', props: paneProps() })
    await ui.press({ key: 'tab-screen' })
    const svgs = await ui.findAll({ type: 'Svg' })
    const svg = svgs.find(one => String(one.props.source).includes('<image'))
    expect(svg).toBeDefined()
    expect(String(svg?.props.source)).toContain('data:image/png;base64,')
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
      await ui.press({ key: 'tab-screen' })
      await ui.press({ key: 'snap' })
      expect(await ui.find({ text: /iPhone 17 Pro/ })).toBeDefined()
      if (surface === 'terminal') {
        const image = await ui.find({ type: 'Image' })
        expect(image?.props.source).toMatchObject({ file: expect.stringContaining('device.png'), format: 'png' })
      } else {
        const svgs = await ui.findAll({ type: 'Svg' })
        expect(svgs.some(one => String(one.props.source).includes('<image href="data:image/jpeg;base64,'))).toBe(true)
      }
      await ui.unmount()
    }
    expect(argvs).toContainEqual(['xcrun', 'simctl', 'io', 'U-1', 'screenshot', '--type=png', expect.stringContaining('/tmp/x/cockpit-')])
    expect(argvs.some(a => a[0] === 'sips' && a.includes('jpeg'))).toBe(true)
    const screen = await peek($, 'screen')
    expect(screen).toMatchObject({ source: 'ios', label: 'iPhone 17 Pro' })
    expect(screen?.error).toBeUndefined()
  })

  test('the feed keeps a bounded window of events', { ...WITH_SPY, timeoutMs: 120_000 }, async ($, on) => {
    engine(on)
    on('tool.call', ($, e) => ({ result: { stdout: 'x'.repeat(9000), stderr: '', interrupted: false }, text: 'x' }))
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    for (let i = 0; i < 305; i += 1) await $.tool.call({ tool: 'Bash', command: `echo ${i}`, tool_use_id: `n${i}` })
    const feed = await peek($, 'feed')
    expect(feed).toHaveLength(300)
    expect(feed?.[0]?.id).toBe('n5')
    expect(await peek($, 'event', 'n0')).toBeNull()
    const last = await peek($, 'event', 'n304')
    expect((last?.output ?? '').length).toBeLessThan(4200)
    const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'cockpit', props: paneProps(30) })
    expect(await ui.find({ key: 'more' })).toBeDefined()
    await ui.press({ key: 'more' })
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
  })
})

describe('cockpit robustness', () => {
  test('ANSI colours and control characters in tool output never break the pane', WITH_SPY, async ($, on) => {
    engine(on)
    on('tool.call', ($, e) =>
      e.tool_use_id === 'c1'
        ? { result: { stdout: '\x1b[32mok\x1b[0m done\r\nline\x07two\nprogress 10%\rprogress 100%', stderr: '', interrupted: false }, text: 'ok' }
        : { isError: true as const, result: '\x1b[31mfailed\x1b[0m', text: '\x1b[31mfailed\x1b[0m' },
    )
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build \x1b[1mbold\x1b[0m', tool_use_id: 'c1' })
    await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x', tool_use_id: 'c2' })
    const ev = await peek($, 'event', 'c1')
    expect(ev?.output).toBe('ok done\nlinetwo\nprogress 100%')
    expect(ev?.title).toBe('Build bold')
    expect((await peek($, 'event', 'c2'))?.output).toBe('failed')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'cockpit', props: paneProps() })
      expect(await ui.find({ text: /progress 100%/ })).toBeDefined()
      await ui.press({ key: 'ev-c1' })
      const codes = await ui.findAll({ type: 'Code' })
      expect(codes.some(c => String(c.props.source).includes('progress 100%'))).toBe(true)
      await ui.press({ key: 'ev-c1' })
      await ui.unmount()
    }
    expect(clean('a\x1b]0;title\x07b\x00c\td')).toBe('abc\td')
  })

  test('a call that rejects is closed as interrupted and the running count comes back', WITH_SPY, async ($, on) => {
    engine(on)
    on('tool.call', ($, e) => {
      if (e.tool_use_id === 'boom') throw new Error('worker gone')
      return { result: { stdout: 'fine', stderr: '', interrupted: false }, text: 'fine' }
    })
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    await expect($.tool.call({ tool: 'Bash', command: 'x', tool_use_id: 'boom' })).rejects.toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'y', tool_use_id: 'ok1' })
    expect((await peek($, 'event', 'boom'))?.status).toBe('error')
    expect(await peek($, 'stats')).toMatchObject({ running: 0, calls: 2 })
  })

  test('a row left running is reconciled when its loop turn completes', WITH_SPY, async ($, on) => {
    engine(on)
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
      await ui.press({ key: 'tab-screen' })
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
    engine(on)
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
