/**
 * Single source of truth for every user-facing setting: key, type, default,
 * constraints, description. The CLI listing, the REPL's `:settings` command,
 * the daemon's `settings` op and the GUI form all render from this table —
 * a new setting is one entry here plus the consumer that reads it.
 *
 * A key only enters the table once its consumer exists: a setting that does
 * nothing is a broken promise in every listing.
 */

export type SettingValue = boolean | number | string;

interface SettingBase {
  /** Dotted path, `<surface>.<name>` — the surface is the section in the UIs. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /**
   * false: takes effect at the next shell/process start. The UIs say so
   * instead of half-applying (plugin keybindings are the classic case:
   * bound at load).
   */
  readonly appliesLive: boolean;
}

export type SettingSpec =
  | (SettingBase & { readonly type: 'bool'; readonly default: boolean })
  | (SettingBase & { readonly type: 'int'; readonly default: number; readonly min: number; readonly max: number })
  | (SettingBase & { readonly type: 'enum'; readonly default: string; readonly options: readonly string[] })
  | (SettingBase & { readonly type: 'string'; readonly default: string })
  | (SettingBase & { readonly type: 'hotkey'; readonly default: string });

export const SETTINGS: readonly SettingSpec[] = [
  {
    key: 'repl.dropdownRows',
    type: 'int',
    default: 5,
    min: 1,
    max: 20,
    label: 'Dropdown rows',
    description: 'How many candidate rows the REPL dropdown shows at once.',
    appliesLive: true,
  },
  {
    key: 'repl.footer',
    type: 'bool',
    default: true,
    label: 'Footer legend',
    description: 'The key-hint line under the REPL prompt.',
    appliesLive: true,
  },
];

const BY_KEY = new Map(SETTINGS.map((spec) => [spec.key, spec]));

export function specFor(key: string): SettingSpec | undefined {
  return BY_KEY.get(key);
}

export type Validated = { readonly ok: true; readonly value: SettingValue } | { readonly ok: false; readonly error: string };

/** A JSON value (from the file or the wire) against its spec. */
export function validateValue(spec: SettingSpec, value: unknown): Validated {
  switch (spec.type) {
    case 'bool':
      if (typeof value === 'boolean') return { ok: true, value };
      return { ok: false, error: 'expected true or false' };
    case 'int':
      if (typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max) {
        return { ok: true, value };
      }
      return { ok: false, error: `expected an integer between ${spec.min} and ${spec.max}` };
    case 'enum':
      if (typeof value === 'string' && spec.options.includes(value)) return { ok: true, value };
      return { ok: false, error: `expected one of: ${spec.options.join(', ')}` };
    case 'string':
    case 'hotkey':
      if (typeof value === 'string') return { ok: true, value };
      return { ok: false, error: 'expected a string' };
  }
}

/**
 * User-typed text ("8", "true") from the CLI or `:settings` into a typed
 * value. Deliberately strict — the completion machinery offers the valid
 * spellings, so there is nothing to guess.
 */
export function parseInput(spec: SettingSpec, raw: string): Validated {
  switch (spec.type) {
    case 'bool':
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, error: 'expected true or false' };
    case 'int':
      if (/^-?\d+$/.test(raw)) return validateValue(spec, Number(raw));
      return { ok: false, error: `expected an integer between ${spec.min} and ${spec.max}` };
    case 'enum':
    case 'string':
    case 'hotkey':
      return validateValue(spec, raw);
  }
}
