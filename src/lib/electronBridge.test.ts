// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { electronBridge, isElectronAvailable } from './electronBridge.js';

describe('electronBridge', () => {
  beforeEach(() => {
    window.electron = undefined;
    window.overlayHost = undefined;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('usa fallbacks seguros no navegador', async () => {
    expect(isElectronAvailable()).toBe(false);
    expect(electronBridge.onItemParsed(vi.fn())).toEqual(expect.any(Function));
    expect(electronBridge.onItemCaptured(vi.fn())).toEqual(expect.any(Function));
    expect(await electronBridge.readConfig()).toBeNull();
    expect(await electronBridge.readClipboard()).toEqual({ text: '', capturedAt: expect.any(Number) });
    expect(await electronBridge.registerGlobalHotkey('Alt+Q')).toBeNull();
    expect(electronBridge.show()).toBeUndefined();
    expect(electronBridge.hide()).toBeUndefined();
    expect(electronBridge.close()).toBeUndefined();
  });

  it('persiste a configuracao no localStorage quando nao ha IPC', async () => {
    const contents = JSON.stringify({ hotkeys: { triggerOverlay: 'alt+q' } });

    await electronBridge.writeConfig(contents);

    expect(await electronBridge.readConfig()).toBe(contents);
  });

  it('prefere o bridge electron nativo quando presente', async () => {
    const readConfig = vi.fn(async () => '{"from":"electron"}');
    window.electron = { readConfig } as unknown as NonNullable<Window['electron']>;

    expect(isElectronAvailable()).toBe(true);
    expect(await electronBridge.readConfig()).toBe('{"from":"electron"}');
    expect(readConfig).toHaveBeenCalledOnce();
  });
});