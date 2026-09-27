const { app, BrowserWindow, Menu, ipcMain, shell, screen, dialog, protocol, net, Tray, nativeImage } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const http = require('http');

app.setName('pi-chan-desktop-pet');

const { SharedState } = require('./shared-state.cjs');
const { WakeEngine } = require('./wake-engine');
const { moveWindowBy } = require('./window-geometry.cjs');

// 全身 / 半身两档取景。顶部预留 68px 给头顶气泡，所以比纯立绘高一些。
const VIEW_SIZES = { full: { w: 300, h: 300 }, portrait: { w: 260, h: 250 } };
let viewMode = 'full';
let wakeEngine = null;
let recoveryMuted = process.argv.includes('--restore-pet-muted');
let listeningEnabled = !recoveryMuted;

// Register custom privileged scheme for loading local model and assets cleanly
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

let mainWindow = null;
let mousePollInterval = null;
let isAlwaysOnTop = true;

const CONFIG_FILE = path.join(app.getPath('userData'), 'pet-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn('[Pet] Failed to read config:', err.message);
  }
  return null;
}

function saveConfig(cfg) {
  try {
    const existing = loadConfig() || {};
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, ...cfg }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Pet] Failed to save config:', err.message);
  }
}

function checkHarnessServer(targetUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(targetUrl);
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'HEAD',
        timeout: timeoutMs
      }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

let dashboardWindow = null;
let tray = null, lastTrayStatus=null;
const shared = new SharedState(loadConfig()?.voiceSettings || null);
shared.on('change', state=>{
  for(const win of [mainWindow,dashboardWindow])if(win&&!win.isDestroyed())win.webContents.send('shared-state',state);
  const enabled=!recoveryMuted && state.voiceSettings?.asrEnabled!==false;
  if(enabled!==listeningEnabled){listeningEnabled=enabled;wakeEngine?.setEnabled(enabled);}
  updateTray();
});
ipcMain.handle('shared-get',()=>shared.value);
ipcMain.handle('shared-update',(_event,patch)=>{
  const before=JSON.stringify(shared.value.voiceSettings);
  const state=shared.patch(patch);
  if(JSON.stringify(state.voiceSettings)!==before)saveConfig({voiceSettings:state.voiceSettings});
  return state;
});
function updateTray(){
  if(!tray)return;
  const status=shared.value.speaking?'正在说话':shared.value.captureOwner?'正在倾听':listeningEnabled?'唤醒待命':'麦克风关闭';
  if(lastTrayStatus===status)return;lastTrayStatus=status;
  tray.setToolTip('小派 · '+status);
  tray.setImage(nativeImage.createFromPath(path.join(__dirname,'../assets/pet',listeningEnabled?'tray-active.png':'tray-muted.png')));
  tray.setContextMenu(createContextMenu());
}
function createTray(){
  tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'../assets/pet/tray-active.png')));
  tray.on('click',()=>restorePet({ moveToCursor: true }));
  tray.on('double-click',()=>openDashboard());
  updateTray();
}

// 仪表盘开在 Electron 窗口里，而不是丢给外部浏览器。
// 这样它和桌宠共用同一个 session，麦克风权限已经程序化放行，
// 不会再出现「设备名是占位符 / 收不到声音」那套问题。
function createDashboardWindow(url) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return dashboardWindow;
  }
  dashboardWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'π-chan Studio',
    icon: path.join(__dirname,'../assets/pet/app-icon.ico'),
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'dashboard-preload.js'),
    },
  });
  dashboardWindow.loadURL(url);
  dashboardWindow.on('closed', () => { dashboardWindow = null; if(shared.value.captureOwner==='dashboard')shared.patch({captureOwner:null,speaking:false,mouth:0}); });
  return dashboardWindow;
}

async function openDashboard() {
  const dashboardUrl = 'http://127.0.0.1:31415/';
  const isRunning = await checkHarnessServer(dashboardUrl);
  if (isRunning) {
    createDashboardWindow(dashboardUrl);
  } else {
    dialog.showMessageBox(mainWindow || null, {
      type: 'warning',
      title: 'Pi-chan Dashboard',
      message: '仪表盘服务未启动',
      detail: '未能连接到 http://localhost:31415/\n请先在终端运行 node harness-server.js 启动后台服务。',
      buttons: ['确定']
    });
  }
}

// 窗口位置只管存不管校验的话，很容易被存成屏幕外的坐标
// （实际遇到过 y=-840，进程在跑、窗口也建了，但完全看不见，
//  表现就是「点桌面图标没反应」）。这里统一做一次可见性校验。
function clampToVisible(x, y, w, h) {
  const valid = Number.isFinite(x) && Number.isFinite(y);
  const displays = screen.getAllDisplays();
  const overlap = d => {
    const a = d.workArea;
    return valid ? Math.max(0, Math.min(x + w, a.x + a.width) - Math.max(x, a.x)) *
      Math.max(0, Math.min(y + h, a.y + a.height) - Math.max(y, a.y)) : 0;
  };
  const nearest = displays.reduce((best, d) => overlap(d) > overlap(best) ? d : best, screen.getPrimaryDisplay());
  const a = (overlap(nearest) > 0 ? nearest : screen.getPrimaryDisplay()).workArea;
  // A sliver of the transparent window is not enough: keep the character and controls on screen.
  return {
    x: Math.round(Math.max(a.x, Math.min(valid ? x : a.x + a.width - w - 30, a.x + a.width - w))),
    y: Math.round(Math.max(a.y, Math.min(valid ? y : a.y + a.height - h - 50, a.y + a.height - h)))
  };
}

// All explicit recovery routes restore minimization, visibility and a reachable position.
function restorePet({ moveToCursor = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (moveToCursor) moveToCursorDisplay();
  else {
    const b = win.getBounds();
    const pos = clampToVisible(b.x, b.y, b.width, b.height);
    win.setPosition(pos.x, pos.y);
  }
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  win.focus();
  if (!isAlwaysOnTop) setTimeout(() => {
    if (mainWindow === win && !win.isDestroyed() && !isAlwaysOnTop) win.setAlwaysOnTop(false);
  }, 400);
}

// 把窗口挪到「鼠标当前所在的那块屏」的右下角。
// 这台机器是双屏且副屏在主屏上方（workArea y = -1440），窗口很容易停在
// 另一块屏上，用户在笔记本屏上就会以为「点了没反应」。
function moveToCursorDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(cursor);
  const a = d.workArea;
  const b = mainWindow.getBounds();
  const x = Math.round(Math.max(a.x, a.x + a.width - b.width - 30));
  const y = Math.round(Math.max(a.y, a.y + a.height - b.height - 50));
  mainWindow.setBounds({ x, y, width: b.width, height: b.height });
  saveConfig({ x, y });
}

function applyViewMode(mode) {
  if (!Object.hasOwn(VIEW_SIZES, mode)) return false;
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    try {
      const b = win.getBounds();
      const { w, h } = VIEW_SIZES[mode];
      const ok = clampToVisible(b.x, b.y, w, h);
      win.setBounds({ x: Math.round(ok.x), y: Math.round(ok.y), width: w, height: h });
      if (!win.webContents.isDestroyed()) win.webContents.send('view-mode-change', mode);
    } catch (error) {
      console.warn('[Pet] Size change skipped:', error.message);
      return false;
    }
  }
  viewMode = mode;
  saveConfig({ viewMode });
  restorePet();
  // Tray menus are retained objects; rebuild their radio state after each change.
  if (tray && !tray.isDestroyed()) tray.setContextMenu(createContextMenu());
  return true;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showPetContextMenu() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return false;
  try {
    const menu = createContextMenu();
    if (win.isDestroyed()) return false;
    menu.popup({ window: win });
    return true;
  } catch (error) {
    console.warn('[Pet] Menu skipped:', error.message);
    return false;
  }
}

function createContextMenu() {
  const template = [
    { label: '显示桌宠（当前屏幕）', click: () => restorePet({ moveToCursor: true }) },
    {
      label: '打开完整仪表盘',
      click: () => openDashboard()
    },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: isAlwaysOnTop,
      click: (item) => {
        isAlwaysOnTop = item.checked;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(isAlwaysOnTop, 'screen-saver');
        }
        saveConfig({ alwaysOnTop: isAlwaysOnTop });
      }
    },
    {
      label: '语音设备自检',
      click: () => createDashboardWindow('http://127.0.0.1:31415/devices.html')
    },
    { type: 'separator' },
    {
      label: '唤醒监听（小派小派）',
      type: 'checkbox',
      checked: listeningEnabled,
      click: (item) => {
        recoveryMuted = false;
        shared.patch({voiceSettings:{asrEnabled:item.checked}});
        saveConfig({voiceSettings:shared.value.voiceSettings});
        listeningEnabled = item.checked;
        if (wakeEngine) wakeEngine.setEnabled(listeningEnabled);
        sendToRenderer('state-change', { state: 'idle', enabled: listeningEnabled, ready: !!wakeEngine });
      }
    },
    {
      label: '桌宠大小',
      submenu: [
        { label: '标准', type: 'radio', checked: viewMode === 'full', click: () => applyViewMode('full') },
        { label: '小巧', type: 'radio', checked: viewMode === 'portrait', click: () => applyViewMode('portrait') }
      ]
    },
    {
      label: '移到当前屏幕',
      click: () => restorePet({ moveToCursor: true })
    },
    {
      label: '重置位置（主屏）',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const a = screen.getPrimaryDisplay().workArea;
        const w = VIEW_SIZES[viewMode].w;
        const h = VIEW_SIZES[viewMode].h;
        const x = Math.round(a.x + a.width - w - 30);
        const y = Math.round(a.y + a.height - h - 50);
        mainWindow.setBounds({ x, y, width: w, height: h });
        saveConfig({ x, y });
        restorePet();
      }
    },
    { type: 'separator' },
    {
      label: '完全退出（含后台服务）',
      click: () => {
        // 只 app.quit() 的话 harness 还占着 31415 和 ASR/TTS/KWS 三套模型的内存
        const { spawn } = require('child_process');
        try {
          const bundledPython = 'E:/pinokio/api/whisper-webui.git/app/env/Scripts/python.exe';
          const helper = spawn(fs.existsSync(bundledPython) ? bundledPython : 'python', [path.join(__dirname, '..', 'stop.py')],
                { detached: true, stdio: 'ignore', windowsHide: true });
          helper.on('error', error => console.warn('[Pet] 后台退出助手启动失败:', error.message));
          helper.unref();
        } catch (e) {
          console.warn('[Pet] 调用 stop.py 失败:', e.message);
        }
        app.quit();
      }
    },
    {
      label: '仅关闭桌宠',
      click: () => { app.quit(); }
    }
  ];

  return Menu.buildFromTemplate(template);
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;

  const saved = loadConfig();
  if (saved?.viewMode && VIEW_SIZES[saved.viewMode]) viewMode = saved.viewMode;
  const defaultWidth = VIEW_SIZES[viewMode].w;
  const defaultHeight = VIEW_SIZES[viewMode].h;
  let posX = primaryDisplay.workArea.x + Math.max(0, screenWidth - defaultWidth - 30);
  let posY = primaryDisplay.workArea.y + Math.max(0, screenHeight - defaultHeight - 50);

  if (saved && saved.viewMode && VIEW_SIZES[saved.viewMode]) {
    viewMode = saved.viewMode;
  }
  if (saved) {
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const ok = clampToVisible(saved.x, saved.y, defaultWidth, defaultHeight);
      posX = ok.x;
      posY = ok.y;
    }
    if (typeof saved.alwaysOnTop === 'boolean') {
      isAlwaysOnTop = saved.alwaysOnTop;
    }
  }

  mainWindow = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    x: posX,
    y: posY,
    icon: path.join(__dirname,'../assets/pet/app-icon.ico'),
    transparent: true,
    frame: false,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  if (isAlwaysOnTop) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  mainWindow.loadURL('http://127.0.0.1:31415/pet/pet.html');

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer ${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.once('ready-to-show', () => {
    const b = mainWindow.getBounds();
    console.log(`PET_BOUNDS_LOG x=${b.x} y=${b.y} w=${b.width} h=${b.height} visible=${mainWindow.isVisible()}`);
  });

  mainWindow.on('moved', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    const ok = clampToVisible(bounds.x, bounds.y, bounds.width, bounds.height);
    if (ok.x !== bounds.x || ok.y !== bounds.y) {
      // 已经拖到屏幕外了，拉回来再存，避免下次启动看不见
      mainWindow.setPosition(Math.round(ok.x), Math.round(ok.y));
    }
    saveConfig({ x: ok.x, y: ok.y });
  });

  // Windows native hook for right-click on -webkit-app-region: drag
  if (process.platform === 'win32') {
    const popMenu = () => showPetContextMenu();
    mainWindow.hookWindowMessage(0x00A5, popMenu); // WM_NCRBUTTONUP
    mainWindow.hookWindowMessage(0x007B, popMenu); // WM_CONTEXTMENU
  }

  // Global cursor position polling so Pi-chan tracks the cursor anywhere on screen
  mousePollInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const cursor = screen.getCursorScreenPoint();
      const bounds = mainWindow.getBounds();
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        const content = dashboardWindow.getContentBounds();
        dashboardWindow.webContents.send('global-mouse-pos', {
          cursorX: cursor.x, cursorY: cursor.y,
          winX: content.x, winY: content.y,
          zoom: dashboardWindow.webContents.getZoomFactor()
        });
      }
      mainWindow.webContents.send('global-mouse-pos', {
        cursorX: cursor.x,
        cursorY: cursor.y,
        winX: bounds.x,
        winY: bounds.y,
        winW: bounds.width,
        winH: bounds.height
      });
    } catch {}
  }, 33);

  mainWindow.on('closed', () => {
    if (mousePollInterval) {
      clearInterval(mousePollInterval);
      mousePollInterval = null;
    }
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('show-context-menu', () => showPetContextMenu());

ipcMain.handle('open-dashboard', async () => {
  await openDashboard();
});

// ---------------------------------------------------------------------------
// 常驻唤醒词「小派小派」
// ---------------------------------------------------------------------------
async function initWakeEngine() {
  wakeEngine = new WakeEngine({
    onWake: (d) => sendToRenderer('wake-event', d),
    onAsr: (d) => sendToRenderer('asr-event', d),
    onState: (d) => sendToRenderer('state-change', d),
  });
  try {
    await wakeEngine.init();
    wakeEngine.setEnabled(listeningEnabled);
  } catch (e) {
    console.warn('[Pet] 唤醒引擎初始化失败:', e.message);
    sendToRenderer('state-change', { state: 'error', enabled: false, ready: false, error: e.message });
  }
}

ipcMain.on('audio-chunk', (_event, chunk) => {
  if (!wakeEngine || recoveryMuted) return;
  try {
    wakeEngine.processAudioChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  } catch (e) {
    console.warn('[Pet] 音频处理异常:', e.message);
  }
});

ipcMain.on('toggle-listening', (_event, enabled) => {
  recoveryMuted = false;
  shared.patch({voiceSettings:{asrEnabled:!!enabled}});
  saveConfig({voiceSettings:shared.value.voiceSettings});
  listeningEnabled = !!enabled;
  if (wakeEngine) wakeEngine.setEnabled(listeningEnabled);
});

ipcMain.on('interrupt-listening', () => {
  if(wakeEngine && listeningEnabled){
    wakeEngine.resetToIdle();
    wakeEngine.handleWakeDetected('语音打断');
  }
});

ipcMain.on('trigger-wake-test', () => {
  if (wakeEngine) wakeEngine.handleWakeDetected('小派小派(测试)');
});

ipcMain.handle('get-status', () => (wakeEngine ? wakeEngine.getStatus() : { ready: false }));
ipcMain.handle('get-view-mode', () => viewMode);

// preload 发的是 drag-window-delta，两边名字必须一致，否则拖不动
ipcMain.on('drag-window-delta', (_event, delta) => {
  moveWindowBy(mainWindow, delta);
});

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  // 已经有实例在跑，让那个实例把窗口唤到前台，自己退出
  app.quit();
} else {
  // 再次点击桌面快捷方式时会触发这里。没有这个处理器的话，
  // 第二个实例只是静默自退，用户看到的就是「点了没反应」。
  app.on('second-instance', () => {
    app.whenReady().then(() => restorePet({ moveToCursor: true }));
  });

  app.whenReady().then(() => {
    // Register protocol handler for pet://app/...
    const rootDir = path.resolve(__dirname, '..');
    protocol.handle('pet', (request) => {
      const parsed = new URL(request.url);
      const relativePath = path.posix.normalize(parsed.pathname);
      const filePath = path.join(rootDir, relativePath);
      return net.fetch(url.pathToFileURL(filePath).toString());
    });

    // 程序化放行麦克风 / 扬声器。Electron 不像浏览器那样必须由用户点弹窗，
    // 这里直接对本地页面放行，桌宠和仪表盘都不会再卡在授权上。
    const { session } = require('electron');
    const ALLOWED = new Set(['media', 'audioCapture', 'mediaKeySystem']);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(ALLOWED.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => ALLOWED.has(permission));
    // 设备枚举也要放行，否则拿不到真实设备名（只会显示「麦克风设备 1」这种占位名）
    if (session.defaultSession.setDevicePermissionHandler) {
      session.defaultSession.setDevicePermissionHandler(() => true);
    }

    listeningEnabled=!recoveryMuted && shared.value.voiceSettings?.asrEnabled!==false;
    createWindow();
    createTray();
    initWakeEngine();

    // 启动时一并打开仪表盘。放在 Electron 窗口里而不是丢给浏览器，
    // 是为了继承上面那套麦克风权限放行 —— 在 Edge 里会卡在授权弹窗，
    // 设备名只能拿到「麦克风设备 1」这种占位符。
    if (!recoveryMuted) setTimeout(() => { openDashboard(); }, 1200);

    app.on('activate', () => restorePet({ moveToCursor: true }));
    const keepPetOnScreen = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      const pos = clampToVisible(b.x, b.y, b.width, b.height);
      mainWindow.setPosition(pos.x, pos.y);
    };
    screen.on('display-removed', keepPetOnScreen);
    screen.on('display-metrics-changed', keepPetOnScreen);
  });

  app.on('before-quit',()=>{tray?.destroy();tray=null;});
  app.on('window-all-closed', () => {
    if (mousePollInterval) {
      clearInterval(mousePollInterval);
      mousePollInterval = null;
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
