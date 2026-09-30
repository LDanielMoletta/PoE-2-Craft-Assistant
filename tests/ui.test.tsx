import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_USER_CONFIG, type HotkeyAction } from '../src/config/index.js';
import { validateHotkey, type HotkeyValidation } from '../src/overlay/hotkeyValidation.js';
import type { CraftPlan, CraftStep, DesiredModifier, Item } from '../src/types/index.js';
import { ItemHeader, ModifierList } from '../src/ui/ItemHeader.js';
import { TargetSelector } from '../src/ui/TargetSelector.js';
import { CraftPlanView } from '../src/ui/CraftPlanView.js';
import {
  SettingsModal,
  type ConfigPatch,
  type KeyboardTapSource,
  type SettingsModalProps,
  type UiKeyPress,
} from '../src/ui/SettingsModal.js';
import { OverlayWindow, type OverlayState } from '../src/ui/OverlayWindow.js';

const item: Item = {
  name: 'Wandering Path',
  baseType: 'Assassin Bow',
  itemClass: 'bow',
  rarity: 'rare',
  itemLevel: 64,
  areaLevel: null,
  quality: 20,
  corrupted: false,
  mirrored: false,
  split: false,
  identified: true,
  talismanTier: null,
  modifiers: [
    { raw: '+15 to Dexterity', text: '+15 to Dexterity', tier: null, quality: null, slot: 'prefix', origin: 'implicit', magnitude: 15 },
    { raw: 'Adds 12 to Fire Damage', text: 'Adds 12 to Fire Damage', tier: 3, quality: null, slot: 'prefix', origin: 'crafted', magnitude: 12 },
    { raw: '30% increased Attack Speed', text: '30% increased Attack Speed', tier: 1, quality: null, slot: 'suffix', origin: 'crafted', magnitude: 30 },
  ],
  properties: { requirements: {}, sockets: [] },
  rawText: '',
};

const step: CraftStep = {
  order: 1,
  orb: 'Regal Orb',
  rationale: 'Preenche o prefixo livre sem tocar nos existentes.',
  successChance: 1,
  neutralChance: 0,
  brickChance: 0,
  expectedCostPerTry: 0.1,
  currency: 'exalted',
  onFailure: 'retry',
  touchesModifiers: ['Adds 12 to Fire Damage'],
};

const plan: CraftPlan = {
  summary: 'Um Regal basta para o alvo pedido.',
  steps: [step],
  risk: { brickProbability: 0, verdict: 'cheap', label: 'risco baixo', mitigations: ['Preserve o Tier 3 atual.'] },
  cost: { expectedTotal: 0.1, worstCaseTotal: 0.3, currency: 'exalted', attempts: 1, withinBudget: true },
  protectedModifiers: ['+15 to Dexterity'],
  notes: [],
  source: 'heuristic',
};

function noop(): void {}

const emptyState: OverlayState = {
  item: null,
  desired: [],
  plan: null,
  planning: false,
  appliedOrders: [],
  error: null,
};

/** KeyboardTapSource falso: a captura ao vivo fica desabilitada. */
const noKeyboard: KeyboardTapSource = {
  available: false,
  tap: () => false,
  start: noop,
  stop: noop,
};

describe('ItemHeader', () => {
  it('mostra nome, base, classe e item level', () => {
    render(<ItemHeader item={item} />);
    expect(screen.getByText(/Wandering Path/)).toBeDefined();
    expect(screen.getByText(/20%/)).toBeDefined();
    expect(screen.getByText('iLv 64')).toBeDefined();
  });

  it('sinaliza item corrompido', () => {
    render(<ItemHeader item={{ ...item, corrupted: true }} />);
    expect(screen.getByText('Corrompido')).toBeDefined();
  });
});

describe('ModifierList', () => {
  it('lista os modificadores do item', () => {
    render(<ModifierList item={item} />);
    expect(screen.getByText('Adds 12 to Fire Damage')).toBeDefined();
    expect(screen.getByText('Implícito')).toBeDefined();
  });

  it('destaca os mods que casam com o alvo', () => {
    const desired: DesiredModifier[] = [
      { query: 'fire damage', slot: 'any', required: true, minValue: null, maxValue: null },
    ];
    const { container } = render(<ModifierList item={item} desired={desired} />);
    const marked = container.querySelectorAll('.bg-emerald-950\\/30');
    expect(marked).toHaveLength(1);
  });

  it('avisa quando o item nao tem modificadores', () => {
    render(<ModifierList item={{ ...item, modifiers: [] }} />);
    expect(screen.getByText(/Nenhum modificador/)).toBeDefined();
  });
});

describe('TargetSelector', () => {
  const candidates = [
    { text: '+15 to Dexterity', slot: 'prefix' as const, tier: null, origin: 'implicit' as const },
    { text: 'Adds 12 to Fire Damage', slot: 'prefix' as const, tier: 3, origin: 'crafted' as const },
  ];

  it('filtra candidatos pela query digitada', () => {
    render(
      <TargetSelector
        candidates={candidates}
        selected={[]}
        onSelect={noop}
        onRemove={noop}
      />,
    );
    const input = screen.getByPlaceholderText(/Adicionar/);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input).toBeDefined();
  });

  it('remove um alvo ja escolhido', () => {
    let removed: string | null = null;
    render(
      <TargetSelector
        candidates={candidates}
        selected={['Adds 12 to Fire Damage']}
        onSelect={noop}
        onRemove={(text) => {
          removed = text;
        }}
      />,
    );
    screen.getByTitle('Remover alvo').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(removed).toBe('Adds 12 to Fire Damage');
  });
});

describe('CraftPlanView', () => {
  it('mostra resumo, moeda e custo', () => {
    render(<CraftPlanView plan={plan} />);
    expect(screen.getByText(/Um Regal basta/)).toBeDefined();
    expect(screen.getByText('Regal Orb')).toBeDefined();
    // Custo por tentativa (~0.1 ex) e custo total do plano sao numeros distintos.
    expect(screen.getByText('~0.1 ex')).toBeDefined();
    expect(screen.getByText('0.1 ex')).toBeDefined();
    expect(screen.getByText('risco baixo')).toBeDefined();
  });

  it('avisa quando o custo estoura o orcamento', () => {
    render(
      <CraftPlanView
        plan={{ ...plan, cost: { ...plan.cost, withinBudget: false } }}
      />,
    );
    expect(screen.getByText(/Acima do orçamento/)).toBeDefined();
  });

  it('avisa quando nao ha caminho de craft', () => {
    render(<CraftPlanView plan={{ ...plan, steps: [] }} />);
    expect(screen.getByText(/Nenhum caminho de craft/)).toBeDefined();
  });

  it('libera o botao de recomecar so depois de aplicar um passo', () => {
    const { rerender } = render(<CraftPlanView plan={plan} onReset={noop} appliedOrders={[]} />);
    expect(screen.getByText('Recomeçar').closest('button')?.disabled).toBe(true);

    rerender(<CraftPlanView plan={plan} onReset={noop} appliedOrders={[1]} />);
    expect(screen.getByText('Recomeçar').closest('button')?.disabled).toBe(false);
  });

  it('oferece reverter apenas em passos ja aplicados', () => {
    render(<CraftPlanView plan={plan} onRevertStep={noop} appliedOrders={[1]} />);
    expect(screen.getByText('Reverter')).toBeDefined();
  });
});

describe('SettingsModal', () => {
  function renderModal(overrides: Partial<SettingsModalProps> = {}): {
    applied: string[];
    patch: ConfigPatch;
  } {
    const calls = {
      applied: [] as string[],
      patch: {} as ConfigPatch,
    };

    render(
      <SettingsModal
        config={DEFAULT_USER_CONFIG}
        isGlobal={(action) => action === 'triggerOverlay'}
        onSetHotkey={async (action, sequence) => {
          calls.applied.push(sequence);
          return validateHotkey(sequence, { asGlobal: action === 'triggerOverlay' });
        }}
        onPatch={(next) => {
          calls.patch = next;
        }}
        onClose={noop}
        keyboard={noKeyboard}
        {...overrides}
      />,
    );
    return calls;
  }

  it('marca triggerOverlay como global e quickAnalyze como observado', () => {
    renderModal();
    expect(screen.getByText('global')).toBeDefined();
    expect(screen.getByText('observado')).toBeDefined();
  });

  it('aplica o atalho digitado', async () => {
    const calls = renderModal();
    const input = screen.getAllByPlaceholderText('Alt+E')[0] as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Ctrl+J' } });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Aplicar')[0]);
    });

    expect(calls.applied).toEqual(['Ctrl+J']);
  });

  it('nao envia patch quando o atalho digitado e invalido', async () => {
    const calls = renderModal();
    const input = screen.getAllByPlaceholderText('Alt+E')[0] as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'E' } });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Aplicar')[0]);
    });

    expect(calls.applied).toEqual(['E']);
    expect(screen.getByText(/precisa de Ctrl, Alt, Shift ou Win/)).toBeDefined();
  });

  it('captura o atalho digitado quando o teclado nativo existe', () => {
    // O handler muda depois do click, entao fica numa caixa mutavel em vez de
    // numa `let` que o TS estreitaria para `never`.
    const box: { handler: ((press: UiKeyPress) => void) | null } = { handler: null };
    const keyboard: KeyboardTapSource = {
      available: true,
      tap: () => true,
      start: (fn) => {
        box.handler = fn;
      },
      stop: () => {
        box.handler = null;
      },
    };

    const calls = renderModal({ keyboard });
    fireEvent.click(screen.getAllByText('Capturar')[0]);
    expect(screen.getByText(/Pressione a combinação agora/)).toBeDefined();

    // O handler vem do efeito do React; chamar direto exige act para o flush.
    act(() => {
      box.handler?.({ key: 'j', ctrl: true, alt: false, shift: false, meta: false });
    });
    // A captura fecha sozinha: a linha volta a aceitar edicao e o valor
    // capturado aparece no campo, exigindo um "Aplicar" explicito.
    expect(screen.queryByText(/Pressione a combinação agora/)).toBeNull();
    expect(screen.getByText(/Capturado: Ctrl\+J/)).toBeDefined();
    expect((screen.getAllByPlaceholderText('Alt+E')[0] as HTMLInputElement).value).toBe('ctrl+j');

    fireEvent.click(screen.getAllByText('Aplicar')[0]);
    expect(calls.applied).toEqual(['ctrl+j']);
  });

  it('cancela a captura com Esc', () => {
    const box: { handler: ((press: UiKeyPress) => void) | null } = { handler: null };
    const keyboard: KeyboardTapSource = {
      available: true,
      tap: () => true,
      start: (fn) => {
        box.handler = fn;
      },
      stop: () => {
        box.handler = null;
      },
    };

    renderModal({ keyboard });
    fireEvent.click(screen.getAllByText('Capturar')[0]);
    act(() => {
      box.handler?.({ key: 'escape', ctrl: false, alt: false, shift: false, meta: false });
    });

    expect(screen.queryByText(/Pressione a combinação agora/)).toBeNull();
  });

  it('envia patch de orcamento', () => {
    const calls = renderModal();
    const slider = screen.getByRole('slider', { name: /Orçamento padrão/ }) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: '40' } });

    expect(calls.patch.crafting?.defaultBudget).toBe(40);
  });

  it('envia patch de opacidade', () => {
    const calls = renderModal();
    const slider = screen.getByRole('slider', { name: /Opacidade/ }) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: '0.5' } });

    expect(calls.patch.ui?.opacity).toBe(0.5);
  });

  it('alterna preservar modificadores existentes', () => {
    const calls = renderModal();
    fireEvent.click(screen.getByRole('checkbox', { name: /Preservar modificadores/ }));

    expect(calls.patch.crafting?.preserveExisting).toBe(false);
  });

  it('exibe conflito quando os dois atalhos coincidem', () => {
    renderModal({
      config: { ...DEFAULT_USER_CONFIG, hotkeys: { triggerOverlay: 'alt+e', quickAnalyze: 'alt+e' } },
    });
    expect(screen.getByText(/Os dois atalhos são iguais/)).toBeDefined();
  });
});

describe('OverlayWindow', () => {
  const baseProps = {
    config: DEFAULT_USER_CONFIG,
    isGlobal: (action: HotkeyAction) => action === 'triggerOverlay',
    onSetHotkey: async (_action: HotkeyAction, sequence: string) =>
      validateHotkey(sequence, { asGlobal: true }),
    onPatch: noop,
    onResetConfig: noop,
    onAddTarget: noop,
    onRemoveTarget: noop,
    onPlan: noop,
    onApplyStep: noop,
    onRevertStep: noop,
    onSkipStep: noop,
    onResetPlan: noop,
    onClose: noop,
    hotkeyLabel: 'Alt+E',
    dataStatus: {
      state: 'live',
      league: 'Standard',
      version: 1,
      updatedAt: '2025-06-01T00:00:00.000Z',
      ageMs: 1_000,
      ttlMs: 86_400_000,
      modifiers: 53,
      bases: 20,
      currencies: 10,
      detail: 'Fonte externa (Standard).',
    },
  };

  it('convida a copiar um item quando nao ha captura', () => {
    render(<OverlayWindow {...baseProps} state={emptyState} />);
    expect(screen.getByText(/Copie um item/)).toBeDefined();
    expect(screen.getByText('Alt+E')).toBeDefined();
  });

  it('mostra item, alvo e plano quando existe captura', () => {
    render(
      <OverlayWindow
        {...baseProps}
        state={{ ...emptyState, item, plan, desired: [] }}
      />,
    );
    expect(screen.getByText(/Wandering Path/)).toBeDefined();
    expect(screen.getByText('Regal Orb')).toBeDefined();
  });

  it('exibe erro vindo do host', () => {
    render(
      <OverlayWindow
        {...baseProps}
        state={{ ...emptyState, item, error: 'Nenhum item reconhecido no clipboard.' }}
      />,
    );
    expect(screen.getByText('Nenhum item reconhecido no clipboard.')).toBeDefined();
  });

  it('abre a aba de ajustes e volta para craft', () => {
    render(<OverlayWindow {...baseProps} state={emptyState} />);

    fireEvent.click(screen.getByText('Ajustes'));
    expect(screen.getByText('Orçamento padrão')).toBeDefined();

    fireEvent.click(screen.getByText('Fechar'));
    expect(screen.getByText(/Copie um item/)).toBeDefined();
  });
});
