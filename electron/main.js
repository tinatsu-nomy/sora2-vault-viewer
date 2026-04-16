const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, shell } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_VERSION = 1;

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

const { startServer } = require("../app/server");

let mainWindow = null;
let localServer = null;
let serverOrigin = null;
let isQuitting = false;

function waitForServerListening(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      const address = server.address();
      if (typeof address === "object" && address?.port) {
        resolve(address.port);
        return;
      }
      reject(new Error("The local server did not expose a TCP port."));
      return;
    }

    const onListening = () => {
      cleanup();
      const address = server.address();
      if (typeof address === "object" && address?.port) {
        resolve(address.port);
        return;
      }
      reject(new Error("The local server did not expose a TCP port."));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };

    server.on("listening", onListening);
    server.on("error", onError);
  });
}

async function ensureLocalServer() {
  if (localServer && serverOrigin) return serverOrigin;

  localServer = startServer(0);
  const port = await waitForServerListening(localServer);
  serverOrigin = `http://127.0.0.1:${port}`;
  return serverOrigin;
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
    server.close(() => resolve());
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
