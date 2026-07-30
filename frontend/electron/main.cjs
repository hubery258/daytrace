const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

let mainWindow = null;
let sidecar = null;
let quitting = false;

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function findDevelopmentPython(backendDir) {
  const candidates = [
    process.env.RIJI_BACKEND_PYTHON,
    path.join(backendDir, '.codex-venv', 'Scripts', 'python.exe'),
    path.join(backendDir, '..', '.venv', 'Scripts', 'python.exe'),
    process.platform === 'win32' ? 'python.exe' : 'python3',
  ].filter(Boolean);
  return candidates.find((candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate)) || candidates.at(-1);
}

function appendSidecarLog(logPath, chunk) {
  fs.appendFile(logPath, chunk, () => {});
}

async function waitForHealth(port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`本地后端已退出（代码 ${child.exitCode}）`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (_) {
      // Sidecar is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('本地后端启动超时');
}

async function startSidecar() {
  const port = await reserveLoopbackPort();
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, 'riji.db').replaceAll('\\', '/');
  const frontendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'frontend')
    : path.resolve(__dirname, '..', 'dist');
  const backendDir = path.resolve(__dirname, '..', '..', 'backend');
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar', process.platform === 'win32' ? 'riji-sidecar.exe' : 'riji-sidecar')
    : findDevelopmentPython(backendDir);
  const args = app.isPackaged ? [] : [path.join(backendDir, 'desktop_sidecar.py')];
  const logPath = path.join(app.getPath('logs'), 'sidecar.log');

  sidecar = spawn(executable, args, {
    cwd: app.isPackaged ? process.resourcesPath : backendDir,
    env: {
      ...process.env,
      DATABASE_URL: `sqlite+aiosqlite:///${databasePath}`,
      RIJI_FRONTEND_DIR: frontendDir,
      RIJI_SIDECAR_PORT: String(port),
      PYTHONUTF8: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  sidecar.stdout.on('data', (chunk) => appendSidecarLog(logPath, chunk));
  sidecar.stderr.on('data', (chunk) => appendSidecarLog(logPath, chunk));
  sidecar.on('error', (error) => appendSidecarLog(logPath, `${error.stack || error}\n`));
  sidecar.on('exit', (code) => {
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('日迹本地后端已停止', `退出代码：${code ?? 'unknown'}\n日志：${logPath}`);
    }
  });
  await waitForHealth(port, sidecar);
  return { port, dataDir, logPath };
}

function stopSidecar() {
  if (sidecar && sidecar.exitCode === null) sidecar.kill();
  sidecar = null;
}

async function createWindow() {
  try {
    const { port } = await startSidecar();
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 860,
      minHeight: 600,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  } catch (error) {
    dialog.showErrorBox('日迹启动失败', `${error.message}\n请查看 ${app.getPath('logs')}`);
    app.quit();
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('before-quit', () => {
    quitting = true;
    stopSidecar();
  });
  app.on('window-all-closed', () => app.quit());
}
