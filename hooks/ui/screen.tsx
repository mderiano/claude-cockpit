// Cockpit: the live screen (simulator, emulator, an app's window, or the last
// image a tool returned or a command wrote).
import type { RenderElement } from 'claude-code'

import type { CockpitScreen } from '../../types'
import { CAT_COLOR, fmtAgo } from '../model'
import { chip, empty } from './kit'
import type { Kit } from './kit'

/** The frame as an SVG embedding the JPEG/PNG, with rounded device corners. */
export const frameSvg = (s: CockpitScreen): { source: string; width: number; height: number } | undefined => {
  if (s.b64 === undefined) return undefined
  const w = s.width ?? 1280
  const ht = s.height ?? 800
  const r = Math.round(Math.min(w, ht) * 0.04)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}">` +
    `<defs><clipPath id="c"><rect width="${w}" height="${ht}" rx="${r}" ry="${r}"/></clipPath></defs>` +
    `<rect width="${w}" height="${ht}" rx="${r}" ry="${r}" fill="#0b1020"/>` +
    `<image href="data:${s.mime ?? 'image/jpeg'};base64,${s.b64}" x="0" y="0" width="${w}" height="${ht}" clip-path="url(#c)" preserveAspectRatio="xMidYMid meet"/>` +
    `</svg>`
  return { source, width: w, height: ht }
}

const SOURCE_LABEL: Record<CockpitScreen['source'], string> = {
  none: 'no source',
  ios: 'iOS Simulator',
  android: 'Android emulator',
  tool: 'Tool screenshot',
  file: 'Image file',
  window: 'Window',
}

/** The chip's words: the app when the registry knows it, else the source. */
const sourceChip = (s: CockpitScreen): string => (s.app !== undefined && s.app !== '' ? s.app : SOURCE_LABEL[s.source])
const chipColor = (s: CockpitScreen): string =>
  s.appColor !== undefined && /^#[0-9a-f]{6}$/i.test(s.appColor) ? s.appColor : CAT_COLOR.browser

/** Rows above the frame: header, stats, tabs, toolbar, status, margins. */
const CHROME_ROWS = 14
/** Approximate pixels per cell on the Svg surfaces. */
const CELL_W = 7.5
const CELL_H = 19

export const screenView = (k: Kit, s: CockpitScreen): RenderElement => {
  const { Box, Button, Text, Svg, Image } = k
  const toolbar = (
    <Box key="toolbar" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
      <Button
        key="live"
        hotkey="l"
        variant={s.isLive ? 'primary' : 'secondary'}
        onPress={() => k.act.toggleLive()}
      >
        <Text color={s.isLive ? '#ef4444' : undefined}>{s.isLive ? '●' : '○'}</Text> Live
      </Button>
      <Button key="snap" hotkey="s" label="📸 Capture" onPress={() => k.act.capture()} />
    </Box>
  )
  const status = (
    <Box key="status" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
      {chip(k, 'src', sourceChip(s), chipColor(s))}
      {s.label !== '' ? (
        <Text key="label" bold>
          {s.label}
        </Text>
      ) : null}
      {s.at !== undefined ? (
        <Text key="age" dimColor>
          {fmtAgo(s.at, k.now) === 'now' ? 'just now' : `${fmtAgo(s.at, k.now)} ago`}
        </Text>
      ) : null}
      {s.isBusy === true ? (
        <Text key="busy" color="#38bdf8">
          ◐ capturing…
        </Text>
      ) : null}
      {s.isLive ? (
        <Text key="live" color="#ef4444">
          {s.isWaiting === true ? '● live — waiting for a simulator or emulator…' : '● live (2 s)'}
        </Text>
      ) : null}
      {s.watch !== undefined ? (
        <Text key="watch" color="#ef4444">
          {`● watching ${s.watch} (2 s)`}
        </Text>
      ) : null}
    </Box>
  )
  const error =
    s.error !== undefined ? (
      <Text key="error" color="#f97316" wrap="wrap">
        ⚠ {s.error}
      </Text>
    ) : null

  let picture: RenderElement | null = null
  const alt = `${sourceChip(s)}${s.label !== '' ? ` — ${s.label}` : ''}`
  // The frame fits the room the pane has left under its own chrome, so a
  // portrait phone shows whole instead of running below the fold.
  const roomRows = Math.max(6, k.H - CHROME_ROWS)
  if (Svg !== undefined) {
    const frame = frameSvg(s)
    if (frame !== undefined) {
      const maxW = Math.max(160, k.W * CELL_W - 24)
      const maxH = Math.max(120, roomRows * CELL_H)
      const scale = Math.min(1, maxW / frame.width, maxH / frame.height)
      picture = (
        <Svg
          key="frame"
          alt={alt}
          source={frame.source}
          width={Math.round(frame.width * scale)}
          height={Math.round(frame.height * scale)}
        />
      )
    }
  } else if (Image !== undefined) {
    const pw = s.width ?? 16
    const ph = s.height ?? 10
    // A cell is about twice as tall as wide.
    let columns = Math.max(8, Math.min(255, k.W - 2, 72))
    let rows = Math.round(((columns * ph) / pw) * 0.5)
    const maxRows = Math.max(4, Math.min(48, roomRows))
    if (rows > maxRows) {
      rows = maxRows
      columns = Math.max(8, Math.min(columns, Math.round(((rows * pw) / ph) * 2)))
    }
    rows = Math.max(4, rows)
    if (s.pngPath !== undefined) {
      picture = (
        <Image key="frame" source={{ file: s.pngPath, format: 'png', generation: s.generation }} columns={columns} rows={rows} alt={alt} />
      )
    } else if (s.b64 !== undefined && s.mime === 'image/png' && s.b64.length < 2_700_000) {
      picture = <Image key="frame" source={{ png: s.b64 }} columns={columns} rows={rows} alt={alt} />
    } else if (s.b64 !== undefined) {
      picture = (
        <Text key="frame" dimColor italic>
          [{alt}] — image cannot be shown here
        </Text>
      )
    }
  }

  return (
    <Box key="screen" flexDirection="column">
      {toolbar}
      {status}
      {error}
      {picture !== null ? (
        <Box key="pic" flexDirection="column" marginTop={1} alignItems="center">
          {picture}
        </Box>
      ) : (
        empty(k, 'screen-empty', [
          'No image yet 📱',
          'Start an iOS simulator or an Android emulator, then press Capture (or Live), or let Claude take a screenshot or render an image: it will show up here. /cockpit watch <App> follows an app\'s window (macOS).',
        ])
      )}
    </Box>
  )
}
