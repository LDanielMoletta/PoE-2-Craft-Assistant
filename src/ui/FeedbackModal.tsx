import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import {
  FEEDBACK_KINDS,
  isValidContact,
  MAX_DESCRIPTION,
  type FeedbackDiagnostics,
  type FeedbackKind,
  type FeedbackSubmission,
  type FeedbackResult,
} from '../feedback/feedbackReport.js';
import { ActionButton } from './primitives.js';

/**
 * Modal de feedback.
 *
 * Casca do componente: quem sabe falar com o main e montar o `logText` e' o
 * host, via `onSubmit`. Aqui so o formulario, a validacao e a previa do que vai
 * sair da maquina - a previa existe porque o campo de anexar diagnostico e' a
 * unica decisao com consequencia de privacidade na tela, e o jogador precisa
 * ver o conteudo antes de marcar.
 */

export interface FeedbackModalProps {
  readonly diagnostics: FeedbackDiagnostics;
  readonly onSubmit: (submission: FeedbackSubmission) => Promise<FeedbackResult>;
  readonly onClose: () => void;
  /** Existe quando ha item analisado; sem ele, a caixa some. */
  readonly hasItem?: boolean;
  /** Nao ha log anexavel fora do Electron (dev no browser, teste). */
  readonly hasDiagnostics?: boolean;
  readonly submitLabel?: string;
}

export function FeedbackModal({
  diagnostics,
  onSubmit,
  onClose,
  hasItem = true,
  hasDiagnostics = true,
  submitLabel = 'Enviar',
}: FeedbackModalProps): ReactNode {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [description, setDescription] = useState('');
  const [attach, setAttach] = useState(false);
  const [contact, setContact] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<FeedbackResult | null>(null);

  const descriptionId = useId();
  const contactId = useId();
  const attachId = useId();

  const canAttach = hasItem && hasDiagnostics;
  const descriptionOk = description.trim().length > 0;
  const contactOk = isValidContact(contact);
  const canSubmit = descriptionOk && contactOk && !sending;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, sending]);

  // Sem item ou sem log nao ha o que anexar: manter a caixa marcada produziria
  // um relatorio que promete diagnostico e nao traz.
  useEffect(() => {
    if (!canAttach) setAttach(false);
  }, [canAttach]);

  const remaining = MAX_DESCRIPTION - description.length;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSending(true);
    setResult(null);
    try {
      setResult(await onSubmit({ kind, description, attachDiagnostics: attach, contact }));
    } catch (thrown) {
      setResult({
        ok: false,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    } finally {
      setSending(false);
    }
  };

  const attachmentHint = useMemo(() => {
    if (!hasDiagnostics) return 'Sem log disponível neste ambiente.';
    if (!hasItem) return 'Nenhum item analisado ainda.';
    return 'Inclui o texto do último item e as últimas entradas de log.';
  }, [hasDiagnostics, hasItem]);

  const preview = useMemo(() => {
    const firstLine = description.trim().split('\n')[0] ?? '';
    return [
      `${kind === 'bug' ? '[Bug]' : '[Ideia]'} ${firstLine.slice(0, 80)}`,
      `app ${diagnostics.appVersion} · ${diagnostics.platform} (${diagnostics.arch})`,
      attach ? 'anexos: texto do item + logs recentes' : 'anexos: nenhum',
    ].join('\n');
  }, [attach, description, diagnostics, kind]);

  return (
    <div className="flex h-full flex-col bg-slate-950/95 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <h1 className="text-sm font-semibold">Relatar problema ou ideia</h1>
        <ActionButton onClick={onClose} disabled={sending}>
          Fechar
        </ActionButton>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Tipo
          </legend>
          <div className="mt-1 flex gap-3">
            {(Object.keys(FEEDBACK_KINDS) as FeedbackKind[]).map((value) => (
              <label key={value} className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="feedback-kind"
                  className="accent-emerald-500"
                  checked={kind === value}
                  onChange={() => {
                    setKind(value);
                  }}
                />
                {FEEDBACK_KINDS[value]}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor={descriptionId} className="block text-sm text-slate-200">
            {kind === 'bug' ? 'O que aconteceu?' : 'O que você quer que exista?'}
          </label>
          <textarea
            id={descriptionId}
            value={description}
            maxLength={MAX_DESCRIPTION}
            rows={7}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            placeholder={
              kind === 'bug'
                ? 'Passos para reproduzir, o que esperava e o que aconteceu.'
                : 'Qual é o problema que isso resolveria no dia a dia.'
            }
            className="mt-1 w-full resize-y rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-emerald-600"
          />
          <p className={`mt-0.5 text-right text-[10px] ${remaining < 200 ? 'text-amber-400' : 'text-slate-600'}`}>
            {remaining}
          </p>
        </div>

        {canAttach && (
          <label htmlFor={attachId} className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              id={attachId}
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-emerald-500"
              checked={attach}
              onChange={(event) => {
                setAttach(event.target.checked);
              }}
            />
            <span>
              <span className="text-slate-200">Anexar texto do último item analisado e logs recentes</span>
              <span className="block text-xs text-slate-500">{attachmentHint}</span>
            </span>
          </label>
        )}

        <div>
          <label htmlFor={contactId} className="block text-sm text-slate-200">
            Contato <span className="text-xs text-slate-500">(opcional)</span>
          </label>
          <input
            id={contactId}
            type="text"
            value={contact}
            maxLength={120}
            onChange={(event) => {
              setContact(event.target.value);
            }}
            placeholder="Discord tag ou e-mail, se quiser retorno"
            className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-emerald-600"
          />
          {!contactOk && (
            <p className="mt-0.5 text-xs text-red-400">
              Sem espaços ou caracteres de URL: o campo vai para o texto da issue.
            </p>
          )}
        </div>

        <details className="rounded border border-slate-800 px-2 py-1">
          <summary className="cursor-pointer text-xs text-slate-400">Prévia do relatório</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] text-slate-500">
            {preview}
          </pre>
        </details>

        {result !== null && (
          <p
            role="status"
            className={`rounded border px-2 py-1.5 text-xs ${
              result.ok
                ? 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
                : 'border-red-900 bg-red-950/40 text-red-200'
            }`}
          >
            {result.message}
          </p>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-2">
        <ActionButton onClick={onClose} disabled={sending}>
          Cancelar
        </ActionButton>
        <ActionButton
          variant="primary"
          onClick={() => {
            void submit();
          }}
          disabled={!canSubmit}
          title={descriptionOk ? undefined : 'Descreva o problema antes de enviar'}
        >
          {sending ? 'Enviando…' : submitLabel}
        </ActionButton>
      </footer>
    </div>
  );
}
