// Cockpit: the files Claude touched, each with its diff history.
import type { RenderElement } from 'claude-code'

import type { CockpitAgent, CockpitChange, CockpitFile } from '../../types'
import { ADDED, agentHue, basename, CAT_COLOR, clip, dirname, fmtAgo, REMOVED, shortPath } from '../model'
import { agentLabel } from './feed'
import { empty, fit, sectionTitle, setUi } from './kit'
import type { Kit } from './kit'

const MAX_LISTED = 40
const MAX_DIFFS = 5

const bar = (added: number, removed: number, width: number): { plus: string; minus: string } => {
  const total = added + removed
  if (total === 0) return { plus: '', minus: '' }
  const cells = Math.min(width, Math.max(1, Math.ceil(Math.log2(total + 1))))
  const plus = Math.round((added / total) * cells)
  return { plus: '■'.repeat(plus), minus: '■'.repeat(cells - plus) }
}

const fileRow = (k: Kit, f: CockpitFile, isSelected: boolean): RenderElement => {
  const { Button, Text } = k
  const counts = `+${f.added} −${f.removed}`
  const ago = fmtAgo(f.lastAt, k.now)
  const meter = bar(f.added, f.removed, 6)
  const pathWidth = Math.max(10, k.W - 2 - counts.length - 1 - 7 - ago.length - 2 - 4)
  const rel = shortPath(f.path, k.cwd, pathWidth)
  const base = basename(rel)
  const dir = rel.length > base.length ? rel.slice(0, rel.length - base.length) : ''
  const pad = Math.max(0, pathWidth - rel.length)
  return (
    <Button key={`file-${f.path}`} plain onPress={() => setUi(k, u => ({ ...u, file: f.path }))}>
      <Text color={f.isCreated === true ? ADDED : CAT_COLOR.edit} bold>
        {isSelected ? '▸ ' : f.isCreated === true ? '✚ ' : '✎ '}
      </Text>
      <Text dimColor>{dir}</Text>
      <Text bold={isSelected} underline={isSelected}>
        {base}
      </Text>
      <Text>{' '.repeat(pad)} </Text>
      <Text color={ADDED}>+{f.added}</Text>
      <Text> </Text>
      <Text color={REMOVED}>−{f.removed}</Text>
      <Text> </Text>
      <Text color={ADDED}>{meter.plus}</Text>
      <Text color={REMOVED}>{meter.minus}</Text>
      <Text dimColor>
        {' '}
        {f.edits > 1 ? `×${f.edits} ` : ''}
        {ago}
      </Text>
    </Button>
  )
}

const changeBlock = (k: Kit, path: string, c: CockpitChange, agents: readonly CockpitAgent[], i: number): RenderElement => {
  const { Box, Text, Code } = k
  return (
    <Box key={`chg-${c.id}-${i}`} flexDirection="column" marginTop={1}>
      <Text key="h">
        <Text color={CAT_COLOR.edit} bold>
          {c.tool}
        </Text>
        <Text dimColor> · {fmtAgo(c.at, k.now)}</Text>
        {c.agentId !== undefined ? (
          <Text color={agentHue(c.agentId)}> · ⟡{clip(agentLabel(agents, c.agentId), 20)}</Text>
        ) : (
          <Text dimColor> · session</Text>
        )}
        <Text color={ADDED}> +{c.added}</Text>
        <Text color={REMOVED}> −{c.removed}</Text>
        {c.isTruncated === true ? <Text dimColor> · diff tronqué</Text> : ''}
      </Text>
      {c.diff !== '' ? (
        <Code key="d" source={c.diff} format="diff" path={path} wrap="truncate-end" />
      ) : (
        <Text key="d" dimColor italic>
          (aucune ligne changée)
        </Text>
      )}
    </Box>
  )
}

/** The file whose history shows: the one picked, else the latest touched. */
export const selectedFile = (ui: { file: string | null }, files: readonly CockpitFile[]): CockpitFile | undefined =>
  files.find(f => f.path === ui.file) ?? files[0]

export const filesView = (
  k: Kit,
  files: readonly CockpitFile[],
  agents: readonly CockpitAgent[],
  history: readonly CockpitChange[],
): RenderElement => {
  const { Box, Text } = k
  if (files.length === 0) {
    return empty(k, 'files-empty', [
      'Aucun fichier modifié pour l’instant ✍️',
      'Les Edit, Write et NotebookEdit — et les fichiers changés par des commandes — s’afficheront ici avec leur diff.',
    ])
  }
  const selected = selectedFile(k.ui, files)
  const totalAdded = files.reduce((n, f) => n + f.added, 0)
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0)
  const recent = history.slice(-MAX_DIFFS).reverse()
  return (
    <Box key="files" flexDirection="column">
      <Box key="sum" flexDirection="row" columnGap={1} marginTop={1}>
        <Text bold>
          {files.length} fichier{files.length > 1 ? 's' : ''}
        </Text>
        <Text color={ADDED} bold>
          +{totalAdded}
        </Text>
        <Text color={REMOVED} bold>
          −{totalRemoved}
        </Text>
      </Box>
      <Box key="list" flexDirection="column" marginTop={1}>
        {files.slice(0, MAX_LISTED).map(f => fileRow(k, f, f.path === selected?.path))}
        {files.length > MAX_LISTED ? (
          <Text key="more" dimColor>
            … et {files.length - MAX_LISTED} autres
          </Text>
        ) : null}
      </Box>
      {selected !== undefined ? (
        <Box key="sel" flexDirection="column">
          {sectionTitle(
            k,
            'sel-t',
            fit(basename(selected.path), Math.max(8, k.W - 18)).trimEnd(),
            CAT_COLOR.edit,
            `${history.length} changement${history.length > 1 ? 's' : ''}`,
          )}
          <Text key="sel-p" dimColor wrap="truncate-start">
            {dirname(selected.path)}
          </Text>
          {recent.map((c, i) => changeBlock(k, selected.path, c, agents, i))}
          {history.length > MAX_DIFFS ? (
            <Text key="older" dimColor>
              … {history.length - MAX_DIFFS} changements plus anciens
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
