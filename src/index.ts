/**
 * Ponto de entrada e simulacao do fluxo completo do overlay.
 *
 * Executa sem servidor, sem display e sem chave de API:
 *   1. Simula o atalho Alt+E com um item mockado no clipboard.
 *   2. O HotkeyManager le o clipboard e o parser devolve o Item estruturado.
 *   3. Define o CraftTarget do usuario.
 *   4. O CraftAgent chama a PoeDataService e imprime o plano de craft.
 *
 * Rode com:  pnpm dev
 */

import { CraftAgent, renderPlan } from './agent/index.js';
import { HotkeyManager } from './overlay/hotkeyManager.js';
import { SimulatedClipboardReader, type IClipboardReader } from './overlay/clipboardReader.js';
import { SimulatedHotkeySource } from './overlay/hotkeySource.js';
import { SimulatedScreenCapture } from './overlay/screenCapture.js';
import { createDefaultClipboardReader } from './overlay/nodeClipboardReader.js';
import { createDefaultScreenCapture, type IScreenCapture } from './overlay/nodeScreenCapture.js';
import { PoeDataService } from './scraper/poeDataService.js';
import { WikiCache } from './scraper/wikiCache.js';
import { FileCacheDisk } from './scraper/wikiCacheDisk.js';
import { CraftTargetSchema, type CraftTarget, type Item } from './types/index.js';

// ---------------------------------------------------------------------------
// 1. Item mockado — o texto exato que o jogo colocaria no clipboard com Ctrl+C
// ---------------------------------------------------------------------------

const MOCK_ITEM_TEXT = `Item Class: Wands
Rarity: Rare
Wandering Path
Crackling Wand
--------
Physical Damage: 27 to 48
Critical Hit Chance: 10.00%
Critical Damage Multiplier: 120%
Attacks per Second: 1.32
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

// ---------------------------------------------------------------------------
// 2. Metas de craft do usuario
// ---------------------------------------------------------------------------

const CRAFT_TARGET: CraftTarget = CraftTargetSchema.parse({
  itemClass: null,
  maxBudget: 5,
  budgetCurrency: 'exalted',
  preserveExisting: false,
  allowImplicitRemoval: false,
  minItemLevel: null,
  targetModifiers: [
    {
      // Ja existe no item como T1 (+18) e o alvo e um T2/T3 (+28 ou mais).
      query: 'Flat Fire Damage',
      slot: 'prefix',
      required: true,
      minValue: 28,
      maxValue: null,
    },
    {
      // Slot de sufixo livre: o agente deve sugerir uma moeda aditiva (Regal).
      query: 'chance to Ignite',
      slot: 'suffix',
      required: false,
      minValue: null,
      maxValue: null,
    },
    {
      // Ja e implicito no item com +1; upgrade para +2 e impossivel por craft.
      query: 'to Level of all Spell Skill Gems',
      slot: 'any',
      required: false,
      minValue: 2,
      maxValue: null,
    },
  ],
});

// ---------------------------------------------------------------------------
// helpers de apresentacao
// ---------------------------------------------------------------------------

const DIVIDER = '='.repeat(78);

function heading(title: string): void {
  console.log(`\n${DIVIDER}\n${title}\n${DIVIDER}`);
}

function describeItem(item: Item | null): void {
  if (item === null) {
    console.log('  (nenhum item extraido)');
    return;
  }

  console.log(`  Nome .............. ${item.name ?? '(sem nome)'}`);
  console.log(`  Base .............. ${item.baseType ?? '(n/d)'}`);
  console.log(`  Classe/Raridade ... ${item.itemClass} / ${item.rarity}`);
  console.log(`  Item Level ........ ${item.itemLevel ?? 'n/d'}   Quality: ${item.quality ?? 0}%`);
  console.log(`  Dano fisico ....... ${item.properties.physicalDamage ?? 'n/d'}`);
  console.log(`  Sockets ........... ${item.properties.sockets.join(' ') || '(nenhum)'}`);
  console.log(`  Modificadores (${item.modifiers.length}):`);
  for (const mod of item.modifiers) {
    const slot = mod.slot === 'none' ? '--' : mod.slot === 'prefix' ? 'PF' : 'SF';
    const tier = mod.tier !== null ? `T${mod.tier}` : '--';
    const origin = mod.origin === 'unknown' ? '' : ` (${mod.origin})`;
    console.log(`    [${slot}] [${tier}] ${mod.text}${origin}`);
  }
}

// ---------------------------------------------------------------------------
// Simulacao principal
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  heading('POE2 CRAFT ASSISTANT — simulacao completa do overlay');

  // `--live` troca o clipboard simulado pelo do sistema: util para validar o
  // parser contra o texto que o jogo realmente escreve com Ctrl+C.
  const live = process.argv.includes('--live');
  const clipboard: IClipboardReader = live ? createDefaultClipboardReader() : new SimulatedClipboardReader();
  const screenCapture: IScreenCapture = live ? createDefaultScreenCapture() : new SimulatedScreenCapture();
  const hotkeySource = new SimulatedHotkeySource();
  // O cache em disco usa `node:fs`, entao so entra aqui no CLI; no overlay
  // Electron o PoeDataService fica so com a camada de memoria.
  const dataService = new PoeDataService({
    fallbackToSeed: true,
    cache: new WikiCache({ disk: new FileCacheDisk() }),
  });
  const agent = new CraftAgent({ dataService, verbose: true });

  if (live) console.log('  modo --live: lendo o clipboard real do sistema\n');

  // 0) Pre-aquece o catalogo de mods da classe do item.
  await dataService.warmup(['wand', 'chest', 'ring']);
  console.log(`\n[scraper] catalogo pronto. cache: ${dataService.cacheDescription}`);
  console.log(`[agent]   modelo LLM ${agent.hasLlm ? 'disponivel' : 'indisponivel — usando planner deterministico'}`);

  // ---------------------------------------------------------------------
  // PASSO 1 — o jogador faz Ctrl+C no item e aperta Alt+E
  // ---------------------------------------------------------------------
  heading('PASSO 1 — atalho global Alt+E (clipboard -> parser)');

  if (!live) (clipboard as SimulatedClipboardReader).enqueue(MOCK_ITEM_TEXT);

  const hotkeys = new HotkeyManager({
    hotkey: 'Alt+E',
    source: hotkeySource,
    clipboard,
    verbose: true,
  });
  hotkeys.start();

  console.log('  Registro do atalho: Alt+E');
  console.log('  Jogador fez Ctrl+C no item e apertou Alt+E...\n');

  const triggered = hotkeys.simulateHotkey();
  console.log(`  atalho reconhecido: ${triggered}`);

  // O handler e assincrono; aguardamos a captura via uma Promise.
  const capture = await new Promise<Awaited<ReturnType<HotkeyManager['trigger']>>>((resolve) => {
    const off = hotkeys.onCapture((result) => {
      off();
      resolve(result);
    });
  });

  console.log(`\n  Sequencia capturada .. ${capture.sequence}`);
  console.log(`  Latencia ............. ${capture.latencyMs} ms`);
  console.log(`  Clipboard lido ....... ${capture.clipboardText.length} caracteres`);
  console.log(`  Itens reconhecidos ... ${capture.parseResult?.items.length ?? 0}`);
  for (const warning of capture.warnings) {
    console.log(`  aviso: ${warning}`);
  }

  const item = capture.item;
  if (item === null) {
    console.error('\nFALHA: o parser nao produziu nenhum item. Abortando simulacao.');
    process.exitCode = 1;
    return;
  }

  heading('PASSO 2 — item estruturado devolvido pelo parser');
  describeItem(item);

  const bounds = await screenCapture.detectItemBounds();
  console.log(`\n  Bounds do item sob o cursor (overlay): ${JSON.stringify(bounds)}`);

  // ---------------------------------------------------------------------
  // PASSO 3 — resolucao dos status desejados (scraper)
  // ---------------------------------------------------------------------
  heading('PASSO 3 — scraper: o alvo e prefixo ou sufixo? qual tier? qual chance?');

  for (const desired of CRAFT_TARGET.targetModifiers) {
    const resolution = await dataService.resolveDesiredMod(
      desired.query,
      item.itemClass,
      item.itemLevel ?? 1,
    );

    if (resolution === null) {
      console.log(`  "${desired.query}" -> NAO ENCONTRADO no catalogo`);
      continue;
    }

    const slotLabel =
      resolution.slot === 'prefix' ? 'PREFIXO' : resolution.slot === 'suffix' ? 'SUFIXO' : 'INDETERMINADO';
    console.log(`  "${desired.query}" -> ${resolution.slot.toUpperCase()} (${slotLabel})`);
    console.log(
      `     tiers disponiveis no ilvl ${item.itemLevel}: [${resolution.availableTiers.map((t) => `T${t.tier}`).join(', ') || 'nenhum'}]`,
    );
    console.log(
      `     melhor tier: ${resolution.bestAvailableTier ?? 'n/d'} (requer ilvl ${resolution.requiredItemLevel ?? 'n/d'})`,
    );

    const odds = dataService.estimateOdds(
      resolution.definition.id,
      item.itemClass,
      item.itemLevel ?? 1,
      false,
    );
    console.log('     chance por moeda:');
    for (const o of odds.slice(0, 4)) {
      console.log(
        `       ${o.orb.padEnd(20)} ${(o.chance * 100).toFixed(2).padStart(6)}%  tier medio T${o.expectedTier}  custo ~${o.costInExalted} ex`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // PASSO 4 — o agente gera o plano
  // ---------------------------------------------------------------------
  heading('PASSO 4 — CraftAgent (tool do Vercel AI SDK: currentItem + targetGoal)');

  console.log('  Meta do jogador:');
  console.log(`    orcamento ....... ${CRAFT_TARGET.maxBudget ?? 'n/d'} ${CRAFT_TARGET.budgetCurrency}`);
  console.log(`    preservar mods .. ${CRAFT_TARGET.preserveExisting}`);
  for (const desired of CRAFT_TARGET.targetModifiers) {
    const range =
      desired.minValue !== null || desired.maxValue !== null
        ? ` (valor ${desired.minValue ?? '-'} a ${desired.maxValue ?? '-'})`
        : '';
    const obligation = desired.required ? 'obrigatorio' : 'opcional';
    console.log(`    - ${desired.query}${range} [${desired.slot}/${obligation}]`);
  }

  const result = await agent.planWithLlm(item, CRAFT_TARGET);

  heading('PLANO DE CRAFT GERADO');
  console.log(renderPlan(result.plan));
  console.log('');
  console.log('  --- Narrativa do agente ---');
  for (const line of result.narrative.split('\n')) {
    console.log(`  ${line}`);
  }

  heading('FINAL');
  console.log(`  Fonte do plano ....... ${result.source}`);
  console.log(`  Latencia do agente ... ${result.latencyMs} ms`);
  console.log(`  Passos de craft ...... ${result.plan.steps.length}`);
  console.log(`  Custo esperado ....... ${result.plan.cost.expectedTotal} ${result.plan.cost.currency}`);
  console.log(`  Risco de brick ....... ${(result.plan.risk.brickProbability * 100).toFixed(1)}%`);
  console.log(`\n${DIVIDER}\n`);

  hotkeys.dispose();
}

main().catch((error: unknown) => {
  console.error('\nFalha na simulacao:', error);
  process.exitCode = 1;
});