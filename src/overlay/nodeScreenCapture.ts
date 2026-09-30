import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  SimulatedScreenCapture,
  type IScreenCapture,
  type ScreenBounds,
} from './screenCapture.js';

const execFileAsync = promisify(execFile);

export type { IScreenCapture, ScreenBounds };

/**
 * Captura de tela do Windows usando .NET via PowerShell.
 *
 * Em producao (Electron/Tauri) este e' substituido por `desktopCapturer`
 * ou pelo backend nativo do Tauri, que e' muito mais rapido.
 *
 * Fica em arquivo proprio porque importa `node:child_process`, que nao pode
 * entrar no bundle do renderer (o overlay roda com `sandbox: true`).
 */
export class WindowsScreenCapture implements IScreenCapture {
  readonly #powerShellScript: string;

  constructor(powerShellScript?: string) {
    this.#powerShellScript =
      powerShellScript ??
      [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
        '$ms = New-Object System.IO.MemoryStream',
        '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
        '[Convert]::ToBase64String($ms.ToArray())',
      ].join('; ');
  }

  async captureFullScreen(): Promise<string> {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', this.#powerShellScript],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.trim();
  }

  /**
   * Deteccao de bounds reais exige template matching do icone do item,
   * o que fica em `agent/`. Aqui devolvemos a area central da tela,
   * onde o inventario do PoE2 e normalmente posicionado.
   */
  async detectItemBounds(): Promise<ScreenBounds | null> {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($s.Width)x$($s.Height)"',
        ],
        { encoding: 'utf8' },
      );
      const [widthStr, heightStr] = stdout.trim().split('x');
      const width = Number.parseInt(widthStr ?? '', 10);
      const height = Number.parseInt(heightStr ?? '', 10);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      return {
        x: Math.round(width * 0.35),
        y: Math.round(height * 0.3),
        width: Math.round(width * 0.3),
        height: Math.round(height * 0.4),
      };
    } catch {
      return null;
    }
  }
}

/** Escolhe a captura adequada para a plataforma atual. */
export function createDefaultScreenCapture(): IScreenCapture {
  return process.platform === 'win32' ? new WindowsScreenCapture() : new SimulatedScreenCapture();
}
