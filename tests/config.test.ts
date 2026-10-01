import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigManager,
  ConfigValidationError,
  DEFAULT_USER_CONFIG,
  IpcConfigStorage,
  MemoryConfigStorage,
  type ConfigChangeEvent,
  type ConfigErrorEvent,
  type HotkeyChangeEvent,
  type UserConfig,
} from '../src/config/index.js';
import { createFileConfigManager, FileConfigStorage } from '../src/config/fileConfigStorage.js';

let dir: string;
let filePath: string;

/** Manager com persistencia em disco, que e' o cenario real no Node. */
function fileManager(options: Parameters<typeof createFileConfigManager>[1] = {}): ConfigManager {
  return createFileConfigManager(dir, options);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poe2-config-'));
  filePath = join(dir, 'config.json');
});

afterEach(() => {
  // O diretorio temporario e descartado pelo SO.
});

function read(): UserConfig {
  return JSON.parse(readFileSync(filePath, 'utf8')) as UserConfig;
}

function write(contents: unknown): void {
  writeFileSync(filePath, JSON.stringify(contents), 'utf8');
}

describe('ConfigManager', () => {
  describe('defaults', () => {
    it('usa os defaults exigidos quando nao ha arquivo', async () => {
      const manager = fileManager();
      const config = await manager.load();

      expect(config.hotkeys.triggerOverlay).toBe('alt+x');
      expect(config.hotkeys.quickAnalyze).toBe('ctrl+c');
      expect(config.crafting.defaultBudget).toBe(10);
      expect(config.ui.opacity).toBe(0.95);
      expect(config.version).toBe(1);
    });

    it('cria o arquivo na primeira gravacao', async () => {
      const manager = fileManager();
      await manager.load();
      expect(manager.exists).toBe(false);

      await manager.save();
      expect(manager.exists).toBe(true);
      expect(read()).toEqual(DEFAULT_USER_CONFIG);
    });

    it('normaliza atalhos vindos do arquivo', async () => {
      write({ hotkeys: { triggerOverlay: 'shift + ALT + E', quickAnalyze: 'Control+C' } });
      const config = await fileManager().load();

      expect(config.hotkeys.triggerOverlay).toBe('alt+shift+e');
      expect(config.hotkeys.quickAnalyze).toBe('ctrl+c');
    });

    it('migra o atalho global antigo para Alt+X', async () => {
      write({ hotkeys: { triggerOverlay: 'alt+q' } });
      const config = await fileManager().load();

      expect(config.hotkeys.triggerOverlay).toBe('alt+x');
    });
  });

  describe('leitura defensiva', () => {
    it('cai para defaults com JSON invalido e avisa', async () => {
      writeFileSync(filePath, '{ isso nao e json');
      const errors: ConfigErrorEvent[] = [];
      const manager = fileManager();
      manager.on('config:error', (event) => errors.push(event));

      const config = await manager.load();

      expect(config).toEqual(DEFAULT_USER_CONFIG);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.scope).toBe('load');
    });

    it('preenche campos faltantes sem descartar os presentes', async () => {
      write({ crafting: { defaultBudget: 42 } });
      const config = await fileManager().load();

      expect(config.crafting.defaultBudget).toBe(42);
      expect(config.crafting.budgetCurrency).toBe('exalted');
      expect(config.hotkeys.triggerOverlay).toBe('alt+x');
    });

    it('recusa hotkey global invalida e volta para o padrao', async () => {
      write({ hotkeys: { triggerOverlay: 'E' } });
      const errors: ConfigErrorEvent[] = [];
      const manager = fileManager();
      manager.on('config:error', (event) => errors.push(event));

      const config = await manager.load();

      expect(config.hotkeys.triggerOverlay).toBe('alt+x');
      expect(errors[0]?.scope).toBe('validate');
    });

    it('recusa atalho reservado do sistema operacional', async () => {
      write({ hotkeys: { triggerOverlay: 'Ctrl+Alt+Delete' } });
      const config = await fileManager().load();
      expect(config.hotkeys.triggerOverlay).toBe('alt+x');
    });

    it('mantem Ctrl+C observado mesmo sendo atalho comum', async () => {
      const config = await fileManager().load();
      expect(config.hotkeys.quickAnalyze).toBe('ctrl+c');
    });

    it('recusa os dois atalhos iguais vindos do arquivo', async () => {
      write({ hotkeys: { triggerOverlay: 'alt+e', quickAnalyze: 'alt+e' } });
      const config = await fileManager().load();

      expect(config.hotkeys.quickAnalyze).toBe('ctrl+c');
    });
  });

  describe('update', () => {
    it('faz merge parcial e persiste', async () => {
      const manager = fileManager();
      await manager.load();

      const next = await manager.update({ ui: { opacity: 0.8 } });

      expect(next.ui.opacity).toBe(0.8);
      expect(next.crafting.defaultBudget).toBe(10);
      expect(read().ui.opacity).toBe(0.8);
    });

    it('lança ConfigValidationError sem alterar a config atual', async () => {
      const manager = fileManager();
      await manager.load();

      await expect(manager.update({ ui: { opacity: 5 } })).rejects.toThrow(ConfigValidationError);
      expect(manager.get().ui.opacity).toBe(0.95);
    });

    it('nao persiste quando persist=false', async () => {
      const manager = fileManager();
      await manager.load();
      await manager.update({ ui: { opacity: 0.6 } }, { persist: false });
      expect(manager.exists).toBe(false);
    });
  });

  describe('setHotkey', () => {
    it('aceita e normaliza um novo atalho global', async () => {
      const manager = fileManager();
      await manager.load();

      const result = await manager.setHotkey('triggerOverlay', 'shift + alt + k');

      expect(result.valid).toBe(true);
      expect(manager.getHotkey('triggerOverlay')).toBe('alt+shift+k');
      expect(manager.getHotkeyLabel('triggerOverlay')).toBe('Alt+Shift+K');
    });

    it('recusa hotkey global sem modificador', async () => {
      const manager = fileManager();
      await manager.load();

      const result = await manager.setHotkey('triggerOverlay', 'F5');

      expect(result.valid).toBe(false);
      expect(result.code).toBe('no-modifier');
      expect(manager.getHotkey('triggerOverlay')).toBe('alt+x');
    });

    it('recusa conflito com o outro atalho', async () => {
      const manager = fileManager();
      await manager.load();

      const result = await manager.setHotkey('triggerOverlay', 'Ctrl+C');

      expect(result.valid).toBe(false);
      expect(result.code).toBe('conflict');
    });

    it('permite hotkey observado sem modificador', async () => {
      const manager = fileManager();
      await manager.load();

      const result = await manager.setHotkey('quickAnalyze', 'F4');

      expect(result.valid).toBe(true);
      expect(manager.getHotkey('quickAnalyze')).toBe('f4');
    });
  });

  describe('global vs observado', () => {
    it('triggerOverlay e global, quickAnalyze nao', async () => {
      const manager = fileManager();
      await manager.load();

      expect(manager.isGlobalHotkey('triggerOverlay')).toBe(true);
      expect(manager.isGlobalHotkey('quickAnalyze')).toBe(false);
    });
  });

  describe('eventos', () => {
    it('emite hotkey:changed com o par anterior/novo', async () => {
      const manager = fileManager();
      await manager.load();
      const events: HotkeyChangeEvent[] = [];
      manager.on('hotkey:changed', (event) => events.push(event));

      await manager.setHotkey('triggerOverlay', 'Ctrl+J');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'triggerOverlay',
        previous: 'alt+x',
        next: 'ctrl+j',
        global: true,
      });
    });

    it('emite config:changed com as chaves alteradas', async () => {
      const manager = fileManager();
      await manager.load();
      const events: ConfigChangeEvent[] = [];
      manager.on('config:changed', (event) => events.push(event));

      await manager.update({ crafting: { defaultBudget: 25 } });

      expect(events).toHaveLength(1);
      expect(events[0]?.changedKeys).toEqual(['crafting']);
    });

    it('nao emite config:changed quando nada muda de fato', async () => {
      const manager = fileManager();
      await manager.load();
      const events: ConfigChangeEvent[] = [];
      manager.on('config:changed', (event) => events.push(event));

      await manager.update({ crafting: { defaultBudget: 10 } });

      expect(events).toHaveLength(0);
    });

    it('para de emitir depois do unsubscribe', async () => {
      const manager = fileManager();
      await manager.load();
      const events: HotkeyChangeEvent[] = [];
      const off = manager.on('hotkey:changed', (event) => events.push(event));

      off();
      await manager.setHotkey('triggerOverlay', 'Ctrl+J');

      expect(events).toHaveLength(0);
    });
  });

  describe('reset e reload', () => {
    it('reset restaura os defaults e persiste', async () => {
      const manager = fileManager();
      await manager.load();
      await manager.update({ ui: { opacity: 0.4 }, crafting: { defaultBudget: 99 } });

      const reset = await manager.reset();

      expect(reset).toEqual(DEFAULT_USER_CONFIG);
      expect(read().ui.opacity).toBe(0.95);
    });

    it('reset emite hotkey:changed para o atalho antigo', async () => {
      const manager = fileManager();
      await manager.load();
      await manager.setHotkey('triggerOverlay', 'ctrl+j');

      const events: HotkeyChangeEvent[] = [];
      manager.on('hotkey:changed', (event) => events.push(event));
      await manager.reset();

      expect(events).toEqual([
        { action: 'triggerOverlay', previous: 'ctrl+j', next: 'alt+x', global: true },
      ]);
    });

    it('reload descarta mudancas nao persistidas', async () => {
      const manager = fileManager();
      await manager.load();
      await manager.update({ ui: { opacity: 0.5 } }, { persist: false });

      expect((await manager.reload()).ui.opacity).toBe(0.95);
    });

    it('ensureLoaded so le do storage uma vez', async () => {
      const manager = fileManager();
      expect((await manager.ensureLoaded()).ui.opacity).toBe(0.95);

      write({ ui: { opacity: 0.35 } });
      expect((await manager.ensureLoaded()).ui.opacity).toBe(0.95);
    });
  });

  describe('storage', () => {
    it('usa o storage injetado em vez do disco', async () => {
      let contents: string | null = null;
      const manager = new ConfigManager({
        storage: new IpcConfigStorage({
          read: async () => contents,
          write: async (next) => {
            contents = next;
          },
        }),
      });

      expect(manager.path).toBeNull();
      expect((await manager.load()).ui.opacity).toBe(0.95);

      await manager.setHotkey('triggerOverlay', 'Ctrl+J');

      expect(manager.getHotkey('triggerOverlay')).toBe('ctrl+j');
      expect(JSON.parse(contents ?? '{}')).toMatchObject({
        hotkeys: { triggerOverlay: 'ctrl+j' },
      });
    });

    it('nao grava no disco quando o storage e o IPC', async () => {
      const manager = new ConfigManager({
        storage: new IpcConfigStorage({ read: async () => null, write: async () => undefined }),
      });
      await manager.load();
      await manager.save();

      expect(manager.exists).toBe(true);
      expect(manager.path).toBeNull();
    });

    it('o padrao em memoria nao persiste entre managers', async () => {
      const first = new ConfigManager();
      await first.load();
      await first.setHotkey('triggerOverlay', 'Ctrl+J');

      expect((await new ConfigManager().load()).hotkeys.triggerOverlay).toBe('alt+x');
    });

    it('o padrao em memoria guarda o que foi gravado', async () => {
      const storage = new MemoryConfigStorage();
      const manager = new ConfigManager({ storage });
      await manager.load();
      await manager.setHotkey('triggerOverlay', 'Ctrl+J');

      expect(await storage.read()).toContain('ctrl+j');
    });

    it('propa o erro de leitura como config:error e cai para defaults', async () => {
      const errors: ConfigErrorEvent[] = [];
      const manager = new ConfigManager({
        storage: new IpcConfigStorage({
          read: async () => {
            throw new Error('canal fechado');
          },
          write: async () => undefined,
        }),
      });
      manager.on('config:error', (event) => errors.push(event));

      const config = await manager.load();

      expect(config).toEqual(DEFAULT_USER_CONFIG);
      expect(errors[0]?.scope).toBe('load');
    });

    it('FileConfigStorage le null antes da primeira escrita', async () => {
      const storage = new FileConfigStorage(join(dir, 'novo', 'config.json'));
      expect(await storage.read()).toBeNull();

      await storage.write('{"ok":true}');

      expect(await storage.read()).toBe('{"ok":true}');
    });
  });

  describe('describe', () => {
    it('resume caminho e regime dos dois atalhos', async () => {
      const manager = fileManager();
      await manager.load();

      const summary = manager.describe();

      expect(summary).toContain('triggerOverlay=Alt+X(global)');
      expect(summary).toContain('quickAnalyze=Ctrl+C(observado)');
    });
  });
});
