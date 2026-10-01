'use strict';

/**
 * Espelho CommonJS de `src/overlay/mainHotkeyManager.ts`.
 *
 * `main.cjs` e' carregado pelo Electron sem build, entao nao ha etapa que
 * transpile TypeScript. A divisao evita duas verdades: policy (validar,
 * converter `alt+e` -> `Alt+E`) mora so no TypeScript e o renderer manda o
 * acelerador pronto; o lifecycle (registrar, rebind, status, dispose,
 * disparar a captura) existe nos dois lados, dirigido pela mesma bateria de
 * vetores em `src/overlay/mainHotkeyManager.test.ts`.
 *
 * Se voce mudou este arquivo, mude tambem o `bind`/`unregister`/`dispose` de
 * `src/overlay/mainHotkeyManager.ts`.
 */

const INVALID_ITEM_MESSAGE = 'Nenhum item válido detectado no Clipboard';

/**
 * @param {object} options
 * @param {{ register(accelerator: string, handler: () => void): boolean,
 *           unregister(accelerator: string): void,
 *           unregisterAll(): void,
 *           isRegistered(accelerator: string): boolean }} options.backend
 * @param {{ readText(): string }} options.clipboard
 * @param {(payload: { text: string, capturedAt: number, accelerator: string }) => void} options.onCaptured
 * @param {(message: string) => void} [options.onInvalid]
 * @param {() => boolean} options.isPoE2Focused
 * @param {() => number} [options.now]
 * @param {boolean} [options.verbose]
 */
function createMainHotkeyManager(options) {
  const backend = options.backend;
  const clipboard = options.clipboard;
  const onCaptured = options.onCaptured;
  const onInvalid = options.onInvalid ?? ((message) => console.log(`[hotkey:main] ${message}`));
  const isPoE2Focused = options.isPoE2Focused;
  const now = options.now ?? Date.now;
  const verbose = options.verbose ?? false;

  let accelerator = null;
  let detail = 'Nenhum atalho global registrado.';

  function release() {
    if (accelerator !== null) {
      backend.unregister(accelerator);
      accelerator = null;
    }
  }

  function status() {
    if (accelerator === null) {
      return { available: true, registered: false, accelerator: null, detail };
    }
    const registered = backend.isRegistered(accelerator);
    return {
      available: true,
      registered,
      accelerator,
      detail: registered
        ? detail
        : `O sistema nao aceitou ${accelerator}. A combinacao pode ja estar em uso por outro programa.`,
    };
  }

  function trigger(bound) {
    // So captura se o Path of Exile 2 estiver em foco
    if (typeof isPoE2Focused === 'function' && !isPoE2Focused()) {
      if (verbose) console.log(`[hotkey:main] PoE2 nao esta em foco, ignorando atalho`);
      return;
    }

    let text = '';
    try {
      text = clipboard.readText();
    } catch (error) {
      if (verbose) {
        console.warn(`[hotkey:main] clipboard: ${error instanceof Error ? error.message : String(error)}`);
      }
      onInvalid(INVALID_ITEM_MESSAGE);
      return;
    }

    if (!/Rarity:|Item Class:/i.test(text)) {
      onInvalid(INVALID_ITEM_MESSAGE);
      return;
    }

    if (verbose) console.log(`[hotkey:main] ${bound} -> ${text.length} chars`);
    onCaptured({ text, capturedAt: now(), accelerator: bound });
  }

  return {
    get accelerator() {
      return accelerator;
    },

    status,

    /** Registra (ou troca) o acelerador. `null` libera o binding atual. */
    bind(next) {
      release();

      if (typeof next !== 'string' || next.length === 0) {
        detail = 'Nenhum atalho global registrado.';
        return status();
      }

      const ok = backend.register(next, () => trigger(next));
      accelerator = next;
      detail = ok
        ? `Atalho global ${next} ativo.`
        : `O sistema nao aceitou ${next}. A combinacao pode ja estar em uso por outro programa.`;

      if (verbose) console.log(`[hotkey:main] ${detail}`);
      return status();
    },

    unregister() {
      release();
      detail = 'Nenhum atalho global registrado.';
      return status();
    },

    /**
     * `unregisterAll` e' proposital: um `bind` que falhou no meio pode ter
     * deixado um accelerator preso no SO, e sair sem liberar isso mata a
     * combinacao para o usuario ate o proximo login.
     */
    dispose() {
      release();
      backend.unregisterAll();
      accelerator = null;
      detail = 'Atalho global liberado.';
    },
  };
}

module.exports = { createMainHotkeyManager };
