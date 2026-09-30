import {
  createConsoleSink,
  createLogger,
  type AppLogger,
  type LogContext,
  type LogRecord,
  type LogSink,
} from './appLogger.js';

/**
 * Logger do renderer.
 *
 * Alem de `log()` e `error()`, instala os tratadores globais de `window`:
 * `error` para excecao nao lancada e `unhandledrejection` para promessa
 * rejeitada sem catch. Sem isso o unico sintoma de um crash no overlay e' uma
 * janela em branco, que nao deixa nenhum rastro para colar num bug report.
 *
 * O `preventDefault` no `error` impede o Chromium de mostrar o dialogo nativo de
 * "Aw, Snap" por cima do jogo: o registro vai para o arquivo e o overlay
 * continua no lugar, que e' o que o jogador espera.
 */

export interface RendererLogger extends AppLogger {
  /** Instala `window.onerror` / `unhandledrejection`. Idempotente. */
  installGlobalHandlers(): void;
  uninstallGlobalHandlers(): void;
}

export interface RendererHostBridge {
  writeLog(line: string): void;
}

function bridgeSink(host: RendererHostBridge): LogSink {
  return {
    write(record) {
      host.writeLog(formatInline(record));
    },
  };
}

/**
 * Linha unica com o JSON do registro. O main grava a linha como veio: assim o
 * arquivo tem um evento por linha, e o renderer nao precisa conhecer o formato
 * do arquivo que o main escreve.
 */
function formatInline(record: LogRecord): string {
  return JSON.stringify({
    time: record.time,
    level: record.level,
    scope: record.scope,
    message: record.message,
    context: record.context,
    ...(record.fields === undefined ? {} : { fields: record.fields }),
    ...(record.stack === undefined ? {} : { stack: record.stack }),
  });
}

export function createRendererLogger(options: {
  readonly context: LogContext;
  readonly host?: RendererHostBridge | undefined;
  readonly minLevel?: 'debug' | 'info' | 'warn' | 'error';
  readonly console?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> | undefined;
  readonly now?: () => Date;
}): RendererLogger {
  const sinks: LogSink[] = [createConsoleSink(options.console ?? console)];
  if (options.host !== undefined) sinks.push(bridgeSink(options.host));

  const logger = createLogger({
    context: options.context,
    sinks,
    ...(options.minLevel === undefined ? {} : { minLevel: options.minLevel }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let installed = false;
  const onError = (event: ErrorEvent): void => {
    logger.error(`uncaught: ${event.message}`, event.error ?? new Error(event.message), {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
    event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    logger.error('unhandledrejection', event.reason);
    event.preventDefault();
  };

  return {
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    recent: logger.recent,
    context: logger.context,
    installGlobalHandlers() {
      if (installed || typeof window === 'undefined') return;
      installed = true;
      window.addEventListener('error', onError);
      window.addEventListener('unhandledrejection', onRejection);
      logger.info('renderer pronto', { url: location.href });
    },
    uninstallGlobalHandlers() {
      if (!installed || typeof window === 'undefined') return;
      installed = false;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    },
  };
}
