// Cockpit: what every view gets, and the small pieces they share. Views are
// pure: the hook reads the state and hands them data plus `act`, closures
// made where `$` lives.
import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  ImageProps,
  RenderElement,
  RenderSurface,
  SvgProps,
  TextProps,
} from 'claude-code'

import type { CockpitUi } from '../../types'
import { ON_CHIP } from '../model'
import type { Badge } from '../svg/base'

/** What a press may do; each closure writes state or starts work. */
export type CockpitActions = {
  setUi: (change: (u: CockpitUi) => CockpitUi) => void
  toggleLive: () => void
  capture: () => void
}

export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Code: ElementConstructor<CodeProps>
  /** Desktop, vscode, mobile. */
  Svg?: ElementConstructor<SvgProps>
  /** Terminal only. */
  Image?: ElementConstructor<ImageProps>
  surface: RenderSurface
  /** Cells across the body. */
  W: number
  /** Rows of the pane's room (`scroll.bodyRows`). */
  H: number
  now: number
  cwd: string
  ui: CockpitUi
  act: CockpitActions
  /** The app registry's badges by id (CockpitEvent.app). */
  apps?: ReadonlyMap<string, Badge>
}

/** The badge of the app a call worked with, if the registry knows it. */
export const appBadge = (k: Kit, id: string | undefined): Badge | undefined => (id !== undefined ? k.apps?.get(id) : undefined)

export const setUi = (k: Kit, change: (u: CockpitUi) => CockpitUi): void => k.act.setUi(change)

/** A saturated label: dark text on the colour. */
export const chip = (k: Kit, key: string, text: string, color: string): RenderElement => {
  const { Text } = k
  return (
    <Text key={key} backgroundColor={color} color={ON_CHIP} bold>
      {` ${text} `}
    </Text>
  )
}

/** Pads or cuts to exactly `n` cells (approximate: one cell per code unit). */
export const fit = (text: string, n: number): string => {
  if (n <= 0) return ''
  if (text.length > n) return n === 1 ? '…' : `${text.slice(0, n - 1)}…`
  return text + ' '.repeat(n - text.length)
}

export const sectionTitle = (k: Kit, key: string, text: string, color: string, aside?: string): RenderElement => {
  const { Box, Text } = k
  return (
    <Box key={key} flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text bold color={color}>
        {text}
      </Text>
      {aside !== undefined ? <Text dimColor>{aside}</Text> : null}
    </Box>
  )
}

export const empty = (k: Kit, key: string, lines: readonly string[]): RenderElement => {
  const { Box, Text } = k
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} marginTop={1}>
      {lines.map((line, i) => (
        <Text key={`l${i}`} dimColor={i > 0} italic={i > 0}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
