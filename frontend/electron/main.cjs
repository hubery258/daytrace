const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

let mainWindow = null;
let sidecar = null;
let quitting = false;

/** Legacy v0.11.0 migration store; new WebDAV saves use the sidecar SQLite row. */
const SECRETS_FILE = () => path.join(app.getPath('userData'), 'desktop-secrets.json');
const SECRET_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function readSecrets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSecrets(secrets) {
  fs.writeFileSync(SECRETS_FILE(), JSON.stringify(secrets), { mode: 0o600 });
}

function requireSecretKey(key) {
  if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key)) throw new Error('secret key is invalid');
  return key;
}

function registerSecretHandlers() {
  ipcMain.handle('riji-secure:set', (_event, key, value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage is unavailable');
    if (typeof value !== 'string' || value.length === 0) throw new Error('secret value is invalid');
    const secrets = readSecrets();
    secrets[requireSecretKey(key)] = safeStorage.encryptString(value).toString('base64');
    writeSecrets(secrets);
    return true;
  });
  ipcMain.handle('riji-secure:get', (_event, key) => {
    const stored = readSecrets()[requireSecretKey(key)];
    if (typeof stored !== 'string' || !stored) return null;
    try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { return null; }
  });
  ipcMain.handle('riji-secure:remove', (_event, key) => {
    const secrets = readSecrets();
    const name = requireSecretKey(key);
    if (!Object.hasOwn(secrets, name)) return false;
    delete secrets[name];
    writeSecrets(secrets);
    return true;
  });
}

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
    ? path.join(process.resourcesPath, 'sidecar', process.platform === 'win32' ? 'daytrace-sidecar.exe' : 'daytrace-sidecar')
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
        preload: path.join(__dirname, 'preload.cjs'),
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
  app.whenReady().then(() => {
    registerSecretHandlers();
    return createWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    stopSidecar();
  });
  app.on('window-all-closed', () => app.quit());
}
