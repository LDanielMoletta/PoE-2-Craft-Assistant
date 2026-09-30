import { useEffect, useState, type ReactNode } from 'react';

/** Estado vazio / carregando, antes de capturar o primeiro item. */
export function EmptyState({
  title,
  hint,
  hotkeyLabel,
}: {
  readonly title: string;
  readonly hint: string;
  readonly hotkeyLabel?: string;
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm text-slate-300">{title}</p>
      {hotkeyLabel !== undefined && (
        <kbd className="rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200">
          {hotkeyLabel}
        </kbd>
      )}
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );
}

/** Painel rolavel generico, usado pelas secoes do overlay. */
export function Section({
  title,
  children,
  actions,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}): ReactNode {
  return (
    <section className="border-b border-slate-800">
      <div className="flex items-center justify-between px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Alternador compacto usado nas preferencias. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly description?: string;
}): ReactNode {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2">
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {description !== undefined && (
          <span className="block text-xs text-slate-500">{description}</span>
        )}
      </span>
      <input
        type="checkbox"
        className="h-4 w-4 accent-emerald-500"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    </label>
  );
}

/** Slider numerico com rotulo e valor atual. */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly suffix?: string;
  readonly onChange: (next: number) => void;
}): ReactNode {
  return (
    <label className="block px-4 py-2">
      <span className="flex items-baseline justify-between text-sm text-slate-200">
        <span>{label}</span>
        <span className="font-mono text-xs text-slate-300">
          {value}
          {suffix ?? ''}
        </span>
      </span>
      <input
        type="range"
        className="mt-1 w-full accent-emerald-500"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      />
    </label>
  );
}

/** Fecha o overlay. Fica separado porque Electron, browser e teste diferem. */
export function CloseButton({ onClose }: { readonly onClose: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Fechar overlay"
      className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
    >
      ✕
    </button>
  );
}

/** Botao de acao do plano (aplicar passo, refazer, cancelar). */
export function ActionButton({
  children,
  onClick,
  variant = 'default',
  disabled = false,
  title,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly variant?: 'default' | 'primary' | 'danger';
  readonly disabled?: boolean;
  readonly title?: string;
}): ReactNode {
  const tone: Readonly<Record<string, string>> = {
    default: 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700',
    primary: 'border-emerald-700 bg-emerald-800 text-emerald-50 hover:bg-emerald-700',
    danger: 'border-red-800 bg-red-900/60 text-red-100 hover:bg-red-800/60',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${tone[variant]}`}
    >
      {children}
    </button>
  );
}

/** True apos o primeiro render. Evita flash de estado vazio no Electron. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}
