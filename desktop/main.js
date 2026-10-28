// Pixel Shooter para PC: una ventana con el juego (index.html + rooms.js + fonts/) incluido en la app.
// El juego se sirve desde app://game/ (no file://), así el guardado local, el login y la conexión
// al servidor online funcionan igual que en la web. Las partidas por red local las maneja localnet.js.
const { app, BrowserWindow, ipcMain, protocol, net, shell, session, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { LocalNet } = require('./localnet');

const GAME_DIR = path.join(__dirname, 'game');
const START = 'app://game/index.html';
const BG = '#07090f';

app.setAppUserModelId('io.github.lorennswaggerboi.pixelshooter');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// una sola ventana del juego: si lo abren de nuevo, se trae al frente la que ya está
if (!app.requestSingleInstanceLock()) app.quit();

let win = null, lnet = null;

// ---------- tamaño y posición de la ventana, recordados entre sesiones
const STATE_FILE = () => path.join(app.getPath('userData'), 'ventana.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch (e) { return {}; }
}
function saveState() {
  if (!win) return;
  try {
    const st = { full: win.isFullScreen(), max: win.isMaximized(), bounds: win.isFullScreen() || win.isMaximized() ? (loadState().bounds || null) : win.getBounds() };
    fs.writeFileSync(STATE_FILE(), JSON.stringify(st));
  } catch (e) { }
}

function createWindow() {
  const st = loadState();
  const b = st.bounds || {};
  win = new BrowserWindow({
    title: 'Pixel Shooter',
    width: b.width || 1280, height: b.height || 720, x: b.x, y: b.y,
    minWidth: 640, minHeight: 360,
    backgroundColor: BG,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,   // el juego en red sigue al día aunque la ventana quede detrás
    },
  });
  win.setMenu(null);
  if (st.max) win.maximize();
  if (st.full) win.setFullScreen(true);
  win.once('ready-to-show', () => { win.show(); win.focus(); });

  // F11 / Alt+Enter: pantalla completa · Ctrl+R: recargar · Ctrl+Shift+I: herramientas (para soporte)
  win.webContents.on('before-input-event', (ev, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11' || (i.alt && i.key === 'Enter')) { win.setFullScreen(!win.isFullScreen()); ev.preventDefault(); }
    else if (i.control && !i.shift && i.key.toLowerCase() === 'r') { win.webContents.reload(); ev.preventDefault(); }
    else if (i.control && i.shift && i.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); ev.preventDefault(); }
    else if (i.control && ['+', '-', '=', '0'].includes(i.key)) ev.preventDefault();   // sin zoom: descuadra los menús
  });
  win.webContents.setVisualZoomLevelLimits(1, 1);

  // los enlaces externos (descargas, GitHub…) se abren en el navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => {
    if (url.startsWith('app://game/')) return;
    ev.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // si el juego se cuelga o se cierra solo, se vuelve a cargar en vez de quedar en negro
  win.webContents.on('render-process-gone', (ev, d) => {
    if (d.reason === 'clean-exit' || !win) return;
    lnet && lnet.shutdown();
    win.webContents.reload();
  });

  win.on('close', saveState);
  win.on('closed', () => { win = null; });
  win.loadURL(START);
}

// ---------- red local (PSNative)
function emitNet(ev) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.psNet&&psNet(${JSON.stringify(JSON.stringify(ev))})`).catch(() => { });
}
const NET_CMDS = new Set(['host', 'stopHost', 'scan', 'stopScan', 'connect', 'disconnect', 'send']);
ipcMain.on('ps-net', (e, cmd, args) => {
  if (NET_CMDS.has(cmd) && Array.isArray(args)) try { lnet[cmd](...args); } catch (err) { }
});
ipcMain.on('ps-net-sync', (e, cmd) => {
  e.returnValue = cmd === 'localIp' ? lnet.localIp() : null;
});
ipcMain.on('ps-app-sync', (e, cmd) => { e.returnValue = cmd === 'version' ? app.getVersion() : null; });
ipcMain.on('ps-app', (e, cmd) => {
  if (cmd === 'fullscreen' && win) win.setFullScreen(!win.isFullScreen());
  else if (cmd === 'quit') app.quit();
});

// ---------- actualizaciones automáticas: se bajan solas y se instalan al cerrar el juego
function checkUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => { });
  autoUpdater.on('update-downloaded', info => {
    if (!win) return;
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualización lista',
      message: `Hay una versión nueva de Pixel Shooter (${info.version}).`,
      detail: 'Se instala sola cuando cierres el juego. ¿Querés reiniciarlo ahora para usarla?',
      buttons: ['Reiniciar ahora', 'Más tarde'],
      defaultId: 0, cancelId: 1, noLink: true,
    }).then(r => { if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true)); }).catch(() => { });
  });
  autoUpdater.checkForUpdates().catch(() => { });
  setInterval(() => autoUpdater.checkForUpdates().catch(() => { }), 4 * 60 * 60 * 1000);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // el juego reconoce la app de PC por el user agent (para mostrar "red local" en vez de Bluetooth, etc.)
  session.defaultSession.setUserAgent(session.defaultSession.getUserAgent() + ' PixelShooterPC');
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(GAME_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(GAME_DIR + path.sep)) return new Response('', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  lnet = new LocalNet(emitNet);
  createWindow();
  checkUpdates();
});

app.on('before-quit', () => { lnet && lnet.shutdown(); });
app.on('window-all-closed', () => app.quit());
