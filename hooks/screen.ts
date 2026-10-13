// Cockpit: the pure half of the live screen: device listings, image headers,
// screenshots found in tool results. The capture itself (processes, files)
// runs in register.tsx, where `$` lives.

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

/** The first booted simulator of `simctl list devices booted -j`, iOS first. */
export const parseSimctl = (stdout: string): Device | undefined => {
  let parsed: { devices?: Record<string, { udid?: string; name?: string; state?: string }[]> }
  try {
    parsed = JSON.parse(stdout) as typeof parsed
  } catch {
    return undefined
  }
  const runtimes = Object.entries(parsed.devices ?? {}).filter(([runtime]) => SCREEN_RUNTIME_RE.test(runtime))
  runtimes.sort(([x], [y]) => Number(/iOS/.test(y)) - Number(/iOS/.test(x)))
  for (const [, list] of runtimes) {
    for (const d of list) {
      if (d.state === 'Booted' && typeof d.udid === 'string') return { kind: 'ios', udid: d.udid, name: d.name ?? 'Simulator' }
    }
  }
  return undefined
}

/** The first ready device of `adb devices`. */
export const parseAdb = (stdout: string, adb: string): Device | undefined => {
  const line = stdout
    .split('\n')
    .slice(1)
    .map(one => one.trim().split(/\s+/))
    .find(parts => parts[1] === 'device')
  return line?.[0] !== undefined ? { kind: 'android', serial: line[0], adb } : undefined
}

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
