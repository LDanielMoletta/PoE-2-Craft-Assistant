import { describe, expect, it } from 'vitest';

import { HotkeyManager } from './hotkeyManager.js';
import { SimulatedClipboardReader } from './clipboardReader.js';
import { SimulatedHotkeySource } from './hotkeySource.js';
import { normalizeSequence, sequenceFromPress } from './hotkeySource.js';
import { parseFirstItem } from '../parser/index.js';

const ITEM = `Item Class: Wands
Rarity: Rare
Wandering Path
Crackling Wand
--------
Item Level: 64
--------
+15% increased Cast Speed`;

function buildOverlay(): {
  hotkeys: HotkeyManager;
  clipboard: SimulatedClipboardReader;
  source: SimulatedHotkeySource;
} {
  const clipboard = new SimulatedClipboardReader();
  const source = new SimulatedHotkeySource();
  const hotkeys = new HotkeyManager({ hotkey: 'Alt+E', source, clipboard });
  hotkeys.start();
  return { hotkeys, clipboard, source };
}

describe('normalizeSequence', () => {
  it('normaliza para ordem fixa de modificadores', () => {
    expect(normalizeSequence('e+alt')).toBe('alt+e');
    expect(normalizeSequence('Shift+Alt+E')).toBe('alt+shift+e');
  });

  it('extrai a sequencia de um KeyPress', () => {
    expect(sequenceFromPress({ key: 'e', alt: true, ctrl: false, shift: false, meta: false })).toBe(
      'alt+e',
    );
  });
});

describe('HotkeyManager', () => {
  it('escuta Alt+E por padrao', () => {
    const { hotkeys } = buildOverlay();
    expect(hotkeys.sequence).toBe('alt+e');
  });

  it('aciona o fluxo completo: clipboard -> parse -> item', async () => {
    const { hotkeys, clipboard, source } = buildOverlay();
    clipboard.enqueue(ITEM);

    const captured = new Promise<Awaited<ReturnType<HotkeyManager['trigger']>>>((resolve) => {
      const off = hotkeys.onCapture(resolve);
      void off;
    });

    expect(source.tap('alt+e')).toBe(true);

    const result = await captured;
    expect(result.triggered).toBe(true);
    expect(result.sequence).toBe('alt+e');
    expect(result.item?.name).toBe('Wandering Path');
    expect(result.item?.itemLevel).toBe(64);
    expect(result.warnings).toHaveLength(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    hotkeys.dispose();
  });

  it('o item devolvido e identico ao parse direto', async () => {
    const { hotkeys, clipboard } = buildOverlay();
    clipboard.enqueue(ITEM);

    const result = await hotkeys.trigger();
    const direct = parseFirstItem(ITEM);

    expect(result.item?.name).toBe(direct?.name);
    expect(result.item?.modifiers).toEqual(direct?.modifiers);

    hotkeys.dispose();
  });

  it('nao dispara quando o atalho nao foi pressionado', async () => {
    const { hotkeys, source } = buildOverlay();
    expect(source.tap('alt+q')).toBe(false);
    hotkeys.dispose();
  });

  it('avisa quando o clipboard nao tem item', async () => {
    const { hotkeys, clipboard } = buildOverlay();
    clipboard.enqueue('');

    const result = await hotkeys.trigger();
    expect(result.item).toBeNull();
    expect(result.warnings.some((w) => w.includes('Clipboard vazio'))).toBe(true);

    hotkeys.dispose();
  });

  it('stop() remove o registro do atalho', () => {
    const { hotkeys, source } = buildOverlay();
    hotkeys.stop();
    expect(source.tap('alt+e')).toBe(false);
    hotkeys.dispose();
  });
});