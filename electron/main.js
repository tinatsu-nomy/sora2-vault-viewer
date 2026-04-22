const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow, dialog, shell } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const SERVER_CWD = app.isPackaged ? process.resourcesPath : ROOT;
const CONFIG_VERSION = 1;
const APP_ICON_PATH = path.join(ROOT, "electron", "assets", "icon.png");
const SERVER_ENTRY_PATH = path.join(ROOT, "app", "server.js");
const SERVER_MAX_OLD_SPACE_MB = Math.max(1024, Number(process.env.SORA_SERVER_MAX_OLD_SPACE_MB || 4096) || 4096);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setAppUserModelId("local.sora2.vault-viewer");

const APP_DATA_DIR = process.env.SORA_APP_DATA_DIR
  ? path.resolve(process.env.SORA_APP_DATA_DIR)
  : path.join(app.getPath("userData"), "app-data");
const CONFIG_PATH = path.join(APP_DATA_DIR, "viewer-config.json");

process.env.SORA_APP_DATA_DIR = APP_DATA_DIR;
process.env.SORA_CONFIG_PATH = CONFIG_PATH;

function loadViewerConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function persistViewerConfig(config) {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

const loadedConfig = loadViewerConfig();

if (!process.env.SORA_DATA_DIR) {
  const packagedDataRoot = process.env.PORTABLE_EXECUTABLE_DIR
    ? path.resolve(process.env.PORTABLE_EXECUTABLE_DIR)
    : path.dirname(app.getPath("exe"));
  process.env.SORA_DATA_DIR = app.isPackaged
    ? path.resolve(loadedConfig.dataDir || path.join(packagedDataRoot, "sora2_data"))
    : path.join(ROOT, "sora2_data");
}

persistViewerConfig({
  ...loadedConfig,
  version: CONFIG_VERSION,
  appDataDir: APP_DATA_DIR,
  configPath: CONFIG_PATH,
  dataDir: process.env.SORA_DATA_DIR,
  portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
  updatedAt: new Date().toISOString(),
});

let mainWindow = null;
let localServer = null;
let serverOrigin = null;
let isQuitting = false;

async function ensureLocalServer() {
  if (localServer && serverOrigin) return serverOrigin;
  const child = spawn(process.execPath, [
    `--max-old-space-size=${SERVER_MAX_OLD_SPACE_MB}`,
    SERVER_ENTRY_PATH,
  ], {
    // In packaged builds, ROOT points at app.asar, which is a file and not a valid cwd.
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: `--max-old-space-size=${SERVER_MAX_OLD_SPACE_MB}`,
      PORT: "0",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  localServer = child;

  try {
    const port = await new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type !== "listening" || !message?.port) return;
        cleanup();
        resolve(message.port);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`The embedded viewer server exited before startup completed (code=${code ?? "null"}, signal=${signal || "none"}).`));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while waiting for the embedded viewer server to start."));
      }, 30000);
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };

      child.on("message", onMessage);
      child.on("error", onError);
      child.on("exit", onExit);
    });

    child.once("exit", () => {
      if (localServer === child) {
        localServer = null;
        serverOrigin = null;
      }
    });

    serverOrigin = `http://127.0.0.1:${port}`;
    return serverOrigin;
  } catch (error) {
    if (localServer === child) {
      localServer = null;
      serverOrigin = null;
    }
    try {
      child.kill();
    } catch {}
    throw error;
  }
}

function wireExternalNavigation(window, appUrl) {
  const appOrigin = new URL(appUrl).origin;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(appOrigin)) {
      return { action: "allow" };
    }

    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(appOrigin)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
}

async function createMainWindow() {
  const appUrl = await ensureLocalServer();

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#040404",
    icon: APP_ICON_PATH,
    title: "Sora2 Vault Viewer",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  wireExternalNavigation(mainWindow, appUrl);
  await mainWindow.loadURL(appUrl);
}

async function shutdownLocalServer() {
  if (!localServer) return;

  const server = localServer;
  localServer = null;
  serverOrigin = null;

  await new Promise((resolve) => {
    const finalize = () => resolve();
    server.once("exit", finalize);
    try {
      server.kill();
    } catch {
      resolve();
    }
  });
}

async function bootApplication() {
  try {
    await createMainWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Failed to start Sora2 Vault Viewer",
      error?.message || "The Electron shell could not start the embedded viewer server.",
    );
    app.quit();
  }
}

app.whenReady().then(bootApplication);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length > 0) return;
  void createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  void shutdownLocalServer().finally(() => {
    app.quit();
  });
});
