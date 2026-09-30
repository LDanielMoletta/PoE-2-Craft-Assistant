/**
 * Normalizacao e validacao de combinacoes de teclas.
 *
 * Fica em um modulo proprio (sem dependencias de config, UI ou SO) porque
 * tanto a camada de configuracao quanto a de overlay precisam das mesmas
 * regras — e um ciclo entre elas seria impossivel de manter.
 */

export type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta';

export interface Modifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface KeyPress {
  readonly key: string;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface ParsedSequence {
  /** Modificadores na ordem canonica. */
  readonly modifiers: readonly ModifierName[];
  /** Teclas nao-modificadoras, em caixa alta. */
  readonly keys: readonly string[];
  /** Forma canonica: `alt+shift+e`. */
  readonly normalized: string;
}

const MODIFIER_ALIASES: Readonly<Record<string, ModifierName>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta',
  windows: 'meta',
};

/** Ordem canonica dos modificadores. */
const MODIFIER_ORDER: readonly ModifierName[] = ['ctrl', 'alt', 'shift', 'meta'];

const FUNCTION_KEY_RE = /^F([1-9]|1\d|2[0-4])$/;
const PUNCTUATION_KEYS: ReadonlySet<string> = new Set([
  '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/',
]);

/**
 * Atalhos reservados pelo sistema operacional. Registrar qualquer um destes
 * globalmente falha em silencio no Windows ou sequestra uma funcao critica,
 * entao a config nunca deve aceitar.
 *
 * Escritos na forma que o usuario digita, e canonicalizados logo abaixo: a
 * comparacao acontece contra `parsed.normalized`, e um literal aqui que use
 * um apelido (`alt+esc` vira `alt+escape`) nunca casaria e o atalho reservado
 * passaria a ser aceito.
 */
const RESERVED_SEQUENCES_RAW: readonly string[] = [
  'ctrl+alt+delete',
  'ctrl+alt+del',
  'alt+tab',
  'alt+esc',
  'alt+f4',
  'ctrl+shift+esc',
  'meta+l',
  'meta+d',
  'meta+e',
  'meta+r',
  'meta+i',
  'meta+s',
  'meta+q',
  'meta+x',
  'meta+tab',
  'meta+space',
  'meta+arrowup',
  'meta+arrowdown',
  'meta+arrowleft',
  'meta+arrowright',
];

export const RESERVED_SEQUENCES: ReadonlySet<string> = new Set(
  RESERVED_SEQUENCES_RAW.map((sequence) => normalizeSequence(sequence)).filter((sequence) => sequence.length > 0),
);


/** Erros possiveis na validacao de um atalho. */
export type HotkeyErrorCode =
  | 'empty'
  | 'unknown-key'
  | 'too-many-keys'
  | 'modifier-only'
  | 'no-modifier'
  | 'reserved'
  | 'conflict';

export interface HotkeyValidation {
  readonly valid: boolean;
  readonly code: HotkeyErrorCode | null;
  readonly message: string;
  /** Forma canonica, preenchida mesmo quando invalida. */
  readonly normalized: string;
}

const OK = (normalized: string): HotkeyValidation => ({
  valid: true,
  code: null,
  message: 'Atalho valido.',
  normalized,
});

const FAIL = (
  normalized: string,
  code: HotkeyErrorCode,
  message: string,
): HotkeyValidation => ({ valid: false, code, message, normalized });

/** Aceita "F1".."F24" como tecla valida. */
function isFunctionKey(key: string): boolean {
  return FUNCTION_KEY_RE.test(key);
}

/** Nomes longos de tecla especial aceitos como uma "tecla" do atalho. */
const SPECIAL_KEY_NAMES: ReadonlySet<string> = new Set([
  'escape',
  'enter',
  'space',
  'tab',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]);

/** Aceita letras, digitos, F-keys, teclas especiais e pontuacao. */
function isKnownKey(key: string): boolean {
  if (key.length === 1) return /^[a-z0-9]$/.test(key) || PUNCTUATION_KEYS.has(key);
  return isFunctionKey(key.toUpperCase()) || SPECIAL_KEY_NAMES.has(key);
}

/**
 * Converte texto livre ("shift + ALT + E", "cmd+e") na forma canonica.
 * Retorna string vazia quando nao da para interpretar.
 */
export function parseSequence(sequence: string): ParsedSequence | null {
  const raw = sequence
    .replace(/\s+/g, '')
    .replace(/[–—−]/g, '-')
    .split(/[+_]/)
    .filter((part) => part.length > 0);

  if (raw.length === 0) return null;

  const modifiers = new Set<ModifierName>();
  const keys: string[] = [];

  for (const part of raw) {
    const lower = part.toLowerCase();
    const modifier = MODIFIER_ALIASES[lower];
    if (modifier !== undefined) {
      modifiers.add(modifier);
      continue;
    }
    // Nomes longos de teclas especiais aceitos por alguns gerenciadores.
    const special: Readonly<Record<string, string>> = {
      escape: 'escape',
      esc: 'escape',
      enter: 'enter',
      return: 'enter',
      space: 'space',
      spacebar: 'space',
      tab: 'tab',
      backspace: 'backspace',
      delete: 'delete',
      insert: 'insert',
      home: 'home',
      end: 'end',
      pageup: 'pageup',
      pagedown: 'pagedown',
      up: 'arrowup',
      down: 'arrowdown',
      left: 'arrowleft',
      right: 'arrowright',
    };
    const mapped = special[lower] ?? lower;
    // Forma canonica e minuscula: `Alt+E` e `alt+e` sao o mesmo atalho.
    keys.push(mapped);
  }

  const orderedModifiers = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  const uniqueKeys = [...new Set(keys)];
  return {
    modifiers: orderedModifiers,
    keys: uniqueKeys,
    normalized: [...orderedModifiers, ...uniqueKeys].join('+'),
  };
}

/** Forma canonica (`alt+shift+e`) ou string vazia se irreconhecivel. */
export function normalizeSequence(sequence: string): string {
  return parseSequence(sequence)?.normalized ?? '';
}

/** Forma legivel (`Alt+Shift+E`) para exibir na UI. */
export function formatSequence(sequence: string): string {
  const parsed = parseSequence(sequence);
  if (parsed === null) return sequence;

  const label: Readonly<Record<string, string>> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Win',
  };
  const keyLabel: Readonly<Record<string, string>> = {
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    escape: 'Esc',
    enter: 'Enter',
    backspace: 'Backspace',
    delete: 'Del',
    insert: 'Ins',
    space: 'Space',
    tab: 'Tab',
  };

  // Letras e digitos aparecem em caixa alta na UI; a forma canonica continua
  // minuscula para comparar strings.
  const pretty = (key: string): string => {
    const named = keyLabel[key];
    if (named !== undefined) return named;
    if (key.length === 1) return key.toUpperCase();
    if (isFunctionKey(key.toUpperCase())) return key.toUpperCase();
    return key;
  };

  return [...parsed.modifiers.map((m) => label[m] ?? m), ...parsed.keys.map(pretty)].join('+');
}

/** Sequencia correspondente a um evento de tecla. */
export function sequenceFromPress(press: KeyPress): string {
  return parseSequence(
    [press.ctrl ? 'ctrl' : '', press.alt ? 'alt' : '', press.shift ? 'shift' : '', press.meta ? 'meta' : '', press.key]
      .filter(Boolean)
      .join('+'),
  )?.normalized ?? '';
}

export interface ValidateHotkeyOptions {
  /** Sequencias ja em uso na propria aplicacao. */
  readonly taken?: Iterable<string>;
  /** Validar contra atalhos reservados do SO (ligar em atalhos GLOBAIS). */
  readonly rejectReserved?: boolean;
  /** A sequencia sera registrada como hotkey global (exige modificador). */
  readonly asGlobal?: boolean;
}

/**
 * Valida uma combinacao de teclas.
 *
 * `asGlobal: true` exige modificador (senão sequestramos digitação normal),
 * rejeita atalhos do SO e conflitos internos.
 */
export function validateHotkey(
  sequence: string,
  options: ValidateHotkeyOptions = {},
): HotkeyValidation {
  const trimmed = sequence.trim();
  if (trimmed.length === 0) return FAIL('', 'empty', 'Nenhuma tecla foi capturada.');

  const parsed = parseSequence(trimmed);
  if (parsed === null || parsed.normalized.length === 0) {
    return FAIL('', 'unknown-key', `"${trimmed}" nao e uma combinacao reconhecida.`);
  }

  const { normalized, modifiers, keys } = parsed;

  if (keys.length === 0) {
    return FAIL(normalized, 'modifier-only', 'So modificadores foram pressionados. Inclua uma tecla.');
  }
  if (keys.length > 3) {
    return FAIL(normalized, 'too-many-keys', 'Use no maximo 3 teclas por atalho.');
  }

  const unknown = keys.find((key) => !isKnownKey(key));
  if (unknown !== undefined) {
    return FAIL(normalized, 'unknown-key', `Tecla "${unknown}" nao suportada.`);
  }

  if (options.asGlobal === true) {
    if (modifiers.length === 0) {
      return FAIL(
        normalized,
        'no-modifier',
        'Um atalho global precisa de Ctrl, Alt, Shift ou Win junto de uma tecla.',
      );
    }
    if (RESERVED_SEQUENCES.has(normalized)) {
      return FAIL(normalized, 'reserved', `"${formatSequence(normalized)}" e reservado pelo sistema.`);
    }
  }

  for (const used of options.taken ?? []) {
    if (normalizeSequence(used) === normalized) {
      return FAIL(normalized, 'conflict', `"${formatSequence(normalized)}" ja esta em uso.`);
    }
  }

  return OK(normalized);
}

/**
 * Valida um conjunto inteiro de atalhos de uma vez, detectando conflitos
 * internos (dois accruos com a mesma combinacao).
 */
export function validateHotkeySet(
  entries: Readonly<Record<string, string>>,
  options: Omit<ValidateHotkeyOptions, 'taken'> = {},
): ReadonlyMap<string, HotkeyValidation> {
  const results = new Map<string, HotkeyValidation>();
  const takenSoFar: string[] = [];

  for (const [name, sequence] of Object.entries(entries)) {
    const result = validateHotkey(sequence, { ...options, taken: takenSoFar });
    results.set(name, result);
    if (result.valid) takenSoFar.push(result.normalized);
  }

  return results;
}