import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, tool, type Tool } from 'ai';
import { z } from 'zod';

import {
  CraftPlanSchema,
  CraftTargetSchema,
  ItemSchema,
  type CraftPlan,
  type CraftTarget,
  type Item,
} from '../types/index.js';
import { PoeDataService } from '../scraper/poeDataService.js';
import type { ModsIndex } from '../scraper/dataHydration.js';
import { planCraft, analyzeCraft } from './craftPlanner.js';

export interface CraftAgentOptions {
  readonly dataService?: PoeDataService;
  /**
   * Base hidratada para comecar. O planner consulta o indice local antes de
   * qualquer rede ou chamada de LLM, entao injetar aqui e' o que torna a
   * primeira resposta instantanea.
   */
  readonly modsIndex?: ModsIndex | null;
  /** Chave da OpenAI. Sem ela, o agente roda apenas com o planner local. */
  readonly apiKey?: string | undefined;
  readonly model?: string;
  /** Quando true, o agente da resposta da LLM (usado apenas no modo interativo). */
  readonly verbose?: boolean;
}

/** Entrada canonica da tool: exatamente dois parametros, como pedido. */
export const craftToolInputSchema = z.object({
  currentItem: ItemSchema.describe('Item exatamente como veio do clipboard (Ctrl+C no jogo), ja parseado.'),
  targetGoal: CraftTargetSchema.describe('Objetivo do craft escolhido pelo jogador.'),
});

export type CraftToolInput = z.infer<typeof craftToolInputSchema>;

export interface CraftToolResult {
  readonly plan: CraftPlan;
  /** Descricao em texto pronta para o overlay. */
  readonly narrative: string;
}

/**
 * Tool do Vercel AI SDK com DOIS parametros: `currentItem` (o item que o jogador
 * deu com Alt+E) e `targetGoal` (os status que ele quer no item).
 *
 * O `execute` NAO inventa nada: chama o planner deterministico, que ja consultou
 * a PoeDataService (prefix ou suffix, tier minimo, chance por moeda). A LLM
 * recebe esses numeros e so os traduz para linguagem natural.
 */
export function createCraftPlanTool(options: CraftAgentOptions = {}): Tool<CraftToolInput, CraftToolResult> {
  const dataService = options.dataService ?? new PoeDataService();

  return tool({
    description: [
      'Calcula o caminho otimo de craft para um item do Path of Exile 2.',
      'Use sempre que o usuario enviar o texto de um item (Alt+E) e disser o que quer nele.',
      'Retorna a sequencia exata de moedas, a chance por moeda e o risco de brick.',
    ].join(' '),
    inputSchema: craftToolInputSchema,
    execute: async ({ currentItem, targetGoal }): Promise<CraftToolResult> => {
      const plan = await planCraft(currentItem as Item, targetGoal as CraftTarget, { dataService });
      const validated = CraftPlanSchema.parse(plan) as CraftPlan;
      return { plan: validated, narrative: renderPlan(validated) };
    },
  });
}

const SYSTEM_PROMPT = `Voce e o assistente de craft do Path of Exile 2, operando como um overlay.

REGRAS INEGOCIÁVEIS:
- Voce NAO decide as moedas. A tool \`craftPlan\` ja calculou. Sua funcao e explicar.
- Nunca invente numero de chance, custo ou tier que nao esteja no retorno da tool.
- Se a toolmarked um objetivo como "inviavel" ou "bloqueado", diga isso claramente e sugira a alternativa mais barata.
- Fale em portugues do Brasil, tom direto, sem enrolacao. Maximo 6 frases.
- Use o vocabulario do jogo: "slot", "prefixo", "sufixo", "brick", "Annull", "Regal", "tier".
- Se o custo estourar o orcamento, comece a resposta por esse alerta.
- Liste as moedas na ordem exata, uma por linha, no formato: \`1. <moeda> — <motivo>\`.
- Finalize sempre com uma linha de custo: \`Custo esperado: X ex (pior caso Y ex)\`.`;

export interface AgentRunResult {
  readonly plan: CraftPlan;
  readonly narrative: string;
  readonly source: 'llm' | 'heuristic';
  /** Resposta crua da LLM, quando houver. */
  readonly rawModelOutput: string | null;
  readonly latencyMs: number;
}

/**
 * Agente de craft.
 *
 * Com OPENAI_API_KEY: a LLM chama a tool e reescreve o plano em linguagem natural.
 * Sem a chave: o planner deterministico responde direto (usado em dev, CI e offline).
 */
export class CraftAgent {
  readonly #dataService: PoeDataService;
  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #verbose: boolean;
  readonly #tool: Tool<CraftToolInput, CraftToolResult>;

  constructor(options: CraftAgentOptions = {}) {
    this.#dataService = options.dataService ?? new PoeDataService({ modsIndex: options.modsIndex ?? null });
    this.#apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this.#model = options.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
    this.#verbose = options.verbose ?? false;
    this.#tool = createCraftPlanTool({ dataService: this.#dataService });
  }

  get hasLlm(): boolean {
    return typeof this.#apiKey === 'string' && this.#apiKey.length > 0;
  }

  get dataService(): PoeDataService {
    return this.#dataService;
  }

  /**
   * Troca a base de dados do agente em runtime. A hydration termina depois do
   * primeiro render, e o agente precisa ver a base nova sem ser reconstruido (o
   * `Tool` segura a referencia do servico).
   */
  useModsIndex(index: ModsIndex | null): void {
    this.#dataService.useModsIndex(index);
  }

  /** Versao sem LLM: so o planner. Util para testes deterministicos. */
  async planOnly(currentItem: Item, targetGoal: CraftTarget): Promise<CraftPlan> {
    return planCraft(currentItem, targetGoal, { dataService: this.#dataService });
  }

  /** Versao com LLM; cai no planner se nao houver chave ou se a chamada falhar. */
  async planWithLlm(currentItem: Item, targetGoal: CraftTarget): Promise<AgentRunResult> {
    const startedAt = performance.now();
    const baseline = await this.planOnly(currentItem, targetGoal);

    if (!this.hasLlm) {
      return {
        plan: baseline,
        narrative: renderPlan(baseline),
        source: 'heuristic',
        rawModelOutput: null,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }

    try {
      const openai = createOpenAI({ apiKey: this.#apiKey });
      const analysis = await analyzeCraft(currentItem, targetGoal, { dataService: this.#dataService });

      const result = await generateText({
        model: openai(this.#model),
        system: SYSTEM_PROMPT,
        tools: { craftPlan: this.#tool },
        stopWhen: stepCountIs(3),
        prompt: [
          'Jogador apertou Alt+E e o item abaixo esta sob o cursor.',
          '',
          'ITEM ATUAL:',
          JSON.stringify(currentItem, null, 2),
          '',
          'OBJETIVO DO CRAFT:',
          JSON.stringify(targetGoal, null, 2),
          '',
          'ANALISE PREVIA (slots livres, matches encontrados):',
          JSON.stringify(
            {
              slotBudget: analysis.slotBudget,
              protectedModifiers: analysis.protectedModifiers,
              resolutions: analysis.resolutions.map((r) => ({
                alvo: r.desired.query,
                slot: r.slot,
                definicao: r.definition?.name ?? null,
                tierDisponivel: r.definition?.tier ?? null,
                jaPresente: r.alreadyPresent?.text ?? null,
                viavel: r.feasible,
                observacao: r.reason,
              })),
            },
            null,
            2,
          ),
          '',
          'Chame a tool craftPlan com currentItem e targetGoal acima e depois explique o resultado ao jogador.',
        ].join('\n'),
      });

      const narrative = result.text.trim() || renderPlan(baseline);
      if (this.#verbose) {
        console.log(`[agent] modelo=${this.#model} tokens=${result.usage.totalTokens ?? 0}`);
      }

      return {
        plan: baseline,
        narrative,
        source: 'llm',
        rawModelOutput: result.text,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (this.#verbose) {
        console.warn(
          `[agent] LLM indisponivel (${error instanceof Error ? error.message : String(error)}); usando planner local.`,
        );
      }
      return {
        plan: baseline,
        narrative: renderPlan(baseline),
        source: 'heuristic',
        rawModelOutput: null,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
  }
}

/** Renderiza o plano no formato compacto do overlay (max. ~10 linhas). */
export function renderPlan(plan: CraftPlan): string {
  const lines: string[] = [];

  lines.push(plan.summary);

  if (plan.steps.length > 0) {
    lines.push('');
    lines.push('Passo a passo:');
    for (const step of plan.steps) {
      const pct = (step.successChance * 100).toFixed(1);
      const brick = step.brickChance > 0 ? ` | risco de brick ${(step.brickChance * 100).toFixed(0)}%` : '';
      lines.push(`  ${step.order}. ${step.orb} — ${step.rationale} [chance ${pct}%${brick}]`);
    }
  } else {
    lines.push('');
    lines.push('Nenhuma moeda e necessaria para os alvos informados.');
  }

  if (plan.protectedModifiers.length > 0) {
    lines.push('');
    lines.push(`Protegidos: ${plan.protectedModifiers.join(', ')}`);
  }

  for (const note of plan.notes) {
    lines.push(`! ${note}`);
  }

  return lines.join('\n');
}