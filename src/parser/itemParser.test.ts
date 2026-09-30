import { describe, expect, it } from 'vitest';

import {
  normalizeClipboardText,
  parseFirstItem,
  parseItemText,
  splitIntoItems,
  toItemModifier,
} from './itemParser.js';

const RARE_WAND = `Item Class: Wands
Rarity: Rare
Wandering Path
Crackling Wand
--------
Physical Damage: 27 to 48
Critical Strike Chance: 10.00%
--------
Requirements:
Level: 45
Int: 100
--------
Sockets: G-G-G
--------
Item Level: 64
--------
+11 to Accuracy Rating (implicit)
--------
+1 to Level of all Spell Skill Gems (implicit)
--------
+18 to Maximum Mana (implicit)
--------
+15% increased Cast Speed
--------
Flat Fire Damage to Attacks
--------
+22% increased Elemental Damage`;

describe('normalizeClipboardText', () => {
  it('normaliza CRLF do clipboard do Windows', () => {
    expect(normalizeClipboardText('a\r\nb')).toBe('a\nb');
  });

  it('remove espacos a direita', () => {
    expect(normalizeClipboardText('x   \ny\t\t')).toBe('x\ny');
  });
});

describe('splitIntoItems', () => {
  it('separa pelo cabecalho Item Class, nao pelo separador', () => {
    expect(splitIntoItems(RARE_WAND)).toHaveLength(1);
  });

  it('separa dois itens copiados juntos', () => {
    const two = `${RARE_WAND}\n--------\nItem Class: Rings\nRarity: Rare\n\nGold Band\nIron Ring\nItem Level: 20`;
    expect(splitIntoItems(two)).toHaveLength(2);
  });

  it('devolve vazio para texto sem cabecalho', () => {
    expect(splitIntoItems('texto solto')).toHaveLength(0);
  });
});

describe('parseItemText', () => {
  it('extrai header, escalares e propriedades', () => {
    const item = parseFirstItem(RARE_WAND);
    expect(item).not.toBeNull();
    expect(item?.name).toBe('Wandering Path');
    expect(item?.baseType).toBe('Crackling Wand');
    expect(item?.itemClass).toBe('wand');
    expect(item?.rarity).toBe('rare');
    expect(item?.itemLevel).toBe(64);
    expect(item?.properties.physicalDamage).toBe('27 to 48');
    expect(item?.properties.requirements['Level']).toBe('45');
    expect(item?.properties.sockets).toEqual(['G-G-G']);
  });

  it('extrai os 6 modificadores com a origem correta', () => {
    const item = parseFirstItem(RARE_WAND);
    expect(item?.modifiers).toHaveLength(6);

    const implicits = item?.modifiers.filter((m) => m.origin === 'implicit') ?? [];
    expect(implicits).toHaveLength(3);

    const castSpeed = item?.modifiers.find((m) => m.text.includes('Cast Speed'));
    expect(castSpeed?.magnitude).toBe(15);
    expect(castSpeed?.slot).toBe('suffix');

    const fire = item?.modifiers.find((m) => m.text.includes('Flat Fire Damage'));
    expect(fire?.slot).toBe('prefix');
  });

  it('nao trata secao de requisitos como modificador', () => {
    const item = parseFirstItem(RARE_WAND);
    expect(item?.modifiers.some((m) => m.text.includes('Level: 45'))).toBe(false);
  });

  it('reporta aviso quando o clipboard nao e um item', () => {
    const result = parseItemText('apenas um texto qualquer');
    expect(result.items).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('reporta clipboard vazio', () => {
    expect(parseItemText('   ').warnings).toContain('Clipboard vazio.');
  });
});

describe('toItemModifier', () => {
  it('extrai tier e origem', () => {
    const mod = toItemModifier('Flat Fire Damage to Attacks (crafted)');
    expect(mod.origin).toBe('crafted');
    expect(mod.tier).toBeNull();
  });

  it('extrai tier numerico', () => {
    const mod = toItemModifier('+30% to Fire Resistance (T3)');
    expect(mod.tier).toBe(3);
    expect(mod.magnitude).toBe(30);
  });

  it('trata synthetics como veiled', () => {
    expect(toItemModifier('Random Mod (synthetic)').origin).toBe('veiled');
  });

  it('devolve null em magnitude quando a linha nao tem numero', () => {
    expect(toItemModifier('Flat Fire Damage to Attacks').magnitude).toBeNull();
  });
});