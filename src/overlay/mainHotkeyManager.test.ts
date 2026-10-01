import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  MainHotkeyManager,
  toElectronAccelerator,
  type GlobalShortcutBackend,
  type ItemCapturedPayload,
} from './mainHotkeyManager.js';

/**
 * As duas implementacoes do ciclo de vida do atalho global.
 *
 * `src/overlay/mainHotkeyManager.ts` e' a que o resto do app conhece;
 * `electron/mainHotkeyManager.cjs` e' a que o `main.cjs` carrega sem build.
 * A divisao documentada e' "policy so no TS, lifecycle nos dois lados", entao
 * estes vetores exercitam apenas o lifecycle, e rodam identicos nas duas.
 */
const requireCjs = createRequire(import.meta.url);
const cjsModule = requireCjs('../../electron/mainHotkeyManager.cjs') as {
  createMainHotkeyManager: (options: {
    backend: GlobalShortcutBackend;
    clipboard: { readText(): string };
    onCaptured: (payload: ItemCapturedPayload) => void;
    onInvalid?: (message: string) => void;
    now: () => number;
    verbose?: boolean;
  }) => {
    bind(next: string | null): unknown;
    unregister(): unknown;
    dispose(): void;
    status(): unknown;
  };
};

interface FakeBackend extends GlobalShortcutBackend {
  /** Aceleradores que o "SO" aceitou, e seus handlers. */
  readonly live: Map<string, () => void>;
  readonly calls: string[];
  /** Simula outra programa ja com a combinacao. */
  reject: Set<string>;
  press(accelerator: string): void;
}

function fakeBackend(): FakeBackend {
  const live = new Map<string, () => void>();
  const calls: string[] = [];
  const reject = new Set<string>();
  return {
    live,
    calls,
    reject,
    register(accelerator, handler) {
      calls.push(`register:${accelerator}`);
      if (reject.has(accelerator)) return false;
      live.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) {
      calls.push(`unregister:${accelerator}`);
      live.delete(accelerator);
    },
    unregisterAll() {
      calls.push('unregisterAll');
      live.clear();
    },
    isRegistered(accelerator) {
      return live.has(accelerator);
    },
    press(accelerator) {
      const handler = live.get(accelerator);
      if (handler === undefined) throw new Error(`nenhum binding para ${accelerator}`);
      handler();
    },
  };
}

interface Harness {
  bind(next: string | null): Record<string, unknown>;
  unregister(): Record<string, unknown>;
  dispose(): void;
  status(): unknown;
}

/** As duas APIs de status nao batem: getter no TS, metodo no CJS. */
function statusOf(manager: Harness): Record<string, unknown> {
  const raw: unknown = manager.status;
  if (typeof raw === 'function') return (raw as () => Record<string, unknown>)();
  return raw as Record<string, unknown>;
}

const NOW = 1_760_000_000_000;
const VALID_ITEM = 'Item Class: Wands\nRarity: Rare\nRequirements: Level 20';

function build(make: ManagerFactory, clipboard: { readText(): string }, captured: ItemCapturedPayload[]) {
  const backend = fakeBackend();
  const invalid: string[] = [];
  const manager = make({
    backend,
    clipboard,
    onCaptured: (p) => captured.push(p),
    onInvalid: (message) => invalid.push(message),
    now: () => NOW,
  });
  return { backend, manager, invalid };
}

type ManagerFactory = (options: {
  backend: GlobalShortcutBackend;
  clipboard: { readText(): string };
  onCaptured: (payload: ItemCapturedPayload) => void;
  onInvalid?: (message: string) => void;
  now: () => number;
}) => Harness;

const implementations: ReadonlyArray<[string, ManagerFactory]> = [
  ['TypeScript', (options) => new MainHotkeyManager(options) as unknown as Harness],
  ['CommonJS', cjsModule.createMainHotkeyManager as unknown as ManagerFactory],
];

describe('toElectronAccelerator', () => {
  it('converte a sequencia canonica do config no acelerador do Electron', () => {
    expect(toElectronAccelerator('alt+e')).toBe('Alt+E');
    expect(toElectronAccelerator('ctrl+shift+f5')).toBe('Ctrl+Shift+F5');
    expect(toElectronAccelerator('super+j')).toBe('Super+J');
  });

  it('aceita os apelidos de modificador e devolve sempre a grafia do Electron', () => {
    expect(toElectronAccelerator('cmd+j')).toBe('Super+J');
    expect(toElectronAccelerator('win+j')).toBe('Super+J');
    expect(toElectronAccelerator('control+e')).toBe('Ctrl+E');
  });

  it('traduz teclas com grafia propria na API do Electron', () => {
    // Nomes errados aqui nao lancam: `register` so devolve `false` e o atalho
    // parece funcionar sem nunca disparar.
    expect(toElectronAccelerator('alt+enter')).toBe('Alt+Enter');
    expect(toElectronAccelerator('alt+space')).toBe('Alt+Space');
    expect(toElectronAccelerator('ctrl+up')).toBe('Ctrl+Up');
    expect(toElectronAccelerator('ctrl+pagedown')).toBe('Ctrl+PageDown');
  });

  it('recusa sequencia sem modificador, que sequestraria digitacao no jogo', () => {
    expect(toElectronAccelerator('e')).toBeNull();
    expect(toElectronAccelerator('f5')).toBeNull();
  });

  it('recusa sequencia so com modificadores, que nao tem tecla de disparo', () => {
    expect(toElectronAccelerator('alt')).toBeNull();
    expect(toElectronAccelerator('ctrl+shift')).toBeNull();
  });

  it('recusa atalho reservado do SO, que falha em silencio ao registrar', () => {
    // `alt+esc` e `meta+q` passariam pelo registro e simplesmente nunca
    // disparariam: e' o pior tipo de bug de hotkey.
    expect(toElectronAccelerator('alt+esc')).toBeNull();
    expect(toElectronAccelerator('alt+f4')).toBeNull();
    expect(toElectronAccelerator('meta+q')).toBeNull();
  });

  it('recusa entrada invalida em vez de devolver acelerador pela metade', () => {
    expect(toElectronAccelerator('')).toBeNull();
    expect(toElectronAccelerator('alt+')).toBeNull();
    expect(toElectronAccelerator('   ')).toBeNull();
  });
});

describe.each(implementations)('ciclo de vida do atalho global (%s)', (_name, make) => {
  it('comeca sem binding nenhum', () => {
    const captured: ItemCapturedPayload[] = [];
    const { manager } = build(make, { readText: () => 'x' }, captured);

    expect(statusOf(manager)).toEqual({
      available: true,
      registered: false,
      accelerator: null,
      detail: 'Nenhum atalho global registrado.',
    });
  });

  it('registra o acelerador e reporta o binding vivo', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => 'x' }, captured);

    const status = manager.bind('Alt+E');

    expect(status.registered).toBe(true);
    expect(status.accelerator).toBe('Alt+E');
    expect(status.detail).toBe('Atalho global Alt+E ativo.');
    expect(backend.live.has('Alt+E')).toBe(true);
  });

  it('libera o binding anterior antes de registrar o novo', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => 'x' }, captured);

    manager.bind('Alt+E');
    manager.bind('Alt+F');

    // Sem o release, Alt+E continuaria registrado e disparando junto do novo.
    expect(backend.calls).toEqual(['register:Alt+E', 'unregister:Alt+E', 'register:Alt+F']);
    expect(backend.live.has('Alt+E')).toBe(false);
    expect(backend.live.has('Alt+F')).toBe(true);
  });

  it('explica conflito com outro programa em vez de fingir que registrou', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => 'x' }, captured);
    backend.reject.add('Alt+E');

    const status = manager.bind('Alt+E');

    expect(status.registered).toBe(false);
    expect(status.accelerator).toBe('Alt+E');
    expect(status.detail).toMatch(/nao aceitou Alt\+E/);
  });

  it('dispara a captura com o texto do clipboard e o acelerador que disparou', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => VALID_ITEM }, captured);
    manager.bind('Alt+E');

    backend.press('Alt+E');

    expect(captured).toEqual([
      { text: VALID_ITEM, capturedAt: NOW, accelerator: 'Alt+E' },
    ]);
  });

  it('notifica quando a leitura do clipboard falha', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager, invalid } = build(
      make,
      {
        readText() {
          throw new Error('clipboard travado');
        },
      },
      captured,
    );
    manager.bind('Alt+E');

    backend.press('Alt+E');

    expect(captured).toEqual([]);
    expect(invalid).toEqual(['Nenhum item válido detectado no Clipboard']);
  });

  it('le o clipboard sem altera-lo quando a hotkey e pressionada', () => {
    const captured: ItemCapturedPayload[] = [];
    const calls: string[] = [];
    const { backend, manager } = build(
      make,
      {
        readText: () => {
          calls.push('read');
          return VALID_ITEM;
        },
      },
      captured,
    );
    manager.bind('Alt+E');

    backend.press('Alt+E');

    expect(calls).toEqual(['read']);
    expect(captured).toHaveLength(1);
  });

  it('notifica quando clipboard nao contem marcadores de item', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager, invalid } = build(make, { readText: () => 'texto sem item' }, captured);
    manager.bind('Alt+E');

    backend.press('Alt+E');

    expect(captured).toEqual([]);
    expect(invalid).toEqual(['Nenhum item válido detectado no Clipboard']);
  });

  it('cada disparo leva o acelerador atual, mesmo apos um rebind', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => VALID_ITEM }, captured);
    manager.bind('Alt+E');
    manager.bind('Alt+F');

    backend.press('Alt+F');

    expect(captured.at(-1)?.accelerator).toBe('Alt+F');
  });

  it('bind(null) libera sem registrar nada', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => 'x' }, captured);
    manager.bind('Alt+E');

    const status = manager.bind(null);

    expect(status.accelerator).toBeNull();
    expect(status.registered).toBe(false);
    expect(backend.live.size).toBe(0);
  });

  it('unregister e idempotente', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => 'x' }, captured);
    manager.bind('Alt+E');

    manager.unregister();
    manager.unregister();

    expect(backend.calls.filter((call) => call === 'unregister:Alt+E')).toHaveLength(1);
    expect(backend.live.size).toBe(0);
  });

  it('dispose chama unregisterAll, para nao deixar accelerator preso no SO', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => 'x' }, captured);
    manager.bind('Alt+E');

    manager.dispose();

    // Um `register` que falhou no meio pode ter deixado um accelerator preso
    // no SO; sair sem liberar isso mata a combinacao ate o proximo login.
    expect(backend.calls.at(-1)).toBe('unregisterAll');
    expect(backend.live.size).toBe(0);
    expect(statusOf(manager).accelerator).toBeNull();
  });

  it('nao registra duas vezes o mesmo acelerador', () => {
    const captured: ItemCapturedPayload[] = [];
    const { backend, manager } = build(make, { readText: () => VALID_ITEM }, captured);

    manager.bind('Alt+E');
    manager.bind('Alt+E');
    manager.bind('Alt+E');

    expect(backend.calls).toEqual(['register:Alt+E', 'unregister:Alt+E', 'register:Alt+E', 'unregister:Alt+E', 'register:Alt+E']);
    expect(backend.live.size).toBe(1);
    // O handler antigo nao pode sobrar: senao a tecla dispararia duas vezes.
    backend.press('Alt+E');
    expect(captured).toHaveLength(1);
  });
});

describe('MainHotkeyManager.bindSequence', () => {
  it('converte e registra em um passo so', () => {
    const captured: ItemCapturedPayload[] = [];
    const backend = fakeBackend();
    const hotkeys = new MainHotkeyManager({
      backend,
      clipboard: { readText: () => 'x' },
      onCaptured: (p) => captured.push(p),
    });

    const status = hotkeys.bindSequence('alt+e');

    expect(status.registered).toBe(true);
    expect(status.accelerator).toBe('Alt+E');
  });

  it('libera o binding atual quando a sequencia e invalida', () => {
    const captured: ItemCapturedPayload[] = [];
    const backend = fakeBackend();
    const hotkeys = new MainHotkeyManager({
      backend,
      clipboard: { readText: () => 'x' },
      onCaptured: (p) => captured.push(p),
    });
    hotkeys.bindSequence('alt+e');

    const status = hotkeys.bindSequence('e');

    // Um overlay que ainda responde a Alt+E depois de o campo ter virado `e`
    // e pior do que um overlay mudo.
    expect(status.registered).toBe(false);
    expect(status.accelerator).toBeNull();
    expect(status.detail).toMatch(/invalido para registro global/);
    expect(backend.live.size).toBe(0);
  });

  it('bindSequence(null) libera o binding', () => {
    const backend = fakeBackend();
    const hotkeys = new MainHotkeyManager({
      backend,
      clipboard: { readText: () => 'x' },
      onCaptured: () => {},
    });
    hotkeys.bindSequence('alt+e');

    expect(hotkeys.bindSequence(null).accelerator).toBeNull();
    expect(backend.live.size).toBe(0);
  });
});
