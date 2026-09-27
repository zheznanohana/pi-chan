const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // --- 窗口 ---
  showContextMenu: () => ipcRenderer.invoke('show-context-menu'),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  // 名字必须和 main.js 里 ipcMain.on 的完全一致，否则拖不动窗口
  dragWindowDelta: (dx, dy) => ipcRenderer.send('drag-window-delta', { dx, dy }),

  onGlobalMousePos: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('global-mouse-pos', h);
    return () => ipcRenderer.removeListener('global-mouse-pos', h);
  },

  // --- 取景档位（全身 / 半身） ---
  getViewMode: () => ipcRenderer.invoke('get-view-mode'),
  onViewModeChange: (cb) => {
    const h = (_e, mode) => cb(mode);
    ipcRenderer.on('view-mode-change', h);
    return () => ipcRenderer.removeListener('view-mode-change', h);
  },

  // --- 唤醒词 / 语音 ---
  // 必须送 Int16 PCM 的 ArrayBuffer；送 Float32 会被主进程按字节截断
  sendAudioChunk: (buf) => ipcRenderer.send('audio-chunk', buf),
  toggleListening: (enabled) => ipcRenderer.send('toggle-listening', enabled),
  interruptListening: () => ipcRenderer.send('interrupt-listening'),
  triggerWakeTest: () => ipcRenderer.send('trigger-wake-test'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  onWakeEvent: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('wake-event', h);
    return () => ipcRenderer.removeListener('wake-event', h);
  },
  onAsrEvent: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('asr-event', h);
    return () => ipcRenderer.removeListener('asr-event', h);
  },
  onStateChange: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('state-change', h);
    return () => ipcRenderer.removeListener('state-change', h);
  },
};

contextBridge.exposeInMainWorld('petAPI', api);
contextBridge.exposeInMainWorld('electronPet', api);

contextBridge.exposeInMainWorld('piShared', {
 getState:()=>ipcRenderer.invoke('shared-get'),
 update:patch=>ipcRenderer.invoke('shared-update',patch),
 subscribe:cb=>{const h=(_event,state)=>cb(state);ipcRenderer.on('shared-state',h);return()=>ipcRenderer.removeListener('shared-state',h);}
});
