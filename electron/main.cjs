'use strict';

const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const { mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

// Desabilita caches de GPU/HTTP para ambiente de teste mais limpo
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');

const { createMainHotkeyManager } = require('./mainHotkeyManager.cjs');
const { init, logFromRenderer, logMain } = require('./logFile.cjs');
const { deliverFeedback } = require('./feedbackDelivery.cjs');

/**
 * Verifica se o Path of Exile 2 esta com foco no Windows.
 * Usa PowerShell para obter o processo da janela em primeiro plano.
 * Retorna true se o nome do processo ativo contiver PathOfExile ou poe2.
 * Em modo dev (VITE_DEV_SERVER_URL), ignora a checagem para permitir teste sem o jogo.
 */
function isPoE2Focused() {
  // Modo dev/mock: ignora a trava do jogo para permitir teste na area de trabalho
  if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV !== 'production') {
    return true;
  }
  if (process.platform !== 'win32') return false;
  try {
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        }
"@
      $hwnd = [Win32]::GetForegroundWindow()
      $pid = 0
      [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      if ($proc) { $proc.ProcessName } else { '' }
    `;
    const result = execSync(`powershell -NoProfile -Command "${script}"`, { 
      encoding: 'utf8', 
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!result) {
      console.warn('[MAIN] Nao foi possivel identificar o processo em foco; liberando hotkey como fallback.');
      return true;
    }
    const processName = result.toLowerCase();
    return processName.includes('pathofexile') || processName.includes('poe2');
  } catch (error) {
    console.warn('[MAIN] Falha ao detectar o processo em foco; liberando hotkey como fallback:', error);
    return true;
  }
}


/**
 * Processo principal do overlay.
 *
 *  - `frame: false` + `transparent: true`: a janela nao tem borda nem fundo, e
 *    por isso nao rouba o foco do Path of Exile quando aparece.
 *  - `alwaysOnTop` com `screen-saver`: e' o unico cenario em que o overlay e'
 *    usado, e o jogo esta em tela cheia.
 *  - O atalho global vive aqui, e nao no renderer, que fica pausado quando o
 *    jogo esta em foreground exclusivo.
 */

const OVERLAY_WIDTH = 460;
const OVERLAY_HEIGHT = 720;

/** @type {BrowserWindow | null} */
let overlayWindow = null;

/** @type {ReturnType<typeof createMainHotkeyManager> | null} */
let mainHotkeys = null;

/** @type {{ path: string, tail: (limit: number) => string } | null} */
let currentLog = null;
let devItemWatcher = null;
let devItemReadTimer = null;
let gameMonitor = null;
let gameWasDetected = false;

function isPoE2ProcessRunning() {
  const output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return output.split(/\r?\n/).some((line) => {
    const imageName = line.match(/^"([^"]+)"/)?.[1]?.toLowerCase();
    return imageName === 'pathofexile2.exe' || imageName === 'poe2.exe';
  });
}

function checkGameLifecycle() {
  try {
    if (isPoE2ProcessRunning()) {
      gameWasDetected = true;
      return;
    }
    if (gameWasDetected) {
      console.log('[MAIN] Jogo fechado; encerrando o assistente.');
      if (gameMonitor !== null) clearInterval(gameMonitor);
      gameMonitor = null;
      app.quit();
    }
  } catch (error) {
    console.warn('[MAIN] Falha ao verificar o processo do jogo; nova tentativa em 10 segundos:', error);
  }
}

function startGameMonitor() {
  if (process.platform !== 'win32' || gameMonitor !== null) return;
  checkGameLifecycle();
  gameMonitor = setInterval(checkGameLifecycle, 10_000);
}

function createHotkeyManager() {
  return createMainHotkeyManager({
    backend: globalShortcut,
    clipboard,
    isPoE2Focused,
    onCaptured: (payload) => {
      // Log do clipboard lido
      logMain('info', '[MAIN] Clipboard lido', { length: payload?.text?.length || 0 });
      
      // Forca visibilidade do overlay acima de jogos em tela cheia.
      console.log('[MAIN] Hotkey disparada! Exibindo overlay...');
      if (overlayWindow) {
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        overlayWindow.show();
        overlayWindow.restore();
        overlayWindow.focus();
      }
      
      // Envia payload parseado para o renderer via IPC
      logMain('info', '[MAIN] Enviando payload para renderer via IPC overlay:item-captured');
      overlayWindow?.webContents.send('overlay:item-captured', payload);
    },
    verbose: process.env.POE2_DEBUG_HOTKEY === '1',
  });
}

function resolveRendererTarget() {
  // Em dev, o Vite serve a UI; em producao, o bundle fica em dist/ui, que e'
  // irmao de `electron/` (e nao filho, porque `__dirname` aponta para ele).
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) return devServer;
  return `file://${path.join(__dirname, '..', 'dist', 'ui', 'index.html')}`;
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: Math.max(0, width - OVERLAY_WIDTH - 40),
    y: Math.max(0, Math.round(height / 2 - OVERLAY_HEIGHT / 2)),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    /**
     * Focavel de proposito: o atalho global abre o overlay e o jogador precisa
     * clicar em Ajustes, digitar um atalho e usar os botoes do plano. Com
     * `focusable: false` o Windows aceita o desenho mas ignora clique e
     * teclado, e a tela de ajustes fica morta.
     */
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // "screen-saver" mantem o overlay acima de outros em tela cheia.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  void overlayWindow.loadURL(resolveRendererTarget());

  // Escape resolve no main e nao no renderer: se a UI travou ou nem carregou,
  // o jogador ainda precisa de uma saida que devolva o foco ao jogo.
  overlayWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    hideOverlay();
  });

  /**
   * Perder o foco com a janela visivel significa que o jogador voltou a jogar:
   * o clique fora do painel (que o renderer deixa passar com `pointer-events-
   * none`) chega ao jogo, e o overlay sai sozinho em vez de cobrir a tela.
   */
  overlayWindow.on('blur', () => {
    if (overlayWindow?.isVisible()) hideOverlay();
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

/**
 * `show()` + `focus()`, e nao `showInactive()`: o acionamento veio de uma tecla
 * que o jogador apertou de proposito, entao ele esta usando a ferramenta e
 * espera poder interagir. Quem so quiser olhar sem roubar o foco do jogo passa
 * pelo `overlay:show` do IPC, que repassa por aqui.
 */
function showOverlay() {
  if (overlayWindow === null) return;
  if (overlayWindow.isMinimized()) overlayWindow.restore();
  
  // Centraliza a janela na tela atual
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.workAreaSize;
  overlayWindow.setPosition(
    Math.round(width / 2 - OVERLAY_WIDTH / 2),
    Math.round(height / 2 - OVERLAY_HEIGHT / 2)
  );
  
  overlayWindow.show();
  overlayWindow.restore();
  overlayWindow.focus();
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  logMain('info', '[MAIN] Overlay exibido');
}

/**
 * Devolve o foco ao jogo.
 *
 * `blur()` antes de `hide()` e' o que importa: no Windows, esconder a janela
 * que esta em primeiro plano nao devolve o foco, e o jogador ficaria com o
 * overlay "invisivel" e o jogo sem teclado. Ao perder o foco, o SO promove a
 * proxima janela da ordem Z, que e' o jogo em tela cheia logo abaixo do overlay.
 * Sem um modulo nativo nao ha como pedir `SetForegroundWindow` por HWND, entao
 * este e' o maximo de precisao sem depender de `uiohook-napi` estar compilado.
 */
function hideOverlay() {
  if (overlayWindow === null || !overlayWindow.isVisible()) return;
  overlayWindow.blur();
  overlayWindow.hide();
}

/**
 * Cria o icone na System Tray.
 * Permite ao usuario saber que o app esta rodando e abrir/fechar o overlay.
 */
function createTray() {
  // Cria um icone simples (16x16) usando nativeImage se nao houver arquivo .ico
  const icon = nativeImage.createEmpty();
  // Se tiver um icone personalizado, usar: path.join(__dirname, '..', 'build', 'icon.ico')
  // Por enquanto, usamos um icone vazio e o Electron usa o padrao.
  
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  void app.getFileIcon(process.execPath, { size: 'small' }).then((appIcon) => {
    if (global.tray === tray) tray.setImage(appIcon.resize({ width: 16, height: 16 }));
  }).catch((error) => {
    console.warn('[MAIN] Nao foi possivel carregar o icone do Tray:', error);
  });
  tray.setToolTip('PoE2 Craft Assistant - Pressione Alt+Q para abrir');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir Configurações',
      click: () => {
        showOverlay();
        if (!overlayWindow) return;
        const sendOpenSettings = () => {
          if (!overlayWindow?.isDestroyed()) overlayWindow?.webContents.send('overlay:open-settings');
        };
        if (overlayWindow.webContents.isLoadingMainFrame()) {
          overlayWindow.webContents.once('did-finish-load', sendOpenSettings);
        } else {
          sendOpenSettings();
        }
      },
    },
    {
      label: 'Sair do Assistente',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  
  // Clique no icone alterna a visibilidade do overlay.
  tray.on('click', () => {
    if (overlayWindow?.isVisible()) hideOverlay();
    else showOverlay();
  });

  // Guarda referencia para nao ser coletado pelo GC
  global.tray = tray;
}

/**
 * `app.getPath('userData')` e' o lugar certo no Windows: fica em `%APPDATA%`,
 * que o usuario nao limpa ao desinstalar outras coisas e nao depende do cwd do
 * processo (que muda se o atalho for aberto de outro lugar).
 */
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/**
 * O snapshot do usuario vai ao lado do config e nao para `src/data/`: o arquivo
 * versionado e' a referencia para revisao, e o do usuario e' cache reescrito a
 * cada revalidacao. Misturar os dois faria um update legitimo virar um diff de
 * centenas de linhas no repositorio.
 */
function dataSnapshotPath() {
  return path.join(app.getPath('userData'), 'poe2_mods_db.json');
}

function readConfig() {
  try {
    return readFileSync(configPath(), 'utf8');
  } catch (thrown) {
    if (thrown && thrown.code === 'ENOENT') return null;
    throw thrown;
  }
}

/**
 * Escrita atomica: grava num `.tmp` e troca por rename. Sem isso, uma queda no
 * meio deixaria o arquivo truncado e o ConfigManager perderia tudo que o
 * usuario configurou.
 */
function writeFileAtomic(target, contents) {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, target);
  } catch (thrown) {
    try {
      unlinkSync(tmp);
    } catch {
      // Se nem o tmp existe, o erro original e' o que importa.
    }
    throw thrown;
  }
}

function writeConfig(contents) {
  if (typeof contents !== 'string') throw new TypeError('config deve ser texto');
  writeFileAtomic(configPath(), contents);
}

function readDataSnapshot() {
  try {
    return readFileSync(dataSnapshotPath(), 'utf8');
  } catch (thrown) {
    // Nunca houve revalidacao neste boot: a hidratacao cai no catalogo seed.
    if (thrown && thrown.code === 'ENOENT') return null;
    throw thrown;
  }
}

function writeDataSnapshot(contents) {
  if (typeof contents !== 'string') throw new TypeError('snapshot deve ser texto');
  writeFileAtomic(dataSnapshotPath(), contents);
}

/**
 * Fronteira de confianca, nao politica: a politica (exige modificador, recusa
 * atalho reservado) roda no renderer, em `toElectronAccelerator`, que e' quem
 * envia o acelerador ja convertido. Isto existe porque
 * `globalShortcut.register` recebe string crua, e algo invalido aqui viraria um
 * binding que o SO nunca dispara.
 */
const ACCELERATOR_RE = /^[A-Za-z0-9+'"`\-\[\]\\;,.//]+$/;
const DEFAULT_ACCELERATOR = 'Alt+Q';

function sanitizeAccelerator(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Sem `+` nao ha modificador: sequestraria digitacao normal.
  if (!trimmed.includes('+')) return null;
  if (trimmed.length > 64 || !ACCELERATOR_RE.test(trimmed)) return null;
  return trimmed;
}

function registerIpc() {
  // O renderer le o clipboard pelo main: no Windows isso exige subprocesso.
  ipcMain.handle('clipboard:read', () => {
    const text = clipboard.readText();
    logMain('info', '[MAIN] Clipboard lido via IPC', { length: text?.length || 0 });
    return {
      text,
      capturedAt: Date.now(),
    };
  });

  // O renderer le o clipboard pelo main: no Windows isso exige subprocesso.
  ipcMain.handle('clipboard:read', () => {
    const text = clipboard.readText();
    logMain('info', '[MAIN] Clipboard lido via IPC', { length: text?.length || 0 });
    return {
      text,
      capturedAt: Date.now(),
    };
  });

  ipcMain.handle('overlay:hide', () => {
    hideOverlay();
  });

  ipcMain.handle('overlay:show', () => {
    showOverlay();
  });

  ipcMain.handle('overlay:close', () => {
    overlayWindow?.close();
  });

  ipcMain.on('app:quit', () => {
    app.quit();
  });

  // Config e snapshot ficam em disco no main; o renderer recebe texto cru e
  // continua dono da validacao, para nao haver duas copias da verdade.
  ipcMain.handle('config:read', () => readConfig());

  ipcMain.handle('config:write', (_event, contents) => {
    writeConfig(contents);
  });

  ipcMain.handle('data:snapshot:read', () => readDataSnapshot());

  ipcMain.handle('data:snapshot:write', (_event, contents) => {
    writeDataSnapshot(contents);
  });

  ipcMain.handle('hotkey:register', (_event, accelerator) => {
    return mainHotkeys?.bind(sanitizeAccelerator(accelerator)) ?? null;
  });

  ipcMain.handle('hotkey:status', () => {
    return (
      mainHotkeys?.status() ?? {
        available: false,
        registered: false,
        accelerator: null,
        detail: 'Atalho global indisponivel: o processo main nao inicializou.',
      }
    );
  });

  ipcMain.handle('app:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  // O renderer nao tem `node:fs` (sandbox: true), entao todo log dele chega
  // aqui como uma linha JSON ja formatada.
  ipcMain.on('log:write', (_event, line) => {
    logFromRenderer(line);
  });

  ipcMain.handle('app:read-log', () => {
    return currentLog?.tail(300) ?? '';
  });

  ipcMain.handle('app:send-feedback', async (_event, payload) => {
    logMain('info', 'feedback recebido', { kind: payload?.kind, attach: payload?.attachDiagnostics });
    const result = await deliverFeedback(payload, {
      openExternal: (url) => shell.openExternal(url),
      userDataPath: () => app.getPath('userData'),
    });
    if (!result.ok) logMain('error', 'feedback nao entregue', { reason: result.reason });
    return result;
  });
}

function startDevItemWatcher() {
  const projectRoot = path.join(__dirname, '..');
  const itemPath = path.join(projectRoot, 'dev-item.tmp');
  devItemWatcher = watch(projectRoot, (_eventType, filename) => {
    if (filename?.toString() !== 'dev-item.tmp') return;

    if (devItemReadTimer !== null) clearTimeout(devItemReadTimer);
    devItemReadTimer = setTimeout(() => {
      devItemReadTimer = null;
      try {
        const rawItem = readFileSync(itemPath, 'utf8');
        if (rawItem.trim() === '') return;

        clipboard.writeText(rawItem);
        if (overlayWindow) {
          overlayWindow.webContents.send('item:parsed', { text: rawItem, capturedAt: Date.now() });
          overlayWindow.show();
          overlayWindow.restore();
          overlayWindow.focus();
          overlayWindow.setAlwaysOnTop(true, 'screen-saver');
          console.log('[MAIN DEV] Item detectado via dev-item.tmp! Janela exibida.');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logMain('error', '[MAIN DEV] Falha ao ler dev-item.tmp', { error: String(error) });
        }
      }
    }, 75);
  });
}

/**
 * Erros nao tratados viram linha de log antes de qualquer outra coisa.
 *
 * O `uncaughtException` nao impede o processo de continuar por padrao, e para um
 * overlay nao faz sentido derrubar o app: perder o overlay e' pior para o
 * jogador do que um handler de evento quebrado. O que nao pode e' perder o
 * stack, entao o log vem primeiro e o processo segue.
 */
function installGlobalHandlers() {
  process.on('uncaughtException', (error) => {
    logMain('error', 'uncaughtException', { stack: error instanceof Error ? error.stack : String(error) });
  });
  process.on('unhandledRejection', (reason) => {
    logMain('error', 'unhandledRejection', { reason: String(reason && reason.stack ? reason.stack : reason) });
  });
}

app.whenReady().then(() => {
  if (Notification.isSupported()) {
    new Notification({
      title: 'PoE 2 Craft Assistant',
      body: 'Overlay rodando! Pressione a hotkey (Alt+Q) com o mouse sobre um item no jogo.',
    }).show();
  }

  currentLog = init(app);
  installGlobalHandlers();
  logMain('info', 'app iniciado', {
    version: app.getVersion(),
    electron: process.versions.electron,
    logPath: currentLog.path,
  });

  mainHotkeys = createHotkeyManager();
  registerIpc();
  createOverlayWindow();
  // Rede de seguranca: se a UI nao carregar, o atalho padrao ainda responde em
  // vez de o app parecer morto. O renderer sobrescreve assim que ler o config.
  mainHotkeys.bind(DEFAULT_ACCELERATOR);

  // System Tray: mostra que o app esta rodando em segundo plano.
  // O usuario pode clicar para abrir o overlay ou sair.
  createTray();
  startGameMonitor();

  // Observa o arquivo temporario usado pelo simulador, apenas com o servidor Vite.
  if (process.env.VITE_DEV_SERVER_URL) {
    startDevItemWatcher();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow();
  });
});

app.on('will-quit', () => {
  if (gameMonitor !== null) clearInterval(gameMonitor);
  gameMonitor = null;
  mainHotkeys?.dispose();
  mainHotkeys = null;
  devItemWatcher?.close();
  devItemWatcher = null;
  if (devItemReadTimer !== null) clearTimeout(devItemReadTimer);
  devItemReadTimer = null;
  logMain('info', 'app encerrando');
});

app.on('window-all-closed', () => {
  app.quit();
});
