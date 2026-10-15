// Cockpit: the pure half of the live screen: device listings, image headers,
// images found in tool results (any tool's). The capture itself (processes,
// files) runs in register.tsx, where `$` lives.

export const firstErrorLine = (text: string): string =>
  (text.split('\n').find(line => line.trim() !== '' && !/^Note:/.test(line)) ?? '').trim().slice(0, 160)

/**
 * Why a `sips` run made no picture, or undefined when it did: it exits 0 on
 * an input it cannot read, saying so on stderr, and leaves the output as it was.
 */
export const sipsError = (r: { exitCode: number; stdout: string; stderr: string }): string | undefined => {
  const said = /^(Warning|Error)\b/m.test(r.stderr)
  if (r.exitCode === 0 && !said) return undefined
  return firstErrorLine(r.stderr || r.stdout) || `sips failed (${r.exitCode})`
}

export type Device = { kind: 'ios'; udid: string; name: string } | { kind: 'android'; serial: string; adb: string }

/** Simulators whose screen `simctl io screenshot` reads (a tvOS one may hang on it). */
const SCREEN_RUNTIME_RE = /iOS|watchOS|xrOS|visionOS/

/**
 * Every booted simulator of `simctl list devices booted -j` whose screen can
 * be read, iOS first, at most `max`; undefined when the listing is no JSON.
 */
export const parseSimctlAll = (stdout: string, max = 4): Device[] | undefined => {
  let parsed: { devices?: Record<string, { udid?: string; name?: string; state?: string }[]> }
  try {
    parsed = JSON.parse(stdout) as typeof parsed
  } catch {
    return undefined
  }
  const runtimes = Object.entries(parsed.devices ?? {}).filter(([runtime]) => SCREEN_RUNTIME_RE.test(runtime))
  runtimes.sort(([x], [y]) => Number(/iOS/.test(y)) - Number(/iOS/.test(x)))
  const out: Device[] = []
  for (const [, list] of runtimes) {
    for (const d of Array.isArray(list) ? list : []) {
      if (d.state === 'Booted' && typeof d.udid === 'string' && !out.some(one => one.kind === 'ios' && one.udid === d.udid))
        out.push({ kind: 'ios', udid: d.udid, name: d.name ?? 'Simulator' })
    }
  }
  return out.slice(0, max)
}

/** The first booted simulator of `simctl list devices booted -j`, iOS first. */
export const parseSimctl = (stdout: string): Device | undefined => parseSimctlAll(stdout, 1)?.[0]

/** Every ready device of `adb devices`, at most `max`. */
export const parseAdbAll = (stdout: string, adb: string, max = 4): Device[] =>
  stdout
    .split('\n')
    .slice(1)
    .map(one => one.trim().split(/\s+/))
    .filter(parts => parts[1] === 'device' && (parts[0] ?? '') !== '')
    .slice(0, max)
    .map(parts => ({ kind: 'android' as const, serial: parts[0] ?? '', adb }))

/** The first ready device of `adb devices`. */
export const parseAdb = (stdout: string, adb: string): Device | undefined => parseAdbAll(stdout, adb, 1)[0]

/** The frame key of a device: `ios:<udid>`, `android:<serial>`. */
export const deviceKey = (d: Device): string => (d.kind === 'ios' ? `ios:${d.udid}` : `android:${d.serial}`)

/** What a device's frame is called. */
export const deviceLabel = (d: Device): string => (d.kind === 'ios' ? d.name : `Android ${d.serial}`)

/** A part of a file name made of safe characters only (a serial may hold `:`). */
export const safeName = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64)

// ---------------------------------------------------------------- image size
const bytesOf = (b64: string, max: number): Uint8Array => {
  const cut = b64.slice(0, Math.ceil(max / 3) * 4).replace(/=+$/, '')
  const pad = cut.length % 4 === 0 ? cut : cut + '='.repeat(4 - (cut.length % 4))
  let bin = ''
  try {
    bin = atob(pad)
  } catch {
    return new Uint8Array(0)
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** Width and height of a PNG or JPEG held as base64, read from its header. */
export const imageSize = (b64: string): { width: number; height: number } | undefined => {
  const head = bytesOf(b64, 32)
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50) {
    const width = ((head[16] ?? 0) << 24) | ((head[17] ?? 0) << 16) | ((head[18] ?? 0) << 8) | (head[19] ?? 0)
    const height = ((head[20] ?? 0) << 24) | ((head[21] ?? 0) << 16) | ((head[22] ?? 0) << 8) | (head[23] ?? 0)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
    const bytes = bytesOf(b64, 256 * 1024)
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = bytes[i + 1] ?? 0
      const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0)
        const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0)
        return width > 0 && height > 0 ? { width, height } : undefined
      }
      i += 2 + len
    }
  }
  return undefined
}

/** The image blocks of a row's content (tool_result blocks searched too). */
export const findImages = (content: readonly unknown[]): { data: string; mime: string; toolUseId?: string }[] => {
  const out: { data: string; mime: string; toolUseId?: string }[] = []
  const visit = (block: unknown, toolUseId?: string) => {
    if (typeof block !== 'object' || block === null) return
    const b = block as { type?: unknown; source?: unknown; content?: unknown; tool_use_id?: unknown }
    if (b.type === 'image' && typeof b.source === 'object' && b.source !== null) {
      const s = b.source as { type?: unknown; data?: unknown; media_type?: unknown }
      if (s.type === 'base64' && typeof s.data === 'string' && s.data.length > 0) {
        out.push({ data: s.data, mime: typeof s.media_type === 'string' ? s.media_type : 'image/png', toolUseId })
      }
      return
    }
    if (b.type === 'tool_result' && Array.isArray(b.content)) {
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined
      for (const inner of b.content) visit(inner, id)
    }
  }
  for (const block of content) visit(block)
  return out
}

/**
 * Images anywhere in a tool's result record, in either spelling: the
 * Messages API's (`source.data`) or MCP's (`data` + `mimeType`).
 */
export const deepImages = (value: unknown, depth = 0): { data: string; mime: string }[] => {
  if (depth > 6 || typeof value !== 'object' || value === null) return []
  if (Array.isArray(value)) return value.flatMap(v => deepImages(v, depth + 1))
  const b = value as { type?: unknown; data?: unknown; mimeType?: unknown; source?: unknown; file?: unknown }
  if (b.type === 'image') {
    if (typeof b.data === 'string' && b.data.length > 0)
      return [{ data: b.data, mime: typeof b.mimeType === 'string' ? b.mimeType : 'image/png' }]
    // The built-in Read of an image file: `{ type: 'image', file: { base64, type } }`.
    if (typeof b.file === 'object' && b.file !== null) {
      const f = b.file as { base64?: unknown; type?: unknown }
      if (typeof f.base64 === 'string' && f.base64.length > 0)
        return [{ data: f.base64, mime: typeof f.type === 'string' ? f.type : 'image/png' }]
    }
    if (typeof b.source === 'object' && b.source !== null) {
      const s = b.source as { data?: unknown; media_type?: unknown }
      if (typeof s.data === 'string' && s.data.length > 0)
        return [{ data: s.data, mime: typeof s.media_type === 'string' ? s.media_type : 'image/png' }]
    }
  }
  return Object.values(value as Record<string, unknown>).flatMap(v => deepImages(v, depth + 1))
}
