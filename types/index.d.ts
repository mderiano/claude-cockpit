// Cockpit: the state contract. Every value a drawing reads lives here, in
// $.state, so a hot reload of the module keeps the whole picture.

/** Which tab of the pane is shown. */
export type CockpitTab = 'feed' | 'files' | 'agents' | 'screen'

/** The colour family a tool call belongs to. */
export type CockpitCategory =
  | 'shell'
  | 'edit'
  | 'read'
  | 'search'
  | 'web'
  | 'agent'
  | 'browser'
  | 'mcp'
  | 'task'
  | 'other'

export type CockpitStatus = 'running' | 'ok' | 'error' | 'denied'

/** One row of the feed index: small, so the list itself stays cheap. */
export type CockpitFeedRef = {
  id: string
  /** The loop the call ran in; absent on the main loop. */
  agent?: string
}

/** One tool call, as the feed draws it (kept per id in a state family). */
export type CockpitEvent = {
  id: string
  tool: string
  cat: CockpitCategory
  title: string
  /** A second line: the command, the path, the URL. */
  detail?: string
  agentId?: string
  status: CockpitStatus
  startedAt: number
  endedAt?: number
  /** Pretty input, capped. */
  input: string
  /** Output excerpt (stdout/stderr/result text), capped. */
  output?: string
  exitCode?: number
  filePath?: string
  added?: number
  removed?: number
  isTest?: boolean
  isBackground?: boolean
  /** The app the call works with (an id of Cockpit's app registry). */
  app?: string
}

/** One file Claude touched. */
export type CockpitFile = {
  path: string
  added: number
  removed: number
  edits: number
  firstAt: number
  lastAt: number
  lastTool: string
  lastAgent?: string
  isCreated?: boolean
}

/** One change of a file: a unified diff of hunks only (`@@ ... @@`). */
export type CockpitChange = {
  id: string
  at: number
  tool: string
  agentId?: string
  diff: string
  added: number
  removed: number
  isTruncated?: boolean
  /** No diff: the old content was too large for the tool to include one. */
  isTooLarge?: boolean
  /** A binary asset (a .blend, an .stl...): shown with its size, never a diff. */
  isBinary?: boolean
  /** The asset's size in bytes, when known. */
  size?: number
}

export type CockpitAgentStatus = 'running' | 'idle' | 'done' | 'failed' | 'killed'

/** One subagent, teammate or workflow agent. */
export type CockpitAgent = {
  id: string
  description: string
  type: string
  status: CockpitAgentStatus
  startedAt: number
  endedAt?: number
  tools: number
  errors: number
  lastTool?: string
  lastTitle?: string
  lastAt?: number
  parentId?: string
  runId?: string
  workflowIndex?: number
  isBackground?: boolean
  isTeammate?: boolean
  name?: string
  model?: string
  toolUseId?: string
  tokens?: number
  answer?: string
}

/** One workflow run (ultracode), grouping the agents it started. */
export type CockpitWorkflow = {
  runId: string
  name?: string
  toolUseId?: string
  startedAt: number
}

export type CockpitStats = {
  startedAt: number
  calls: number
  commands: number
  errors: number
  denied: number
  added: number
  removed: number
  running: number
  streak: number
  bestStreak: number
  turns: number
  isWorking: boolean
  /** Tool calls per bucket of SPARK_MS, oldest first. */
  spark: number[]
  /** The bucket index (time / SPARK_MS) of the last entry of `spark`. */
  sparkAt: number
  milestones: string[]
}

export type CockpitUi = {
  tab: CockpitTab
  /** 'all', 'main', or an agent id. */
  filter: string
  expanded: string | null
  file: string | null
  agent: string | null
  /** Rows per page of the feed (FEED_PAGE at most). */
  limit: number
  /** Rows of the feed skipped from the newest: the page in view. */
  offset?: number
  /** Finished workflow runs the person unfolded on the Agents tab. */
  openRuns?: string[]
  /** Show every finished loose agent, not only the latest few. */
  showAllAgents?: boolean
  /** The pane was opened unasked once this session (never twice). */
  autoOpened?: boolean
  /** The pane is up on some surface (opened and not closed since). */
  isPaneShown?: boolean
  /**
   * What the person unfolded on the desktop's live view, oldest first, at
   * most 40: `call:<id>` (a call's command, input and output), `run:<key>`
   * (every row of a run), `diff:<id>` (a change's whole diff).
   */
  open?: string[]
}

/**
 * The single screen the terminal's Screen tab draws (the newest frame, or
 * the first device Live follows), and the screen's switches.
 */
export type CockpitScreen = {
  /**
   * Live screen: every booted simulator and connected emulator is looked at
   * every 2 s (slower while there is none) until the person turns it off.
   */
  isLive: boolean
  /**
   * Where the frame came from: a device capture, an image in a tool's result
   * (`tool`), an image file a command wrote (`file`), an app's window
   * (`window`, macOS).
   */
  source: 'none' | 'ios' | 'android' | 'tool' | 'file' | 'window'
  label: string
  /** The app the frame shows, when the registry knows it: its name and colour. */
  app?: string
  appColor?: string
  /** The tool call the frame came from, when one did. */
  eventId?: string
  /** The macOS app whose window is polled (`/cockpit watch <App>`). */
  watch?: string
  /** JPEG/PNG base64 small enough for an Svg (desktop, vscode, mobile). */
  b64?: string
  mime?: string
  width?: number
  height?: number
  /** A PNG file the terminal's Image reads itself. */
  pngPath?: string
  generation: number
  at?: number
  error?: string
  isBusy?: boolean
  /** Live is on and its last look found no simulator or emulator: it keeps looking. */
  isWaiting?: boolean
}

/** Where a frame comes from. */
export type CockpitFrameSource = 'ios' | 'android' | 'tool' | 'file' | 'window'

/**
 * One screen among several, each kept under its own key so a simulator, an
 * emulator, a window and a tool's picture show side by side:
 * `ios:<udid>`, `android:<serial>`, `window:<app>`,
 * `tool:<mcp server>[:<tabId>]`, `file:<path>`, `read:<path>`.
 */
export type CockpitFrame = {
  key: string
  source: CockpitFrameSource
  label: string
  /** JPEG/PNG base64 small enough for an Svg. */
  b64: string
  mime: string
  width?: number
  height?: number
  /** When it was captured. */
  at: number
  /** The tool call it came from, when one did. */
  eventId?: string
  /** The app it shows, when the registry knows it: its name and colour. */
  app?: string
  appColor?: string
  /** Captured because the person asked (Capture screen), with no call behind it. */
  isManual?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      feed: CockpitFeedRef[]
      event: StateFamily<CockpitEvent | null>
      files: CockpitFile[]
      changes: StateFamily<CockpitChange[] | null>
      agents: CockpitAgent[]
      workflows: CockpitWorkflow[]
      stats: CockpitStats
      ui: CockpitUi
      screen: CockpitScreen
      /** The frames by key; a removed one is null. */
      frame: StateFamily<CockpitFrame | null>
      /** The keys of the frames kept, newest first, at most 6. */
      frameKeys: string[]
      now: number
      surface: string
      tmp: string
    }
  }
}
