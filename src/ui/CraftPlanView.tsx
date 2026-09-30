import type { ReactNode } from 'react';

import type { CraftPlan, CraftStep } from '../types/index.js';
import { RISK_COLOR, formatCurrency, formatPercent } from './itemView.js';
import { ActionButton } from './primitives.js';

/** Um passo do plano: moeda, chance, custo e o que ela toca. */
export function CraftStepRow({
  step,
  applied = false,
  onApply,
  onRevert,
  onSkip,
}: {
  readonly step: CraftStep;
  readonly applied?: boolean;
  readonly onApply?: (step: CraftStep) => void;
  readonly onRevert?: (step: CraftStep) => void;
  readonly onSkip?: (step: CraftStep) => void;
}): ReactNode {
  const brick = step.brickChance;

  return (
    <li className={`border-b border-slate-800/80 px-4 py-2 ${applied ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[10px] text-slate-300">
          {step.order}
        </span>
        <span className="truncate text-sm font-medium text-slate-100">{step.orb}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-slate-400">
          ~{formatCurrency(step.expectedCostPerTry, step.currency)}
        </span>
      </div>

      <p className="mt-1 pl-7 text-xs text-slate-400">{step.rationale}</p>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-7 text-[11px] text-slate-500">
        <span className="text-emerald-400">{formatPercent(step.successChance)} acerta</span>
        {step.neutralChance > 0 && <span>{formatPercent(step.neutralChance)} neutro</span>}
        {brick > 0 && <span className="text-orange-400">{formatPercent(brick)} brick</span>}
        <span>
          falha:{' '}
          {step.onFailure === 'retry' ? 'tentar de novo' : step.onFailure === 'revert' ? 'reverter' : 'parar'}
        </span>
      </div>

      {step.touchesModifiers.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1 pl-7">
          {step.touchesModifiers.map((mod) => (
            <li
              key={mod}
              className="rounded bg-slate-800/70 px-1.5 py-0.5 text-[10px] text-slate-400"
            >
              {mod}
            </li>
          ))}
        </ul>
      )}

      {(onApply !== undefined || onRevert !== undefined || onSkip !== undefined) && (
        <div className="mt-2 flex gap-1.5 pl-7">
          {onApply !== undefined && (
            <ActionButton variant="primary" onClick={() => { onApply(step); }}>
              Aplicar
            </ActionButton>
          )}
          {onRevert !== undefined && (
            <ActionButton onClick={() => { onRevert(step); }} title="Desfazer esta aplicação">
              Reverter
            </ActionButton>
          )}
          {onSkip !== undefined && (
            <ActionButton onClick={() => { onSkip(step); }} title="Pular este passo">
              Pular
            </ActionButton>
          )}
        </div>
      )}
    </li>
  );
}

/** Plano completo: resumo, passos, custo e risco. */
export function CraftPlanView({
  plan,
  appliedOrders = [],
  onApplyStep,
  onRevertStep,
  onSkipStep,
  onReplan,
  onReset,
}: {
  readonly plan: CraftPlan;
  readonly appliedOrders?: readonly number[];
  readonly onApplyStep?: (step: CraftStep) => void;
  readonly onRevertStep?: (step: CraftStep) => void;
  readonly onSkipStep?: (step: CraftStep) => void;
  readonly onReplan?: () => void;
  readonly onReset?: () => void;
}): ReactNode {
  const applied = new Set(appliedOrders);
  const remaining = plan.steps.filter((step) => !applied.has(step.order));

  return (
    <div className="flex flex-col">
      {plan.summary.length > 0 && (
        <div className="border-b border-slate-800 px-4 py-2">
          <p className="text-sm text-slate-200">{plan.summary}</p>
          {plan.protectedModifiers.length > 0 && (
            <p className="mt-1 text-[11px] text-slate-500">
              Protegidos: {plan.protectedModifiers.join(', ')}
            </p>
          )}
        </div>
      )}

      {plan.steps.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-500">
          Nenhum caminho de craft encontrado com as restrições atuais.
        </p>
      ) : (
        <ol className="list-none">
          {plan.steps.map((step) => (
            <CraftStepRow
              key={step.order}
              step={step}
              applied={applied.has(step.order)}
              onApply={onApplyStep}
              onRevert={applied.has(step.order) ? onRevertStep : undefined}
              onSkip={onSkipStep}
            />
          ))}
        </ol>
      )}

      <div className="grid grid-cols-2 gap-x-3 border-b border-slate-800 px-4 py-2 text-xs">
        <div>
          <span className="text-slate-500">Custo esperado</span>
          <p className="font-mono text-slate-200">
            {formatCurrency(plan.cost.expectedTotal, plan.cost.currency)}
          </p>
        </div>
        <div>
          <span className="text-slate-500">Pior caso</span>
          <p className="font-mono text-slate-200">
            {formatCurrency(plan.cost.worstCaseTotal, plan.cost.currency)}
          </p>
        </div>
        <div>
          <span className="text-slate-500">Chance de brick</span>
          <p className={`font-mono ${RISK_COLOR[plan.risk.verdict]}`}>
            {formatPercent(plan.risk.brickProbability)}
          </p>
        </div>
        <div>
          <span className="text-slate-500">Veredito</span>
          <p className={RISK_COLOR[plan.risk.verdict]}>{plan.risk.label}</p>
        </div>
      </div>

      {plan.cost.withinBudget === false && (
        <p className="border-b border-slate-800 bg-red-950/40 px-4 py-1.5 text-xs text-red-300">
          Acima do orçamento definido.
        </p>
      )}

      {plan.risk.mitigations.length > 0 && (
        <ul className="border-b border-slate-800 px-4 py-2 text-[11px] text-slate-400">
          {plan.risk.mitigations.map((tip) => (
            <li key={tip}>• {tip}</li>
          ))}
        </ul>
      )}

      {plan.notes.length > 0 && (
        <ul className="border-b border-slate-800 px-4 py-2 text-[11px] text-slate-500">
          {plan.notes.map((note) => (
            <li key={note}>• {note}</li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center gap-1.5 px-4 py-2">
        {onReplan !== undefined && (
          <ActionButton onClick={onReplan} disabled={remaining.length === plan.steps.length}>
            Refazer plano
          </ActionButton>
        )}
        {onReset !== undefined && (
          <ActionButton variant="danger" onClick={onReset} disabled={applied.size === 0}>
            Recomeçar
          </ActionButton>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-600">
          {plan.source === 'llm' ? 'agente LLM' : 'heurística'}
        </span>
      </div>
    </div>
  );
}
