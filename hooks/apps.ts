// Cockpit's app registry: which app a tool call or a command is working with
// (Blender, Godot, Unity, a browser, a simulator...), what to call it, its
// colour and glyph, how to look at its screen. Pure data and functions: the
// hooks in register.tsx read the user's config files and hand them here.

/** One app Cockpit recognises. */
export type AppDef = {
  id: string
  name: string
  /** Hex colour of its badge. */
  color: string
  /** One character or a short text, drawn in its icon tile. */
  glyph: string
  match: {
    /** Tested on the server part of `mcp__<server>__<tool>`. */
    mcp?: RegExp
    /** Tested on a Bash command. */
    command?: RegExp
    /** File extensions, lower case with their dot (`.blend`). */
    files?: readonly string[]
  }
  /**
   * An MCP tool of the same server that returns a picture of the app: a name
   * (`get_viewport_screenshot`) or a pattern on the tool names of that server.
   */
  screenshot?: { tool: string | RegExp; args?: Record<string, unknown> }
  /** macOS app name (window owner) whose window Cockpit may capture. */
  window?: string
}

/** What the drawings need of an app: no patterns, JSON-safe. */
export type AppBadge = { id: string; name: string; color: string; glyph: string }

export const badgeOf = (app: AppDef): AppBadge => ({ id: app.id, name: app.name, color: app.color, glyph: app.glyph })

/** Built-in apps; the user's config adds to them or replaces one by id. */
export const BUILTIN_APPS: readonly AppDef[] = [
  {
    id: 'unity',
    name: 'Unity',
    color: '#5b6b7f',
    glyph: 'U',
    match: {
      mcp: /unity/i,
      command: /(^|[\s/"'])Unity(\.app)?(["']?\s[^\n]*)?\s-(batchmode|projectPath|executeMethod|runTests|buildTarget)\b/,
      files: ['.unity', '.prefab', '.asset'],
    },
  },
  {
    id: 'unreal',
    name: 'Unreal Engine',
    color: '#7c6cf2',
    glyph: 'UE',
    match: {
      mcp: /unreal/i,
      command: /(^|[\s/"'])(UnrealEditor(-Cmd)?|UE4Editor(-Cmd)?|RunUAT(\.sh|\.bat|\.command)?|UnrealBuildTool)(\.exe)?(["']|\s|$)/,
      files: ['.uasset', '.umap', '.uproject'],
    },
  },
  {
    id: 'godot',
    name: 'Godot',
    color: '#478cbf',
    glyph: 'G',
    match: {
      mcp: /godot/i,
      command: /(^|[\s/"'])([Gg]odot4?|Godot_v[\w.-]+)(\.app|\.exe)?(["']|\s|$)/,
      files: ['.tscn', '.tres', '.gd', '.godot'],
    },
  },
  {
    id: 'blender',
    name: 'Blender',
    color: '#e87d0d',
    glyph: 'B',
    match: { mcp: /blender/i, command: /(^|[\s/"'])[Bb]lender(\.app)?(["']|\s|$)/, files: ['.blend'] },
    screenshot: { tool: 'get_viewport_screenshot', args: { max_size: 800 } },
  },
  {
    id: 'freecad',
    name: 'FreeCAD',
    color: '#d6262d',
    glyph: 'F',
    match: { mcp: /freecad/i, command: /(^|[\s/"'])(freecadcmd|FreeCADCmd|FreeCAD|freecad)(\.app|\.exe)?(["']|\s|$)/, files: ['.fcstd'] },
  },
  {
    id: 'openscad',
    name: 'OpenSCAD',
    color: '#c99a06',
    glyph: 'S',
    match: { mcp: /openscad/i, command: /(^|[\s/"'])(openscad|OpenSCAD)(\.app|\.exe)?(["']|\s|$)/, files: ['.scad'] },
  },
  {
    id: 'kicad',
    name: 'KiCad',
    color: '#3b5bdb',
    glyph: 'K',
    match: { mcp: /kicad/i, command: /(^|[\s/"'])(kicad-cli|kicad|KiCad)(\.app|\.exe)?(["']|\s|$)/, files: ['.kicad_pcb', '.kicad_sch', '.kicad_pro'] },
  },
  // The screens Cockpit already followed: their screenshots keep their own path.
  { id: 'claude-browser', name: 'Claude Browser', color: '#0d9488', glyph: '◎', match: { mcp: /^Claude_Browser$/ } },
  { id: 'chrome', name: 'Chrome', color: '#0891b2', glyph: '◎', match: { mcp: /claude-in-chrome|chrome/i } },
  { id: 'playwright', name: 'Playwright', color: '#2f9e44', glyph: 'P', match: { mcp: /playwright|puppeteer/i } },
  {
    id: 'ios-simulator',
    name: 'iOS Simulator',
    color: '#2563eb',
    glyph: '▯',
    match: { mcp: /ios_?simulator|ios-simulator|xcode/i, command: /(^|[\s/"'])xcrun\s+simctl\b/ },
  },
  { id: 'android', name: 'Android', color: '#16a34a', glyph: 'A', match: { mcp: /android|emulator/i, command: /(^|[\s/"'])adb(["']|\s|$)/ } },
  { id: 'computer', name: 'Desktop', color: '#64748b', glyph: '▭', match: { mcp: /computer-use/i } },
]

/** Files whose change is shown as an asset (its size), never as a diff. */
export const BINARY_EXT: readonly string[] = [
  '.blend',
  '.fcstd',
  '.uasset',
  '.umap',
  '.fbx',
  '.glb',
  '.stl',
  '.3mf',
  '.usdz',
  '.exr',
  '.psd',
  '.kra',
  '.unitypackage',
  '.pck',
]

export const IMAGE_EXT: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

/** The lower-case extension of a path, with its dot; '' when none. */
export const extOf = (path: string): string => {
  const name = path.split('/').pop() ?? path
  const at = name.lastIndexOf('.')
  return at <= 0 ? '' : name.slice(at).toLowerCase()
}

export const isBinaryAsset = (path: string): boolean => BINARY_EXT.includes(extOf(path))

export const mimeOfPath = (path: string): string | undefined => {
  const ext = extOf(path)
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return undefined
}

// ---------------------------------------------------------------- user config
const MAX_APPS = 60
const MAX_RE = 300

const regexOf = (v: unknown): RegExp | undefined => {
  if (typeof v !== 'string' || v === '' || v.length > MAX_RE) return undefined
  try {
    return new RegExp(v, 'i')
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One app of a config file, or undefined when it is not usable. */
export const appFromJson = (raw: unknown): AppDef | undefined => {
  if (!isRecord(raw)) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : ''
  if (name === '') return undefined
  const id = typeof raw.id === 'string' && /^[\w.-]{1,40}$/.test(raw.id) ? raw.id : name.toLowerCase().replace(/[^\w.-]+/g, '-').slice(0, 40)
  if (id === '' || id === '-') return undefined
  const color = typeof raw.color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.color) ? raw.color : '#64748b'
  const glyph = typeof raw.glyph === 'string' && raw.glyph.trim() !== '' ? [...raw.glyph.trim()].slice(0, 3).join('') : [...name][0]?.toUpperCase() ?? '?'
  const m = isRecord(raw.match) ? raw.match : {}
  // A pattern given but broken makes the whole entry unusable, not half of it.
  if (m.mcp !== undefined && regexOf(m.mcp) === undefined) return undefined
  if (m.command !== undefined && regexOf(m.command) === undefined) return undefined
  const files = Array.isArray(m.files)
    ? m.files.filter((f): f is string => typeof f === 'string' && /^\.[\w.-]{1,20}$/.test(f)).map(f => f.toLowerCase()).slice(0, 20)
    : undefined
  const match: AppDef['match'] = {
    mcp: regexOf(m.mcp),
    command: regexOf(m.command),
    files: files !== undefined && files.length > 0 ? files : undefined,
  }
  const window = typeof raw.window === 'string' && raw.window.trim() !== '' && raw.window.length <= 80 ? raw.window.trim() : undefined
  let screenshot: AppDef['screenshot']
  if (isRecord(raw.screenshot) && typeof raw.screenshot.tool === 'string' && raw.screenshot.tool !== '') {
    const tool = raw.screenshot.tool
    // A plain tool name is taken as such; anything else as a pattern.
    const pattern = /^[\w-]+$/.test(tool) ? tool : regexOf(tool)
    if (pattern !== undefined) screenshot = { tool: pattern, args: isRecord(raw.screenshot.args) ? raw.screenshot.args : undefined }
  }
  if (match.mcp === undefined && match.command === undefined && match.files === undefined && window === undefined) return undefined
  return { id, name, color, glyph, match, screenshot, window }
}

/** The usable apps of a config file's JSON (`{ "apps": [...] }`), and how many were ignored. */
export const appsFromConfig = (json: unknown): { apps: AppDef[]; ignored: number } => {
  if (!isRecord(json) || !Array.isArray(json.apps)) return { apps: [], ignored: 0 }
  const apps: AppDef[] = []
  let ignored = 0
  for (const raw of json.apps.slice(0, MAX_APPS)) {
    const app = appFromJson(raw)
    if (app === undefined) ignored += 1
    else apps.push(app)
  }
  return { apps, ignored: ignored + Math.max(0, json.apps.length - MAX_APPS) }
}

/** Later lists win by id, and come first in matching order. */
export const mergeApps = (...lists: readonly (readonly AppDef[])[]): AppDef[] => {
  const out: AppDef[] = []
  for (const list of lists) {
    for (const app of list) {
      const at = out.findIndex(one => one.id === app.id)
      if (at >= 0) out.splice(at, 1)
      out.unshift(app)
    }
  }
  return out
}

// ---------------------------------------------------------------- matching
/** The server part of `mcp__<server>__<tool>`, or undefined. */
export const mcpServer = (tool: string): string | undefined => {
  if (!tool.startsWith('mcp__')) return undefined
  const rest = tool.slice(5)
  const at = rest.indexOf('__')
  return at < 0 ? rest : rest.slice(0, at)
}

/** The tool part of `mcp__<server>__<tool>`. */
export const mcpToolName = (tool: string): string => {
  const server = mcpServer(tool)
  return server === undefined ? tool : tool.slice(5 + server.length + 2)
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The app a tool call works with, from its tool name and arguments. */
export const appForCall = (apps: readonly AppDef[], tool: string, input: Record<string, unknown>): AppDef | undefined => {
  const server = mcpServer(tool)
  if (server !== undefined) return apps.find(a => a.match.mcp?.test(server) === true)
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (command === '') return undefined
    return apps.find(a => a.match.command?.test(command) === true)
  }
  if (FILE_TOOLS.has(tool)) {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    const ext = extOf(path)
    if (ext === '') return undefined
    return apps.find(a => a.match.files?.includes(ext) === true)
  }
  return undefined
}

/** The app whose window has this name (or whose name it is). */
export const appForWindow = (apps: readonly AppDef[], name: string): AppDef | undefined => {
  const n = name.toLowerCase()
  return apps.find(a => a.window?.toLowerCase() === n) ?? apps.find(a => a.name.toLowerCase() === n)
}

// ---------------------------------------------------------------- titles
/** `export PATH=...` and the like are no export of the app's. */
const stripEnv = (command: string): string => command.replace(/(^|[;&|]\s*)export\s+[A-Za-z_]\w*=\S*/g, '$1')

const KIND_RES: readonly [string, RegExp][] = [
  ['Test', /(^|[\s_-])(test|tests|runtests|pytest)(\b|$)/i],
  ['Export', /(^|[\s-])-?-?export\b|\bexport[-_]\w+|\s-o\s+\S+\.(stl|3mf|obj|step|stp|off|amf|dxf|svg|pdf|gltf|glb|fbx|usdz?|csg|zip|gbr)\b/i],
  ['Render', /\brender\b|--render-(frame|anim)|\s-f\s+-?\d|\s-a(\s|$)|\s-o\s+\S+\.(png|jpe?g|webp|exr|tiff?|gif|bmp)\b/i],
  ['Build', /\bbuild\b|buildcookrun|-buildtarget|\bcook\b/i],
  ['Run', /\brun\b|--play\b|\s-play\b/i],
]

/** "Blender · Render" for an app's command when its kind shows; else undefined. */
export const appCommandTitle = (app: AppDef, command: string): string | undefined => {
  const plain = stripEnv(command)
  for (const [word, re] of KIND_RES) if (re.test(plain)) return `${app.name} · ${word}`
  return undefined
}

// ---------------------------------------------------------------- paths in commands
/** The words of a command, quotes taken off (a rough shell split). */
const wordsOf = (command: string): string[] => {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(command); m !== null; m = re.exec(command)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/**
 * Paths in a command that end with one of `exts`: plain arguments,
 * `--output=x.png`, `-ox.png` is not guessed, redirections `> x.png`.
 * A pattern (`render_####.png`, `*.png`, `$OUT.png`) is skipped. Blender's
 * `//` (beside the .blend file) is resolved against the first .blend named.
 */
export const pathsInCommand = (command: string, exts: readonly string[]): string[] => {
  const words = wordsOf(command)
  const blend = words.find(w => extOf(w) === '.blend')
  const blendDir = blend !== undefined && blend.includes('/') ? blend.slice(0, blend.lastIndexOf('/')) : blend !== undefined ? '.' : undefined
  const out: string[] = []
  for (const raw of words) {
    let w = raw.replace(/^\d?>>?/, '').replace(/[;)&|]+$/, '')
    const eq = w.indexOf('=')
    if (eq >= 0 && w.startsWith('-')) w = w.slice(eq + 1)
    if (w === '' || !exts.includes(extOf(w))) continue
    if (/[#*?$`{}[\]]/.test(w)) continue
    if (w.startsWith('//')) {
      if (blendDir === undefined) continue
      w = `${blendDir}/${w.slice(2)}`
    }
    if (!out.includes(w)) out.push(w)
  }
  return out.slice(0, 8)
}

/** The folder a command runs in: a leading `cd <dir> &&` moves it. */
export const commandDir = (command: string, cwd: string, home: string): string => {
  const m = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/.exec(command)
  if (m === null) return cwd
  return resolvePath((m[1] ?? '').replace(/^["']|["']$/g, ''), cwd, home)
}

/** An absolute path for `p` as given in a command run in `cwd`. */
export const resolvePath = (p: string, cwd: string, home: string): string => {
  let abs = p
  if (p === '~' || p.startsWith('~/')) abs = `${home}${p.slice(1)}`
  else if (!p.startsWith('/')) abs = `${cwd.replace(/\/$/, '')}/${p}`
  const parts: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// ---------------------------------------------------------------- screenshots
/** Tool names on an app's MCP server that look like a screenshot. */
const SHOT_RE = /screenshot|screen_?shot|viewport_?(image|capture|shot|render)|capture_?(screen|viewport|view|window)/i

/**
 * The screenshot tool of the server `tool` belongs to, among the tools the
 * session has; undefined when the call is that tool itself or there is none.
 */
export const appScreenshotTool = (app: AppDef, tool: string, available: readonly string[]): string | undefined => {
  const server = mcpServer(tool)
  if (server === undefined) return undefined
  const prefix = `mcp__${server}__`
  const own = available.filter(name => name.startsWith(prefix))
  const want = app.screenshot?.tool
  let found: string | undefined
  if (typeof want === 'string') found = own.find(name => name === `${prefix}${want}`)
  else if (want instanceof RegExp) found = own.find(name => want.test(name.slice(prefix.length)))
  found ??= own.find(name => SHOT_RE.test(name.slice(prefix.length)))
  return found === tool ? undefined : found
}

/** Whether this call is itself a look at the screen (no follow-up needed). */
export const isShotTool = (tool: string): boolean => SHOT_RE.test(mcpToolName(tool))

// ---------------------------------------------------------------- window capture
/**
 * JXA run by `osascript -l JavaScript -e <this> <app name>`: the largest
 * on-screen window (layer 0) the app owns, and how many windows had a
 * title (none: the process may not see titles, i.e. no Screen Recording).
 */
export const WINDOW_JXA = [
  'function run(argv){',
  'ObjC.import("CoreGraphics");',
  'var want=String(argv[0]||"").toLowerCase();',
  'var list=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly,0)))||[];',
  'var best=null,area=0,named=0;',
  'for(var i=0;i<list.length;i++){var w=list[i];if(w.kCGWindowName)named++;',
  'if((w.kCGWindowLayer||0)!==0)continue;',
  'if(String(w.kCGWindowOwnerName||"").toLowerCase()!==want)continue;',
  'var b=w.kCGWindowBounds||{};var a=(b.Width||0)*(b.Height||0);',
  'if(a>area){area=a;best=w}}',
  'return JSON.stringify({id:best?best.kCGWindowNumber:0,width:best?best.kCGWindowBounds.Width:0,height:best?best.kCGWindowBounds.Height:0,title:best?String(best.kCGWindowName||""):"",named:named,count:list.length})}',
].join('')

export type WindowInfo = { id: number; width: number; height: number; title: string; named: number; count: number }

export const parseWindowInfo = (stdout: string): WindowInfo | undefined => {
  try {
    const v = JSON.parse(stdout.trim()) as Partial<WindowInfo>
    const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    return { id: Math.trunc(n(v.id)), width: n(v.width), height: n(v.height), title: typeof v.title === 'string' ? v.title : '', named: n(v.named), count: n(v.count) }
  } catch {
    return undefined
  }
}

export const SCREEN_RECORDING_HELP =
  'Window capture needs Screen Recording permission for Claude (System Settings › Privacy & Security › Screen Recording)'
