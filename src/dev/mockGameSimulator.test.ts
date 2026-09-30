import { describe, expect, it } from 'vitest';

import { parseFirstItem, parseItemText } from '../parser/itemParser.js';

import { MOCK_ITEMS } from './mockGameSimulator.js';

describe('MOCK_ITEMS', () => {
  it('cobre os tres cenarios de raridade do pedido', () => {
    expect(MOCK_ITEMS).toHaveLength(3);
    expect(MOCK_ITEMS.map((item) => item.label)).toEqual([
      expect.stringContaining('Magica'),
      expect.stringContaining('Raro'),
      expect.stringContaining('Normal'),
    ]);
  });

  it('cada item e lido como um item so, pelo parser de producao', () => {
    for (const item of MOCK_ITEMS) {
      const parsed = parseItemText(item.text);

      // Um fixture que o parser ignora deixaria o simulador "funcionando" e o
      // overlay vazio, que e' o modo de falha mais caro deste arquivo.
      expect(parsed.warnings, item.label).toEqual([]);
      expect(parsed.items, item.label).toHaveLength(1);

      const first = parsed.items[0];
      expect(first?.itemClass).not.toBe('other');
      expect(first?.itemLevel).toBeGreaterThan(0);
    }
  });

  it('preserva a classe e a raridade que o item anuncia', () => {
    const [wand, chest, ring] = MOCK_ITEMS.map((item) => parseFirstItem(item.text));

    expect(wand?.itemClass).toBe('wand');
    expect(wand?.rarity).toBe('magic');
    expect(wand?.baseType).toBe('Wand of the Frostweaver');

    expect(chest?.itemClass).toBe('chest');
    expect(chest?.rarity).toBe('rare');
    expect(chest?.modifiers.filter((mod) => mod.origin === 'implicit')).toHaveLength(2);

    expect(ring?.itemClass).toBe('ring');
    expect(ring?.rarity).toBe('normal');
  });
});
