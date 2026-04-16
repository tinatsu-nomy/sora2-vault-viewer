const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

const { buildIndex } = require("./indexer");
const { createStore } = require("./store");
const { createSerializers } = require("./http/serializers");
const { createListingService } = require("./search/listing");
const { createIndexState } = require("./state/index-state");

const fsp = fs.promises;

const DEFAULT_PORT = Number(process.env.PORT || 3210);
const MAX_PORT_ATTEMPTS = 20;
const SQLITE_SCHEMA_VERSION = "4";
const BIND_HOST = process.env.SORA_BIND_HOST || "127.0.0.1";
const ENABLE_SQLITE_CACHE = process.env.SORA_ENABLE_SQLITE_CACHE !== "0";
const DEBUG_MODE = process.env.SORA_VIEWER_DEBUG === "1";
const ROOT = process.env.SORA_VIEWER_ROOT
  ? path.resolve(process.env.SORA_VIEWER_ROOT)
  : path.resolve(__dirname, "..");
const DATA_DIR = process.env.SORA_DATA_DIR
  ? path.resolve(process.env.SORA_DATA_DIR)
  : path.join(ROOT, "sora2_data");
const PUBLIC_DIR = path.join(ROOT, "app", "public");
const APP_DATA_DIR = process.env.SORA_APP_DATA_DIR
  ? path.resolve(process.env.SORA_APP_DATA_DIR)
  : path.join(ROOT, "app", "data");
const DB_PATH = process.env.SORA_SQLITE_PATH || path.join(APP_DATA_DIR, "sora-index.sqlite");
const TXT_CACHE_PATH = path.join(APP_DATA_DIR, "txt-record-cache.json");

const SOURCE_DIRS = {
  v2_drafts: path.join(DATA_DIR, "sora_v2_drafts"),
  v2_liked: path.join(DATA_DIR, "sora_v2_liked"),
  v2_profile: path.join(DATA_DIR, "sora_v2_profile"),
};

const SOURCE_ORDER = ["v2_profile", "v2_liked", "v2_drafts"];

const store = createStore({
  enabled: ENABLE_SQLITE_CACHE,
  dbPath: DB_PATH,
  appDataDir: APP_DATA_DIR,
  schemaVersion: SQLITE_SCHEMA_VERSION,
});

const serializers = createSerializers({
  debugMode: DEBUG_MODE,
  enableSqliteCache: ENABLE_SQLITE_CACHE,
});

const listingService = createListingService({
  sourceOrder: SOURCE_ORDER,
  store,
  serializeListItem: serializers.serializeListItem,
  serializeListRow: serializers.serializeListRow,
});

const indexState = createIndexState({
  initialIndex: store.loadIndexMeta(),
  buildIndex: async () => {
    const builtIndex = await buildIndex({
      dataDir: DATA_DIR,
      sourceDirs: SOURCE_DIRS,
      databaseStatus: store.getStatus(),
      txtCachePath: TXT_CACHE_PATH,
    });
    store.persistIndex(builtIndex);
    builtIndex.stats.database = store.getStatus();
    return builtIndex;
  },
});

async function getIndexForRead() {
  const currentIndex = indexState.getCurrent();
  if (currentIndex) return currentIndex;
  return indexState.ensureReady();
}

function serializeIndexStatus(index) {
  const currentIndex = indexState.getCurrent();
  const hasCachedIndex = Boolean(currentIndex);
  const isRefreshing = Boolean(currentIndex) && currentIndex === index && indexState.isBuilding();
  const refreshError = hasCachedIndex && !indexState.isBuilding()
    ? indexState.getLastError()?.message || null
    : null;

  return {
    isRefreshing,
    isStale: isRefreshing,
    refreshError,
  };
}

function isPathInside(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath, contentType, extraHeaders = {}) {
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(response);
}

async function pathPointsToFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function handleRequest(request, response) {
  try {
    const host = request.headers.host || `${BIND_HOST}:${DEFAULT_PORT}`;
    const url = new URL(request.url, `http://${host}`);

    if (url.pathname === "/api/index") {
      const index = await getIndexForRead();
      const listing = listingService.listItems(index, url);
      return json(response, 200, {
        builtAt: index.builtAt,
        indexStatus: serializeIndexStatus(index),
        stats: serializers.serializeStats(index.stats, store.getStatus()),
        items: listing.items,
        pagination: listing.pagination,
      });
    }

    if (url.pathname.startsWith("/api/item/")) {
      const index = await getIndexForRead();
      const itemId = decodeURIComponent(url.pathname.replace("/api/item/", ""));
      const item = listingService.itemDetails(index, itemId);
      if (!item) return json(response, 404, { error: "Item not found" });
      return json(response, 200, serializers.serializeDetailItem(item));
    }

    if (url.pathname === "/api/rebuild" && request.method === "POST") {
      try {
        const rebuiltIndex = await indexState.startBuild();
        return json(response, 200, {
          ok: true,
          builtAt: rebuiltIndex.builtAt,
          stats: serializers.serializeStats(rebuiltIndex.stats, store.getStatus()),
        });
      } catch (error) {
        return json(response, 500, { error: "Failed to rebuild index", details: error.message });
      }
    }

    if (url.pathname === "/media") {
      const index = await getIndexForRead();
      const itemId = decodeURIComponent(url.searchParams.get("id") || "");
      const kind = url.searchParams.get("kind") || "media";
      const filePath = listingService.localFileForRequest(index, itemId, kind);
      if (!filePath || !(await pathPointsToFile(filePath))) {
        return json(response, 404, { error: "Media not found" });
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === ".mp4" ? "video/mp4" : ext === ".txt" ? "text/plain; charset=utf-8" : "application/octet-stream";
      return sendFile(response, filePath, contentType, {
        "Content-Disposition": serializers.contentDispositionInline(filePath),
      });
    }

    const assetPath = url.pathname === "/"
      ? path.join(PUBLIC_DIR, "index.html")
      : path.resolve(PUBLIC_DIR, `.${url.pathname}`);
    if (isPathInside(PUBLIC_DIR, assetPath) && await pathPointsToFile(assetPath)) {
      const ext = path.extname(assetPath).toLowerCase();
      const contentType =
        ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "text/html; charset=utf-8";
      return sendFile(response, assetPath, contentType);
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    const lastError = indexState.getLastError();
    const message = lastError && !indexState.getCurrent()
      ? lastError.message
      : error.message;
    if (!response.headersSent) {
      json(response, 500, {
        error: "Internal server error",
        details: message,
      });
      return;
    }
    response.destroy(error);
  }
}

async function logIndexSummary() {
  try {
    const index = indexState.isBuilding()
      ? await indexState.startBuild()
      : await indexState.ensureReady();
    console.log(`Indexed ${index.stats.totalItems} items`);
    if (index.stats.manifestErrors?.length) {
      console.warn(`Skipped ${index.stats.manifestErrors.length} malformed manifest file(s).`);
    }
  } catch (error) {
    console.error(`Initial index build failed: ${error.message}`);
  }
}

function startServer(port = DEFAULT_PORT, attempt = 0) {
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  let currentPort = port;
  let currentAttempt = attempt;

  function listenOnCurrentPort() {
    server.listen(currentPort, BIND_HOST);
  }

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && currentAttempt < MAX_PORT_ATTEMPTS) {
      const occupiedPort = currentPort;
      currentPort += 1;
      currentAttempt += 1;
      console.warn(`Port ${occupiedPort} is already in use. Retrying on ${currentPort}...`);
      setImmediate(listenOnCurrentPort);
      return;
    }

    throw error;
  });

  server.listen(currentPort, BIND_HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : currentPort;
    const displayHost = BIND_HOST === "127.0.0.1" ? "localhost" : BIND_HOST;
    console.log(`Sora2 Vault Viewer running at http://${displayHost}:${actualPort}`);
    void indexState.startBuild();
    void logIndexSummary();
    console.log("Press Ctrl+C in this terminal to stop the server.");
  });

  return server;
}

module.exports = {
  startServer,
};
