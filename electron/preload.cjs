'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Superficie minima exposta ao renderer.
 *
 * Via `contextBridge`, com `contextIsolation: true` e `sandbox: true`: o
 * renderer roda o bundle do Vite e nao deve alcancar Node. `onItemCaptured` e'
 * o unico caminho de entrada assincrona que nao seja resposta a uma chamada; o
 * payload cru chega aqui e o parse acontece do lado do renderer, que tem o
 * `ItemSchema`.
 */
const electronApi = {
  hide: () => ipcRenderer.invoke('overlay:hide'),
  show: () => ipcRenderer.invoke('overlay:show'),
  close: () => ipcRenderer.invoke('overlay:close'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (contents) => ipcRenderer.invoke('config:write', contents),

  /**
   * Snapshot da base de mods, em texto cru, igual ao config: o renderer nao
   * tem `node:fs`, entao a persistencia da base revalidada passa por aqui. A
   * validacao continua sendo do renderer; o main so move bytes.
   */
  readDataSnapshot: () => ipcRenderer.invoke('data:snapshot:read'),
  writeDataSnapshot: (contents) => ipcRenderer.invoke('data:snapshot:write', contents),

  /**
   * Registra o atalho global. O acelerador ja vem validado e convertido pelo
   * renderer (`toElectronAccelerator`); o main so aplica.
   */
  registerGlobalHotkey: (accelerator) => ipcRenderer.invoke('hotkey:register', accelerator),
  getHotkeyStatus: () => ipcRenderer.invoke('hotkey:status'),

  /** Devolve a funcao de cancelamento: sem isso, um re-render acumularia
   * listeners e o mesmo acionamento dispararia o parse varias vezes. */
  onItemCaptured: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('overlay:item-captured', listener);
    return () => {
      ipcRenderer.removeListener('overlay:item-captured', listener);
    };
  },

  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  /**
   * Uma linha de log ja formatada. O renderer nao tem `node:fs`, entao
   * `electron-log` nao roda la: ele monta o texto e o main decide o destino.
   * `send` e' fire-and-forget de proposito - um log que trava a UI esperando
   * o main e' pior que um log perdido.
   */
  writeLog: (line) => ipcRenderer.send('log:write', line),

  /** Ultimas linhas do arquivo, para o relatorio de feedback. */
  readLog: () => ipcRenderer.invoke('app:read-log'),

  /**
   * Envia o relatorio. O destino (webhook, issue, arquivo) e' escolhido pelo
   * main a partir do ambiente: o renderer nao consegue apontar o envio para
   * um host que a aplicacao nao configurou.
   */
  sendFeedback: (payload) => ipcRenderer.invoke('app:send-feedback', payload),

  /** Escuta o item parseado vindo do main (dev ou hotkey real). */
  onItemParsed: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('item:parsed', listener);
    return () => {
      ipcRenderer.removeListener('item:parsed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('overlayHost', electronApi);
contextBridge.exposeInMainWorld('electron', electronApi);
