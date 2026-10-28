// Puente entre el juego y la app de escritorio: expone window.PSNative (partidas por red local,
// igual que la app de Android) y window.PSDesktop (pantalla completa, versión, salir).
const { contextBridge, ipcRenderer } = require('electron');

const call = (cmd, ...args) => ipcRenderer.send('ps-net', cmd, args);

contextBridge.exposeInMainWorld('PSNative', {
  available: () => true,
  localIp: () => ipcRenderer.sendSync('ps-net-sync', 'localIp'),
  host: (kind, info) => call('host', kind, info),
  stopHost: () => call('stopHost'),
  scan: kind => call('scan', kind),
  stopScan: () => call('stopScan'),
  connect: (kind, addr) => call('connect', kind, addr),
  disconnect: () => call('disconnect'),
  send: (id, text) => call('send', id, text),
});

contextBridge.exposeInMainWorld('PSDesktop', {
  version: ipcRenderer.sendSync('ps-app-sync', 'version'),
  fullscreen: () => ipcRenderer.send('ps-app', 'fullscreen'),
  quit: () => ipcRenderer.send('ps-app', 'quit'),
});
