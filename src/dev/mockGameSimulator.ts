import process from 'node:process';
import readline from 'node:readline';

/**
 * Simulador de jogo para teste visual do overlay.
 *
 * O simulador envia o texto do item ao servidor HTTP de desenvolvimento do
 * Electron, que atualiza o clipboard e encaminha o texto ao renderer.
 *
 * Uso:
 *   pnpm dev:mock                                  # loop com todos os itens
 *   pnpm dev:mock -- --once --index=1              # so o Peitoral Raro
 *   pnpm dev:mock -- --dry-run                    # so imprime, sem GUI
 */

export interface MockItem {
  readonly label: string;
  readonly text: string;
}

export interface MockGameOptions {
  /** Intervalo entre itens no modo loop, em ms. */
  readonly intervalMs: number;
  /** Indice inicial em `MOCK_ITEMS`. */
  readonly startIndex: number;
  readonly loop: boolean;
  /** So imprime, nao envia ao SO. */
  readonly dryRun: boolean;
}

/**
 * Itens no formato exato que o jogo entrega ao copiar: `Item Class:` /
 * `Rarity:` / nome / base, e cada secao separada por `--------`. O `implicit`
 * no fim da linha e o que o parser usa para diferenciar rollout de base.
 */
export const MOCK_ITEMS: readonly MockItem[] = [
  {
    label: 'Wand Magica (embutido + explicito)',
    text: [
      'Item Class: Wands',
      'Rarity: Magic',
      'Sparking Wand',
      'Wand of the Frostweaver',
      '--------',
      'Physical Damage: 12 to 26',
      'Critical Strike Chance: 7.00%',
      '--------',
      'Requirements:',
      'Level: 25',
      'Int: 65',
      '--------',
      'Sockets: G-G',
      '--------',
      'Item Level: 31',
      '--------',
      '+9 to Accuracy Rating (implicit)',
      '--------',
      '+11 to Maximum Mana (implicit)',
      '--------',
      'Adds 4 to 9 Lightning Damage to Attacks',
      '--------',
      '+18% increased Cast Speed',
      '--------',
      '+1 to Level of all Spell Skill Gems',
    ].join('\n'),
  },
  {
    label: 'Peitoral Raro (dois slots, risco de brick)',
    text: [
      'Item Class: Body Armours',
      'Rarity: Rare',
      'Wandering Path',
      'Crackling Coat',
      '--------',
      'Energy Shield: 220',
      '--------',
      'Requirements:',
      'Level: 45',
      'Str: 90',
      'Dex: 90',
      'Int: 90',
      '--------',
      'Sockets: S S',
      '--------',
      'Item Level: 64',
      '--------',
      '+40 to maximum Life (implicit)',
      '--------',
      '+15% to all Elemental Resistances (implicit)',
      '--------',
      '+20% increased Fire Resistance',
      '--------',
      'Adds 12 to 24 Fire Damage to Attacks',
      '--------',
      '+2 to Level of all Fire Skill Gems',
      '--------',
      '+420 to Armour',
    ].join('\n'),
  },
  {
    label: 'Anel Normal (sem mod, exercita o caminho vazio)',
    text: [
      'Item Class: Rings',
      'Rarity: Normal',
      '',
      'Iron Ring',
      '--------',
      'Requirements:',
      'Level: 20',
      'Str: 40',
      '--------',
      'Item Level: 20',
      '--------',
      '+10 to maximum Life',
    ].join('\n'),
  },
];

/**
 * Faz POST HTTP para o servidor dev do Electron (porta 5174).
 * Payload: { rawItem: string }. Sucesso: { success: true }.
 */
export async function injectItemWithRetry(text: string): Promise<boolean> {
  console.log('[MOCK] Conectando ao Electron na porta 5174...');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch('http://localhost:5174/inject-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawItem: text }),
      });
      if (response.status === 200) {
        const data: unknown = await response.json();
        if (typeof data === 'object' && data !== null && 'success' in data && data.success === true) {
          console.log('[MOCK] Item enviado com sucesso!');
          return true;
        }
      }
    } catch {
      // O Electron pode ainda estar iniciando; a proxima tentativa e' limitada.
    }
    if (attempt < 9) await sleep(500);
  }
  return false;
}

export async function runMockGame(options: MockGameOptions): Promise<void> {
  console.log(`[mock] ${MOCK_ITEMS.length} itens`);
  if (options.dryRun) console.log('[mock] dry-run: nada sera enviado ao SO');

  let index = options.startIndex;
  for (let round = 0; ; round += 1) {
    const item = MOCK_ITEMS[index % MOCK_ITEMS.length];
    if (item === undefined) break;

    console.log(`[mock] ${String(round + 1).padStart(3, ' ')} ${item.label}`);
    if (!process.argv.includes('--no-wait')) {
      await waitForEnter('[mock] Pressione ENTER para enviar este item (ou Ctrl+C para sair)... ');
    }
    if (options.dryRun) {
      console.log('dry-run: nao enviados ao SO');
    } else {
      const ok = await injectItemWithRetry(item.text);
      if (!ok) {
        console.log('[MOCK] Falha ao conectar ao Electron apos 10 tentativas.');
      }
    }

    index += 1;
    if (!options.loop) return;

    if (process.argv.includes('--no-wait')) {
      await sleep(options.intervalMs);
    }
  }
}

/** Aguarda o usuario pressionar ENTER no terminal usando readline (compativel com pipes/concurrently). */
function waitForEnter(promptText: string = '[mock] Pressione ENTER para o proximo item (ou Ctrl+C para sair)... '): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

function parseArgs(argv: readonly string[]): MockGameOptions {
  const flag = (name: string): string | null => {
    const found = argv.find((value) => value.startsWith(`--${name}=`));
    return found === undefined ? null : found.slice(name.length + 3);
  };
  const number = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} nao e' numero: ${raw}`);
    return parsed;
  };

  const startIndex = number('index', 0);
  if (startIndex < 0 || startIndex >= MOCK_ITEMS.length) {
    throw new Error(`--index precisa estar entre 0 e ${String(MOCK_ITEMS.length - 1)}`);
  }

  return {
    intervalMs: number('interval', 4000),
    startIndex,
    loop: !argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Aguarda o usuario pressionar ENTER no terminal usando readline (compativel com pipes/concurrently). */

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].includes('mockGameSimulator');

if (invokedDirectly) {
  try {
    await runMockGame(parseArgs(process.argv.slice(2)));
  } catch (thrown) {
    console.error(`[mock] ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    process.exitCode = 1;
  }
}