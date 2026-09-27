const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dashboardPointer', {
  subscribe(callback) {
    const listener = (_event, position) => callback(position);
    ipcRenderer.on('global-mouse-pos', listener);
    return () => ipcRenderer.removeListener('global-mouse-pos', listener);
  }
});

contextBridge.exposeInMainWorld('piShared', {
 getState:()=>ipcRenderer.invoke('shared-get'),
 update:patch=>ipcRenderer.invoke('shared-update',patch),
 subscribe:cb=>{const h=(_event,state)=>cb(state);ipcRenderer.on('shared-state',h);return()=>ipcRenderer.removeListener('shared-state',h);}
});
