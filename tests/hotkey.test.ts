import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigManager } from '../src/config/index.js';
import { createFileConfigManager } from '../src/config/fileConfigStorage.js';
import { HotkeyManager } from '../src/overlay/hotkeyManager.js';
import { SimulatedHotkeySource, toPress } from '../src/overlay/hotkeySource.js';
import {
  HotkeyRecorder,
  NativeHotkeySource,
  SimulatedKeyboardSource,
} from '../src/overlay/hotkeySource.js';
import {
  RESERVED_SEQUENCES,
  formatSequence,
  normalizeSequence,
  sequenceFromPress,
  validateHotkey,
} from '../src/overlay/hotkeyValidation.js';

let dir: string;

/** Manager com persistencia em disco, como no app real. */
function configManager(): ConfigManager {
  return createFileConfigManager(dir);
}

beforeEach(() => {
  // Um config por teste: senao um setHotkey de um teste contamina o seguinte.
  dir = mkdtempSync(join(tmpdir(), 'poe2-hotkey-'));
});

afterAll(() => {
  // Os diretorios temporarios sao descartados pelo SO.
});

describe('normalizeSequence', () => {
  it('impoe ordem canonica de modificadores', () => {
    expect(normalizeSequence('Shift+Alt+E')).toBe('alt+shift+e');
    expect(normalizeSequence('Meta+Ctrl+K')).toBe('ctrl+meta+k');
  });

  it('aceita alias de modificadores', () => {
    expect(normalizeSequence('Control+C')).toBe('ctrl+c');
    expect(normalizeSequence('Cmd+E')).toBe('meta+e');
  });

  it('deduplica modificadores repetidos', () => {
    expect(normalizeSequence('Alt+Alt+E')).toBe('alt+e');
  });

  it('devolve vazio para entrada irreconhecivel', () => {
    expect(normalizeSequence('   ')).toBe('');
  });
});

describe('formatSequence', () => {
  it('deixa a forma canonica apresentavel', () => {
    expect(formatSequence('alt+shift+e')).toBe('Alt+Shift+E');
    expect(formatSequence('ctrl+c')).toBe('Ctrl+C');
    expect(formatSequence('f5')).toBe('F5');
  });
});

describe('sequenceFromPress', () => {
  it('monta a sequencia a partir das teclas pressionadas', () => {
    expect(sequenceFromPress({ key: 'e', alt: true, ctrl: false, shift: false, meta: false })).toBe(
      'alt+e',
    );
  });
});

describe('validateHotkey', () => {
  it('aceita Alt+E global', () => {
    expect(validateHotkey('Alt+E', { asGlobal: true }).valid).toBe(true);
  });

  it('exige modificador para hotkey global', () => {
    const result = validateHotkey('E', { asGlobal: true });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('no-modifier');
  });

  it('aceita tecla sem modificador quando observada', () => {
    expect(validateHotkey('F4', { asGlobal: false }).valid).toBe(true);
  });

  it('recusa atalho reservado do SO', () => {
    const result = validateHotkey('Ctrl+Alt+Delete', { asGlobal: true });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('reserved');
  });

  it('recusa atalho reservado escrito com apelido de tecla', () => {
    // A comparacao e contra a forma canonica. Sem canonicalizar a lista de
    // reservados, `alt+esc` passava (o canonico e' `alt+escape`) e o atalho
    // acabava registrado no SO, onde falha em silencio.
    for (const reserved of ['Alt+Esc', 'alt+escape', 'Ctrl+Shift+Esc', 'Meta+Q', 'super+q']) {
      expect(validateHotkey(reserved, { asGlobal: true }).code).toBe('reserved');
    }
  });

  it('guarda a lista de reservados na forma canonica', () => {
    for (const sequence of RESERVED_SEQUENCES) {
      expect(normalizeSequence(sequence)).toBe(sequence);
    }
  });

  it('recusa conflito com outro atalho', () => {
    const result = validateHotkey('Alt+E', { taken: ['alt+e'] });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('conflict');
  });

  it('recusa entrada vazia', () => {
    expect(validateHotkey('').code).toBe('empty');
  });

  it('recusa so modificadores', () => {
    expect(validateHotkey('Ctrl+Shift').code).toBe('modifier-only');
  });

  it('recusa teclas demais', () => {
    expect(validateHotkey('Ctrl+Alt+A+B+C+D').code).toBe('too-many-keys');
  });
});

describe('SimulatedHotkeySource', () => {
  it('dispara apenas o handler da combinacao registrada', () => {
    const source = new SimulatedHotkeySource();
    let count = 0;
    source.register('alt+e', () => {
      count += 1;
    });

    expect(source.tap('alt+f')).toBe(false);
    expect(count).toBe(0);

    expect(source.tap('alt+e')).toBe(true);
    expect(count).toBe(1);
  });

  it('para de disparar apos o unregister', () => {
    const source = new SimulatedHotkeySource();
    let count = 0;
    const off = source.register('alt+e', () => {
      count += 1;
    });

    off();
    source.tap('alt+e');

    expect(count).toBe(0);
  });
});

describe('NativeHotkeySource', () => {
  it('falha com instrucao quando o modulo nativo nao esta instalado', async () => {
    // uiohook-napi e opcional: o teste garante que a ausencia dele vira um erro
    // explicito, e nao um crash silencioso do overlay.
    await expect(NativeHotkeySource.create()).rejects.toThrow(/backend de hotkey global/i);
  });

  it('isSupported responde falso sem modulo nativo', async () => {
    expect(await NativeHotkeySource.isSupported()).toBe(false);
  });
});

describe('HotkeyManager', () => {
  function build() {
    const source = new SimulatedHotkeySource();
    const manager = new HotkeyManager({ source, hotkey: 'alt+e' });
    manager.start();
    return { manager, source };
  }

  it('rebind troca a combinacao em runtime', () => {
    const { manager, source } = build();

    manager.rebind('ctrl+j');

    expect(manager.sequence).toBe('ctrl+j');
    expect(source.tap('alt+e')).toBe(false);
    expect(source.tap('ctrl+j')).toBe(true);
  });

  it('nao registra de novo quando o atalho nao mudou', () => {
    const { manager, source } = build();
    const before = source.list().length;

    manager.rebind('Alt+E');

    expect(source.list()).toHaveLength(before);
  });

  it('notifica onRebind com anterior e novo', () => {
    const { manager } = build();
    const seen: [string, string][] = [];
    manager.onRebind((next, previous) => seen.push([next, previous]));

    manager.rebind('ctrl+j');

    expect(seen).toEqual([['ctrl+j', 'alt+e']]);
  });

  it('recusa atalho irreconhecivel no rebind', () => {
    const { manager } = build();
    expect(() => manager.rebind('   ')).toThrow(/invalido/i);
    expect(manager.sequence).toBe('alt+e');
  });

  it('para de escutar apos stop()', () => {
    const { manager, source } = build();
    manager.stop();
    expect(source.tap('alt+e')).toBe(false);
  });
});

describe('HotkeyRecorder', () => {
  it('captura uma combinacao valida digitada ao vivo', () => {
    const keyboard = new SimulatedKeyboardSource();
    const recorder = new HotkeyRecorder(keyboard, { asGlobal: true });
    const states: string[] = [];
    recorder.subscribe((state) => states.push(state.phase));

    recorder.start();
    expect(recorder.isRecording).toBe(true);

    keyboard.press('alt+shift+k');

    expect(recorder.state.phase).toBe('captured');
    expect(recorder.state.sequence).toBe('alt+shift+k');
    expect(recorder.state.validation?.valid).toBe(true);
    expect(states).toContain('recording');
  });

  it('cancela com Esc sem aplicar', () => {
    const keyboard = new SimulatedKeyboardSource();
    const recorder = new HotkeyRecorder(keyboard, { asGlobal: true });

    recorder.start();
    keyboard.press('escape');

    expect(recorder.state.phase).toBe('idle');
    expect(recorder.state.sequence).toBe('');
  });

  it('recusa global sem modificador e mostra o motivo', () => {
    const keyboard = new SimulatedKeyboardSource();
    const recorder = new HotkeyRecorder(keyboard, { asGlobal: true });

    recorder.start();
    keyboard.press('f9');

    expect(recorder.state.phase).toBe('rejected');
    expect(recorder.state.validation?.code).toBe('no-modifier');
  });

  it('recusa conflito com um atalho ja em uso', () => {
    const keyboard = new SimulatedKeyboardSource();
    const recorder = new HotkeyRecorder(keyboard, {
      asGlobal: true,
      taken: () => ['alt+e'],
    });

    recorder.start();
    keyboard.press('alt+e');

    expect(recorder.state.phase).toBe('rejected');
    expect(recorder.state.validation?.code).toBe('conflict');
  });

  it('para de gravar apos capturar', () => {
    const keyboard = new SimulatedKeyboardSource();
    const recorder = new HotkeyRecorder(keyboard, { asGlobal: true });

    recorder.start();
    keyboard.press('alt+e');

    expect(recorder.isRecording).toBe(false);
    expect(keyboard.running).toBe(false);
  });
});

describe('toPress', () => {
  it('interpreta uma sequencia como teclas pressionadas', () => {
    expect(toPress('ctrl+alt+e')).toEqual({
      key: 'e',
      ctrl: true,
      alt: true,
      shift: false,
      meta: false,
    });
  });
});

describe('ConfigManager com HotkeyManager', () => {
  it('reaplica o atalho novo sem reiniciar o gerenciador', async () => {
    const config = configManager();
    await config.load();
    const source = new SimulatedHotkeySource();
    const manager = new HotkeyManager({ source, hotkey: config.getHotkey('triggerOverlay') });
    manager.start();

    const result = await config.setHotkey('triggerOverlay', 'Ctrl+J');
    expect(result.valid).toBe(true);

    manager.rebind(config.getHotkey('triggerOverlay'));
    expect(source.tap('ctrl+j')).toBe(true);
  });

  it('troca de atalho em tempo real ao ouvir hotkey:changed', async () => {
    const config = configManager();
    await config.load();
    const source = new SimulatedHotkeySource();
    const manager = new HotkeyManager({ source, hotkey: config.getHotkey('triggerOverlay') });
    manager.start();

    // Este e o caminho que o host usa: config valida -> evento -> rebind.
    config.on('hotkey:changed', (event) => {
      if (event.action === 'triggerOverlay') manager.rebind(event.next);
    });

    await config.setHotkey('triggerOverlay', 'Alt+K');

    expect(manager.sequence).toBe('alt+k');
    expect(source.tap('alt+e')).toBe(false);
    expect(source.tap('alt+k')).toBe(true);
  });

  it('continua escutando o atalho antigo enquanto ele nao for trocado', async () => {
    const config = configManager();
    await config.load();
    const source = new SimulatedHotkeySource();
    const manager = new HotkeyManager({ source, hotkey: config.getHotkey('triggerOverlay') });
    manager.start();

    // O overlay so troca quando o jogador confirma; ate la o atalho vale.
    await config.setHotkey('quickAnalyze', 'Ctrl+Q');
    expect(source.tap('alt+x')).toBe(true);
    expect(source.tap('ctrl+q')).toBe(false);
  });

  it('persiste o atalho novo entre sessoes do ConfigManager', async () => {
    const first = configManager();
    await first.load();
    await first.setHotkey('triggerOverlay', 'Alt+K');

    const second = configManager();
    expect((await second.load()).hotkeys.triggerOverlay).toBe('alt+k');
  });

  it('recusa atalho invalido e mantem o anterior valido', async () => {
    const config = configManager();
    await config.load();

    const result = await config.setHotkey('triggerOverlay', 'Alt+Tab');

    expect(result.valid).toBe(false);
    expect(result.code).toBe('reserved');
    expect(config.getHotkey('triggerOverlay')).toBe('alt+x');
  });
});
