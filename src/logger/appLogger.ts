/**
 * Logger do app, compartilhado entre o renderer e o CLI Node.
 *
 * O renderer roda com `sandbox: true` e nao tem `node:fs`, entao este modulo
 * nao escreve em arquivo: ele formata o registro e entrega para um `LogSink`.
 * Quem escreve no disco e' o processo main, via `log:write` no IPC. A mesma
 * separacao do `config.json` e do snapshot: o renderer formata, o main move
 * bytes.
 *
 * O arquivo e' a unica fonte para diagnostico de bug, entao duas garantias vem
 * antes de qualquer conveniencia:
 *
 *  1. Um logger nunca lanca. Um `sink` quebrado (disco cheio, IPC morto,
 *     arquivo bloqueado por antivirus) engoliria a excecao e derrubaria quem
 *     estava tentando logar - tipicamente o tratador de erro que ja esta em
 *     falha. O erro do sink vira uma linha no console e o registro se perde.
 *  2. Segredos nao entram no log. `OPENAI_API_KEY` e' lido por `process.env`
 *     erorado no `PoeDataService`, entao o caminho existe; a redacao tambem
 *     cobre Bearer e o padrao de chaves que aparece em query string.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  readonly app: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly electron?: string;
  /** 'main' | 'renderer' | 'node': de onde o registro saiu. */
  readonly scope: string;
}

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly context: LogContext;
  readonly fields?: LogFields;
  /** Stack do erro original, quando houve. */
  readonly stack?: string;
}

/** Destino dos registros. Nunca deve lancar. */
export interface LogSink {
  write(record: LogRecord): void;
}

export interface AppLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error?: unknown, fields?: LogFields): void;
  /** Registros recentes, do mais novo para o mais antigo. */
  recent(limit?: number): readonly LogRecord[];
  context(): LogContext;
}

/**
 * Segredos que nunca podem aparecer no arquivo. Os nomes sao comparados
 * sem caixa para nao depender de como o chamador escreveu a chave.
 */
const SECRET_KEY_RE =
  /(api[_-]?key|secret|token|password|passwd|authorization|auth|bearer|cookie|session|webhook)/i;

const REDACTED = '[redacted]';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** ISO-8601 com ms: ordenavel como texto e legivel por pessoa. */
export function formatTimestamp(at: Date = new Date()): string {
  return at.toISOString();
}

/**
 * Extrai uma mensagem legivel de qualquer valor lancado. `Error` tem `stack`;
 * o resto costuma ser `unknown` de um `catch`, entao `String` e' o piso.
 */
export function describeError(thrown: unknown): { readonly message: string; readonly stack?: string } {
  if (thrown instanceof Error) {
    return {
      message: `${thrown.name}: ${thrown.message}`,
      ...(thrown.stack === undefined ? {} : { stack: thrown.stack }),
    };
  }
  if (typeof thrown === 'string') return { message: thrown };
  try {
    return { message: JSON.stringify(thrown) ?? String(thrown) };
  } catch {
    // Objeto com ciclo ou BigInt: `String` ainda devolve algo utilizavel.
    return { message: String(thrown) };
  }
}

/**
 * Copia rasa dos campos, com valores truncados e chaves sensiveis redigidas.
 * O limite de tamanho evita que um payload inteiro de item ou o corpo de uma
 * resposta HTTP ocupe o arquivo e empurre o resto fora por rotacao.
 */
export function sanitizeFields(fields: LogFields | undefined, maxValueLength = 2000): LogFields | undefined {
  if (fields === undefined) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.length > maxValueLength ? `${value.slice(0, maxValueLength)}...[truncated]` : value;
      continue;
    }
    if (value === undefined) continue;
    if (value instanceof Error) {
      out[key] = describeError(value).message;
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      // Nao serializa objeto aninhado: um `Error` dentro de um array ou um
      // payload com cycle deixaria o log inteiro ilegivel.
      out[key] = safeStringify(value, maxValueLength);
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function safeStringify(value: unknown, maxLength: number): string {
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Aplica a redacao no texto do log. Complementa a redacao por chave: um caller
 * pode interpolar o segredo direto na mensagem (`"auth com ${key}"`), e ai o
 * nome do campo nao existe para ser checado.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
}

/**
 * Buffer circular em memoria.
 *
 * E' o que alimenta "logs recentes" no relatorio de bug. Precisa ser local e
 * sincrono: o anexo e montado no renderer, que nao tem disco, e a leitura
 * acontece no clique do botao.
 */
export function createMemorySink(capacity = 200): LogSink & { entries(): readonly LogRecord[] } {
  const buffer: LogRecord[] = [];

  return {
    write(record) {
      buffer.push(record);
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    },
    entries() {
      return [...buffer];
    },
  };
}

export function createConsoleSink(
  target: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>,
): LogSink {
  return {
    write(record) {
      const tail = record.stack ?? formatFields(record.fields);
      const line = `[${record.time}] ${record.level.toUpperCase()} (${record.scope}) ${record.message}`;
      const method = target[record.level];
      if (tail === undefined || tail === '') method(line);
      else method(`${line}\n${tail}`);
    },
  };
}

function formatFields(fields: LogFields | undefined): string {
  if (fields === undefined) return '';
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

export interface CreateLoggerOptions {
  readonly context: LogContext;
  readonly sinks?: readonly LogSink[];
  /** Nivel minimo; abaixo disso o registro nem e formatado. */
  readonly minLevel?: LogLevel;
  /** Segredos a redigir do texto. Sem isso so a redacao por chave se aplica. */
  readonly secrets?: readonly string[];
  readonly now?: () => Date;
}

export function createLogger(options: CreateLoggerOptions): AppLogger {
  const sinks = options.sinks ?? [];
  const minLevel = options.minLevel ?? 'info';
  const secrets = options.secrets ?? [];
  const now = options.now ?? ((): Date => new Date());
  const memory = createMemorySink();
  const threshold = LEVEL_RANK[minLevel];

  const emit = (level: LogLevel, message: string, fields?: LogFields, stack?: string): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const safeFields = sanitizeFields(fields);
    const record: LogRecord = {
      time: formatTimestamp(now()),
      level,
      scope: options.context.scope,
      message: redactText(message, secrets),
      context: options.context,
      ...(stack === undefined ? {} : { stack: redactText(stack, secrets) }),
      ...(safeFields === undefined ? {} : { fields: safeFields }),
    };

    memory.write(record);
    for (const sink of sinks) {
      // Um sink defeituoso nao pode derrubar quem esta tentando diagnosticar o
      // problema: no maximo perdemos este registro.
      try {
        sink.write(record);
      } catch (thrown) {
        // eslint-disable-next-line no-console
        console.error(`[logger] sink falhou: ${describeError(thrown).message}`);
      }
    }
  };

  return {
    debug: (message, fields) => {
      emit('debug', message, fields);
    },
    info: (message, fields) => {
      emit('info', message, fields);
    },
    warn: (message, fields) => {
      emit('warn', message, fields);
    },
    error: (message, error, fields) => {
      if (error === undefined) {
        emit('error', message, fields);
        return;
      }
      const described = describeError(error);
      emit('error', message, fields, described.stack ?? described.message);
    },
    recent(limit = 50) {
      return memory.entries().slice(-limit).reverse();
    },
    context() {
      return options.context;
    },
  };
}

/**
 * Contexto de diagnostico coletado do `process`. No renderer nao ha `process`,
 * entao quem monta o contexto passa o que consegue saber (versao do app vem do
 * package.json compilado).
 */
export function contextFromProcess(
  scope: string,
  extra: { readonly app: string; readonly version: string; readonly electron?: string },
): LogContext {
  return {
    app: extra.app,
    version: extra.version,
    platform: process.platform,
    arch: process.arch,
    ...(extra.electron === undefined ? {} : { electron: extra.electron }),
    scope,
  };
}

/** Serializa no formato de uma linha, que e' o que o main grava em app.log. */
export function formatLogLine(record: LogRecord): string {
  const parts = [record.time, record.level.toUpperCase(), record.scope, record.message];
  if (record.fields !== undefined) parts.push(formatFields(record.fields));
  if (record.stack !== undefined) parts.push(record.stack);
  return parts
    .map((part) => String(part).replace(/\s*\n\s*/g, ' | '))
    .join(' ');
}
