type ElectronApi = NonNullable<Window['overlayHost']>;

const CONFIG_STORAGE_KEY = 'poe2-craft-assistant:config';
const noop = (): void => {};

function nativeApi(): ElectronApi | undefined {
  if (typeof window === 'undefined') return undefined;
  const candidate = window.electron ?? window.overlayHost;
  return candidate !== null && typeof candidate === 'object' ? candidate : undefined;
}

function readWebConfig(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(CONFIG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeWebConfig(contents: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CONFIG_STORAGE_KEY, contents);
  } catch {
    // ConfigManager conserva a configuracao atual em memoria.
  }
}

export function isElectronAvailable(): boolean {
  return nativeApi() !== undefined;
}

export const electronBridge = {
  hide(): void {
    try {
      nativeApi()?.hide?.();
    } catch {
      // No-op when the host window API is unavailable.
    }
  },

  show(): void {
    try {
      nativeApi()?.show?.();
    } catch {
      // No-op when the host window API is unavailable.
    }
  },

  close(): void {
    try {
      nativeApi()?.close?.();
    } catch {
      // No-op when the host window API is unavailable.
    }
  },

  async readClipboard(): Promise<{ readonly text: string; readonly capturedAt: number }> {
    const api = nativeApi();
    if (typeof api?.readClipboard === 'function') {
      try {
        return await api.readClipboard();
      } catch {
        // Browser clipboard may still be available if the preload call fails.
      }
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      try {
        return { text: await navigator.clipboard.readText(), capturedAt: Date.now() };
      } catch {
        // Clipboard access in a browser requires a secure context and permission.
      }
    }
    return { text: '', capturedAt: Date.now() };
  },

  async readConfig(): Promise<string | null> {
    const api = nativeApi();
    if (typeof api?.readConfig === 'function') {
      try {
        return await api.readConfig();
      } catch {
        // Use browser storage if IPC is unavailable.
      }
    }
    return readWebConfig();
  },

  async writeConfig(contents: string): Promise<void> {
    const api = nativeApi();
    if (typeof api?.writeConfig === 'function') {
      try {
        await api.writeConfig(contents);
        return;
      } catch {
        // Fall through to browser storage.
      }
    }
    writeWebConfig(contents);
  },

  async readDataSnapshot(): Promise<string | null> {
    const api = nativeApi();
    if (typeof api?.readDataSnapshot !== 'function') return null;
    try {
      return await api.readDataSnapshot();
    } catch {
      return null;
    }
  },

  async writeDataSnapshot(contents: string): Promise<void> {
    const api = nativeApi();
    if (typeof api?.writeDataSnapshot !== 'function') return;
    try {
      await api.writeDataSnapshot(contents);
    } catch {
      // The bundled and in-session snapshots remain available in the browser.
    }
  },

  async registerGlobalHotkey(accelerator: string | null) {
    const api = nativeApi();
    if (typeof api?.registerGlobalHotkey !== 'function') return null;
    try {
      return await api.registerGlobalHotkey(accelerator);
    } catch {
      return null;
    }
  },

  async getHotkeyStatus() {
    const api = nativeApi();
    if (typeof api?.getHotkeyStatus === 'function') {
      try {
        return await api.getHotkeyStatus();
      } catch {
        // Return a browser-safe status below.
      }
    }
    return {
      available: false,
      registered: false,
      accelerator: null,
      detail: 'Atalho global indisponivel no navegador.',
    };
  },

  onItemCaptured(handler: Parameters<ElectronApi['onItemCaptured']>[0]): () => void {
    const api = nativeApi();
    if (typeof api?.onItemCaptured !== 'function') return noop;
    try {
      return api.onItemCaptured(handler);
    } catch {
      return noop;
    }
  },

  onItemParsed(handler: Parameters<ElectronApi['onItemParsed']>[0]): () => void {
    const api = nativeApi();
    if (typeof api?.onItemParsed !== 'function') return noop;
    try {
      return api.onItemParsed(handler);
    } catch {
      return noop;
    }
  },

  async openExternal(url: string): Promise<void> {
    const api = nativeApi();
    if (typeof api?.openExternal !== 'function') return;
    try {
      await api.openExternal(url);
    } catch {
      // No-op when the host window API is unavailable.
    }
  },

  writeLog(line: string): void {
    try {
      nativeApi()?.writeLog?.(line);
    } catch {
      // Logging must not break the browser UI.
    }
  },

  async readLog(): Promise<string> {
    const api = nativeApi();
    if (typeof api?.readLog !== 'function') return '';
    try {
      return await api.readLog();
    } catch {
      return '';
    }
  },

  async sendFeedback(payload: Parameters<ElectronApi['sendFeedback']>[0]) {
    const api = nativeApi();
    if (typeof api?.sendFeedback !== 'function') {
      return { channel: 'none' as const, ok: false as const, reason: 'Electron indisponivel no navegador.' };
    }
    try {
      return await api.sendFeedback(payload);
    } catch (error) {
      return {
        channel: 'none' as const,
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
};