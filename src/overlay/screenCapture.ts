export interface ScreenBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface IScreenCapture {
  /** Captura a tela inteira e devolve PNG em base64. */
  captureFullScreen(): Promise<string>;
  /** Rectangulo do item sob o cursor, para o overlay desenhar em volta. */
  detectItemBounds(): Promise<ScreenBounds | null>;
}

/**
 * Captura simulada para dev/testes: devolve um PNG 1x1 transparente
 * e um retangulo fixo, para o fluxo do overlay rodar sem display.
 */
export class SimulatedScreenCapture implements IScreenCapture {
  readonly #png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  async captureFullScreen(): Promise<string> {
    return this.#png1x1;
  }

  async detectItemBounds(): Promise<ScreenBounds | null> {
    return { x: 640, y: 360, width: 320, height: 180 };
  }
}
