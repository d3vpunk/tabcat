import { useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { SettingSpec } from '../settings/schema.js';
import { clearSetting, readSettings, writeSetting } from '../settings/store.js';
import { MagicPanel } from './app.js';
import { SettingsUiState, handleSettingsUiKey, initialSettingsUiState } from './settings-ui-state.js';

/**
 * The interactive settings editor behind a bare `:settings`. Runs as its own
 * Ink session between two prompts — the same pattern as the meow animation.
 * Every change writes through immediately; the REPL loop re-reads on return.
 */

function controlHint(spec: SettingSpec, editing: boolean): string {
  if (editing) return 'enter: save · esc: cancel';
  switch (spec.type) {
    case 'bool':
      return 'space: toggle';
    case 'int':
      return `←/→: ${spec.min}–${spec.max}`;
    case 'enum':
      return '←/→: next option';
    case 'string':
    case 'hotkey':
      return 'enter: edit';
  }
}

function SettingsEditor({ file }: { file: string }) {
  const { exit } = useApp();
  const [state, setState] = useState<SettingsUiState>(() => initialSettingsUiState(readSettings(file)));

  useInput((input, key) => {
    const outcome = handleSettingsUiKey(state, input, key);
    let next = outcome.state;
    if (outcome.effect !== undefined) {
      try {
        if (outcome.effect.kind === 'write') writeSetting(file, outcome.effect.key, outcome.effect.value);
        else clearSetting(file, outcome.effect.key);
      } catch (error) {
        // The disk refused (broken JSON, permissions): say why and show what
        // the file really holds instead of pretending the change stuck.
        const read = readSettings(file);
        next = {
          ...next,
          values: read.values,
          overridden: read.overridden,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    setState(next);
    if (next.done) exit();
  });

  const keyWidth = Math.max(...state.specs.map((spec) => spec.key.length)) + 2;
  const valueWidth = Math.max(
    8,
    ...state.specs.map((spec) => String(state.values.get(spec.key)).length),
    (state.editing ?? '').length + 1,
  ) + 2;
  const selectedSpec = state.specs[state.selected];

  return (
    <MagicPanel title="settings">
      {state.specs.map((spec, index) => {
        const isSelected = index === state.selected;
        const editingThis = isSelected && state.editing !== null;
        const isDefault = !state.overridden.has(spec.key);
        const value = String(state.values.get(spec.key));
        return (
          <Box key={spec.key}>
            <Text color="cyan">{isSelected ? '› ' : '  '}</Text>
            <Box width={keyWidth}><Text color="cyan" bold={isSelected}>{spec.key}</Text></Box>
            <Box width={valueWidth}>
              {editingThis ? (
                <Text backgroundColor="cyan" color="black">{`${state.editing}▏`}</Text>
              ) : isDefault ? (
                <Text dimColor>{value}</Text>
              ) : (
                <Text color="magenta" bold>{value}</Text>
              )}
            </Box>
            <Text dimColor>
              {spec.description}
              {spec.appliesLive ? '' : ' (next start)'}
            </Text>
          </Box>
        );
      })}
      <Text> </Text>
      {state.error !== null && <Text color="red">{state.error}</Text>}
      <Text dimColor>
        {selectedSpec === undefined ? '' : `${controlHint(selectedSpec, state.editing !== null)} · `}
        ↑/↓: select · ⌫: reset to default · esc: close
      </Text>
    </MagicPanel>
  );
}

export async function showSettingsEditor(file: string): Promise<void> {
  const instance = render(<SettingsEditor file={file} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
