/** Ponte entre o main do Electron e a janela do overlay. */
import type { FeedbackDeliveryResult, FeedbackPayload } from './feedback/feedbackReport.js';

export interface OverlayHostApi {
  /** Esconde a janela sem encerrar o processo. */
  hide(): void;
  /** Mostra a janela e traz para frente. */
  show(): void;
  close(): void;
  /** Le a area de transferencia pelo processo main (sincronia real). */
  readClipboard(): Promise<ClipboardSnapshot>;
  /**
   * Config e snapshot trafegam como texto cru: o `ConfigManager` e a hidratacao
   * continuam donos da validacao, dos defaults e dos eventos, e so o I/O sai do
   * renderer. Vale para os dois porque o disco so existe no main.
   */
  readConfig(): Promise<string | null>;
  writeConfig(contents: string): Promise<void>;
  readDataSnapshot(): Promise<string | null>;
  writeDataSnapshot(contents: string): Promise<void>;
  /**
   * Registra o atalho global no main. O acelerador chega ja validado e
   * convertido pelo renderer; `null` libera o binding atual. Devolve o status
   * para que Settings avise quando o SO recusou a combinacao.
   */
  registerGlobalHotkey(accelerator: string | null): Promise<GlobalHotkeyStatus | null>;
  getHotkeyStatus(): Promise<GlobalHotkeyStatus>;
  /**
   * Assina o acionamento do atalho global. O main ja leu o clipboard e
   * entregou o texto; devolve a funcao de cancelamento.
   */
  onItemCaptured(handler: (payload: ItemCapturedPayload) => void): () => void;
  /** Abre uma URL no navegador do sistema. */
  openExternal(url: string): Promise<void>;
  /**
   * Envia uma linha de log ja formatada. O renderer roda com `sandbox: true`,
   * entao nao tem `node:fs` nem `electron-log`: o main e' quem escreve no disco
   * e quem decide rotacao. Fire-and-forget, porque um log que trava a UI
   * esperando o main e' pior que um log perdido.
   */
  writeLog(line: string): void;
  /** Ultimas linhas do arquivo de log, para o relatorio de feedback. */
  readLog(): Promise<string>;
  /**
   * Entrega o relatorio montado. O destino (webhook, issue, arquivo) e'
   * escolhido pelo main a partir do ambiente, entao o renderer nao consegue
   * apontar o envio para um host que a aplicacao nao configurou.
   */
  sendFeedback(payload: FeedbackPayload): Promise<FeedbackDeliveryResult>;
  /** Escuta o item parseado vindo do main (dev ou hotkey real). */
  onItemParsed(handler: (payload: { text: string; capturedAt: number }) => void): () => void;
}

export interface ClipboardSnapshot {
  readonly text: string;
  readonly capturedAt: number;
}

/** Texto capturado pelo atalho global, antes do parse. */
export interface ItemCapturedPayload {
  readonly text: string;
  readonly capturedAt: number;
  readonly accelerator: string;
}

export interface GlobalHotkeyStatus {
  readonly available: boolean;
  readonly registered: boolean;
  readonly accelerator: string | null;
  readonly detail: string;
}

declare global {
  interface Window {
    electron?: OverlayHostApi;
    overlayHost?: OverlayHostApi;
  }
}
