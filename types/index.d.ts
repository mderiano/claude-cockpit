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
}

export type CockpitScreen = {
  /** Polling the emulator while the Screen tab shows. */
  isLive: boolean
  source: 'none' | 'ios' | 'android' | 'tool'
  label: string
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
      now: number
      surface: string
      tmp: string
    }
  }
}
