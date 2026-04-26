const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

const { buildIndex } = require("./indexer");
const { classifyDirEntry } = require("./fs-utils");
const { compareSourceKeys } = require("./indexing/common");
const { loadManifestSupplement } = require("./indexing/manifest");
const { createStore } = require("./store");
const { createSerializers } = require("./http/serializers");
const { createListingService } = require("./search/listing");
const { createIndexState } = require("./state/index-state");

const fsp = fs.promises;

const DEFAULT_PORT = Number(process.env.PORT || 3210);
const MAX_PORT_ATTEMPTS = 20;
const SQLITE_SCHEMA_VERSION = "7";
const BIND_HOST = process.env.SORA_BIND_HOST || "127.0.0.1";
const ENABLE_SQLITE_CACHE = process.env.SORA_ENABLE_SQLITE_CACHE !== "0";
const SQLITE_RENEW_ON_START = process.env.SORA_SQLITE_RENEW_ON_START === "1";
const DEBUG_MODE = process.env.SORA_VIEWER_DEBUG === "1";
const ROOT = process.env.SORA_VIEWER_ROOT
  ? path.resolve(process.env.SORA_VIEWER_ROOT)
  : path.resolve(__dirname, "..");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const DATA_DIR = process.env.SORA_DATA_DIR
  ? path.resolve(process.env.SORA_DATA_DIR)
  : path.join(ROOT, "sora2_data");
const PUBLIC_DIR = path.join(ROOT, "app", "public");
const APP_DATA_DIR = process.env.SORA_APP_DATA_DIR
  ? path.resolve(process.env.SORA_APP_DATA_DIR)
  : path.join(ROOT, "app", "data");
const DB_PATH = process.env.SORA_SQLITE_PATH || path.join(APP_DATA_DIR, "sora-index.sqlite");
const TXT_CACHE_PATH = path.join(APP_DATA_DIR, "txt-record-cache.json");
const SQLITE_RENEW_MARKER_PATH = path.join(APP_DATA_DIR, "sqlite-renew-next-start.json");
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
const CONFIG_PATH = process.env.SORA_CONFIG_PATH
  ? path.resolve(process.env.SORA_CONFIG_PATH)
  : null;
const AVATAR_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg"];
const APP_VERSION = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
    return parsed?.displayVersion
      ? String(parsed.displayVersion)
      : parsed?.version
        ? String(parsed.version)
        : null;
  } catch {
    return null;
  }
})();

function compactIndexForMemory(index) {
  return {
    builtAt: index.builtAt,
    stats: index.stats,
    items: [],
  };
}

function readRenewNextStartMarker() {
  try {
    const raw = fs.readFileSync(SQLITE_RENEW_MARKER_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { requestedAt: null };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return {
      requestedAt: null,
      invalid: true,
      error: error.message,
    };
  }
}

function isRenewNextStartScheduled(marker) {
  return Boolean(marker && !marker.consumedAt && !marker.cancelledAt);
}

function consumeRenewNextStartMarker(marker) {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  const payload = {
    ...(marker && typeof marker === "object" ? marker : {}),
    consumedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SQLITE_RENEW_MARKER_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function scheduleRenewNextStart() {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  const payload = {
    requestedAt: new Date().toISOString(),
    mode: "sqlite-renew-on-start",
    consumedAt: null,
    cancelledAt: null,
  };
  fs.writeFileSync(SQLITE_RENEW_MARKER_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function cancelRenewNextStart(marker) {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  const payload = {
    ...(marker && typeof marker === "object" ? marker : {}),
    cancelledAt: new Date().toISOString(),
  };
  fs.writeFileSync(SQLITE_RENEW_MARKER_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function discoverSourceDirs(dataDir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const sourceDirs = {};
  for (const entry of entries) {
    const resolvedEntry = await classifyDirEntry(dataDir, entry);
    if (resolvedEntry.type !== "directory") continue;
    if (!/^sora_v2_.+/i.test(entry.name)) continue;
    if (/^sora_v2_remixes$/i.test(entry.name)) {
      const nestedSources = [
        ["v2_remix_children", "downstream"],
        ["v2_remix_parents", "parents"],
      ];

      for (const [sourceKey, childName] of nestedSources) {
        const nestedPath = path.join(resolvedEntry.path, childName);
        try {
          const nestedStats = await fsp.stat(nestedPath);
          if (nestedStats.isDirectory()) {
            sourceDirs[sourceKey] = nestedPath;
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      continue;
    }

    const sourceKey = entry.name.replace(/^sora_/i, "");
    sourceDirs[sourceKey] = resolvedEntry.path;
  }

  return sourceDirs;
}

const store = createStore({
  enabled: ENABLE_SQLITE_CACHE,
  dbPath: DB_PATH,
  appDataDir: APP_DATA_DIR,
  schemaVersion: SQLITE_SCHEMA_VERSION,
});

const persistedRenewMarker = readRenewNextStartMarker();
const persistedRenewRequested = isRenewNextStartScheduled(persistedRenewMarker);
const shouldRenewOnStart = SQLITE_RENEW_ON_START || persistedRenewRequested;
const startupCacheState = {
  renewRequested: shouldRenewOnStart,
  renewCompleted: false,
  renewError: null,
  renewSource: SQLITE_RENEW_ON_START
    ? "env"
    : persistedRenewRequested
      ? "next-start"
      : null,
  markerRequestedAt: persistedRenewMarker?.requestedAt || null,
  markerInvalid: Boolean(persistedRenewMarker?.invalid),
  markerConsumeError: null,
};

if (persistedRenewRequested) {
  try {
    consumeRenewNextStartMarker(persistedRenewMarker);
  } catch (error) {
    startupCacheState.markerConsumeError = error;
  }
}

if (shouldRenewOnStart && ENABLE_SQLITE_CACHE) {
  try {
    store.clearPersistedCache();
    startupCacheState.renewCompleted = true;
  } catch (error) {
    startupCacheState.renewError = error;
  }
}

const serializers = createSerializers({
    debugMode: DEBUG_MODE,
    enableSqliteCache: ENABLE_SQLITE_CACHE,
    runtimePaths: {
      appVersion: APP_VERSION,
      dataDir: DATA_DIR,
      appDataDir: APP_DATA_DIR,
      dbPath: DB_PATH,
    txtCachePath: TXT_CACHE_PATH,
    configPath: CONFIG_PATH,
    publicDir: PUBLIC_DIR,
  },
});

const listingService = createListingService({
  sourceOrder: [],
  store,
  serializeListItem: serializers.serializeListItem,
  serializeListRow: serializers.serializeListRow,
});

const indexState = createIndexState({
  initialIndex: shouldRenewOnStart ? null : store.loadIndexMeta(),
  buildIndex: async ({ reportProgress } = {}) => {
    const sourceDirs = await discoverSourceDirs(DATA_DIR);
    reportProgress?.({
      phase: "preparing",
      message: "Preparing source directories...",
      detail: `${Object.keys(sourceDirs).length} sources discovered`,
      current: Object.keys(sourceDirs).length,
      total: Object.keys(sourceDirs).length,
      unit: "source",
    });
    const builtIndex = await buildIndex({
      dataDir: DATA_DIR,
      sourceDirs,
      databaseStatus: store.getStatus(),
      txtCachePath: TXT_CACHE_PATH,
      sourceOrder: Object.keys(sourceDirs).sort(compareSourceKeys),
      onProgress: reportProgress,
    });
    reportProgress?.({
      phase: "persisting-sqlite",
      message: "Writing the rebuilt SQLite cache...",
      detail: DB_PATH,
      current: builtIndex.items.length,
      total: builtIndex.items.length,
      unit: "item",
    });
    store.persistIndex(builtIndex);
    builtIndex.stats.database = store.getStatus();
    if (builtIndex.stats.database?.enabled) {
      return compactIndexForMemory(builtIndex);
    }
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
    buildProgress: indexState.getBuildProgress(),
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

function mimeTypeForExt(ext) {
  switch (ext) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".mp4":
      return "video/mp4";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function normalizeAvatarValue(value) {
  return String(value || "").trim();
}

function dedupeAvatarValues(values) {
  return values.filter((value, index, allValues) => allValues.indexOf(value) === index);
}

function avatarNameVariants(value) {
  const rawValue = normalizeAvatarValue(value);
  if (!rawValue) return [];
  const withoutAt = rawValue.replace(/^@+/, "");
  return dedupeAvatarValues([
    rawValue,
    withoutAt,
    withoutAt ? `@${withoutAt}` : null,
  ].filter(Boolean));
}

function avatarDirectoryCandidates(ownerUsername) {
  return dedupeAvatarValues(
    avatarNameVariants(ownerUsername)
      .flatMap((value) => [
        `sora_characters_${value}`,
        `sora_characters_@${value}`,
      ]),
  );
}

function avatarStemVariants(prefix, value) {
  return avatarNameVariants(value).map((candidate) => `${prefix}${candidate}`.toLowerCase());
}

function avatarIdentityForItem(item, role, requestedUsername) {
  if (!item) return null;
  if (role === "poster") {
    const username = normalizeAvatarValue(item.posterUsername).replace(/^@+/, "");
    const searchOwnerUsernames = dedupeAvatarValues([
      normalizeAvatarValue(item.posterUsername),
      normalizeAvatarValue(item.ownerUsername),
      ...(item.ownerUsernames || []).map((value) => normalizeAvatarValue(value)),
    ].filter(Boolean));
    return {
      userId: item.profileUserId || null,
      username: username || null,
      ownerUsername: username || null,
      searchOwnerUsernames,
    };
  }

  if (role === "cameo") {
    const normalizedUsername = normalizeAvatarValue(requestedUsername).replace(/^@+/, "");
    const matchedProfile = (item.cameoProfiles || []).find((profile) => {
      return normalizeAvatarValue(profile?.username).replace(/^@+/, "") === normalizedUsername;
    });
    const username = matchedProfile?.username || normalizedUsername || null;
    const profileOwnerUsername = normalizeAvatarValue(matchedProfile?.ownerUsername);
    const derivedOwnerUsername = username ? username.split(".")[0] : null;
    const searchOwnerUsernames = dedupeAvatarValues([
      normalizeAvatarValue(item.posterUsername),
      normalizeAvatarValue(item.ownerUsername),
      ...(item.ownerUsernames || []).map((value) => normalizeAvatarValue(value)),
      profileOwnerUsername,
      normalizeAvatarValue(derivedOwnerUsername),
      normalizeAvatarValue(username),
    ].filter(Boolean));
    return {
      userId: matchedProfile?.userId || null,
      username,
      ownerUsername: profileOwnerUsername || derivedOwnerUsername,
      searchOwnerUsernames,
    };
  }

  return null;
}

function avatarSearchDirs(identity) {
  const dirs = dedupeAvatarValues(
    (identity?.searchOwnerUsernames || [identity?.ownerUsername])
      .filter(Boolean)
      .flatMap((ownerUsername) => avatarDirectoryCandidates(ownerUsername))
      .map((dirName) => path.join(DATA_DIR, dirName)),
  );

  dirs.push(
    path.join(AVATAR_DIR, "cameo"),
    path.join(AVATAR_DIR, "users"),
    path.join(AVATAR_DIR, "profiles"),
    AVATAR_DIR,
  );

  return dirs;
}

function avatarCandidateNames(identity) {
  const values = [identity?.userId, identity?.username, identity?.username ? `@${identity.username}` : null]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, allValues) => allValues.indexOf(value) === index)
    .filter((value) => !/[\\/]/.test(value));

  return values.flatMap((value) => AVATAR_EXTENSIONS.map((ext) => `${value}${ext}`));
}

async function resolveCharacterAvatarPath(identity, role) {
  const baseDirs = dedupeAvatarValues(
    (identity?.searchOwnerUsernames || [identity?.ownerUsername])
      .filter(Boolean)
      .flatMap((ownerUsername) => avatarDirectoryCandidates(ownerUsername))
      .map((dirName) => path.join(DATA_DIR, dirName)),
  );

  if (!baseDirs.length) return null;

  const expectedStems = role === "poster"
    ? avatarStemVariants("owner_", identity.ownerUsername || identity.username || "")
    : [
        ...avatarStemVariants("character_", identity.username || ""),
        ...avatarStemVariants("owner_", identity.username || ""),
      ];
  const normalizedExpectedStems = dedupeAvatarValues(expectedStems.filter(Boolean));

  for (const baseDir of baseDirs) {
    if (!isPathInside(DATA_DIR, baseDir)) continue;

    let entries = [];
    try {
      entries = await fsp.readdir(baseDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AVATAR_EXTENSIONS.includes(ext)) continue;
      const stem = path.basename(entry.name, ext);
      const normalizedStem = stem.toLowerCase();
      if (normalizedExpectedStems.some((expectedStem) => {
        return normalizedStem === expectedStem || normalizedStem.startsWith(`${expectedStem}_`);
      })) {
        return path.join(baseDir, entry.name);
      }
    }
  }

  return null;
}

async function resolveAvatarPath(item, role, requestedUsername) {
  const identity = avatarIdentityForItem(item, role, requestedUsername);
  if (!identity) return null;

  const characterAvatarPath = await resolveCharacterAvatarPath(identity, role);
  if (characterAvatarPath) return characterAvatarPath;

  const candidateNames = avatarCandidateNames(identity);
  if (!candidateNames.length) return null;

  for (const baseDir of avatarSearchDirs(identity)) {
    for (const fileName of candidateNames) {
      const filePath = path.join(baseDir, fileName);
      const allowedRoot = isPathInside(AVATAR_DIR, filePath) ? AVATAR_DIR : DATA_DIR;
      if (!isPathInside(allowedRoot, filePath)) continue;
      if (await pathPointsToFile(filePath)) return filePath;
    }
  }

  return null;
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
      const detailItem = { ...item };
      if (detailItem.manifestFile) {
        try {
          detailItem.manifestSupplement = await loadManifestSupplement(detailItem.manifestFile, detailItem);
        } catch (error) {
          detailItem.manifestSupplementError = `${error.code || "MANIFEST_SUPPLEMENT_ERROR"}: ${error.message}`;
        }
      }
      return json(response, 200, serializers.serializeDetailItem(detailItem));
    }

    if (url.pathname === "/api/posters") {
      const index = await getIndexForRead();
      return json(response, 200, {
        items: listingService.listPosterUsernames(index, url),
      });
    }

    if (url.pathname === "/api/identifiers") {
      const index = await getIndexForRead();
      const field = String(url.searchParams.get("field") || "genId");
      if (!["postId", "genId", "taskId"].includes(field)) {
        return json(response, 400, { error: "Invalid identifier field" });
      }
      return json(response, 200, {
        items: listingService.listIdentifiers(index, url, field),
      });
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

    if (url.pathname === "/api/build-status" && request.method === "GET") {
      const currentIndex = indexState.getCurrent();
      return json(response, 200, {
        builtAt: currentIndex?.builtAt || null,
        hasCachedIndex: Boolean(currentIndex),
        isBuilding: indexState.isBuilding(),
        lastError: indexState.getLastError()?.message || null,
        progress: indexState.getBuildProgress(),
      });
    }

    if (url.pathname === "/api/renew-on-start" && request.method === "GET") {
      const marker = readRenewNextStartMarker();
      return json(response, 200, {
        scheduled: isRenewNextStartScheduled(marker),
        requestedAt: marker?.requestedAt || null,
        consumedAt: marker?.consumedAt || null,
        cancelledAt: marker?.cancelledAt || null,
      });
    }

    if (url.pathname === "/api/renew-on-start" && request.method === "POST") {
      if (!ENABLE_SQLITE_CACHE) {
        return json(response, 409, {
          error: "SQLite cache is disabled",
          details: "Enable the SQLite cache before scheduling renew-on-start.",
        });
      }

      try {
        const marker = scheduleRenewNextStart();
        return json(response, 200, {
          ok: true,
          scheduled: true,
          requestedAt: marker.requestedAt,
        });
      } catch (error) {
        return json(response, 500, {
          error: "Failed to schedule renew-on-start",
          details: error.message,
        });
      }
    }

    if (url.pathname === "/api/renew-on-start" && request.method === "DELETE") {
      if (!ENABLE_SQLITE_CACHE) {
        return json(response, 409, {
          error: "SQLite cache is disabled",
          details: "Enable the SQLite cache before changing renew-on-start.",
        });
      }

      try {
        const marker = cancelRenewNextStart(readRenewNextStartMarker());
        return json(response, 200, {
          ok: true,
          scheduled: false,
          cancelledAt: marker.cancelledAt,
        });
      } catch (error) {
        return json(response, 500, {
          error: "Failed to cancel renew-on-start",
          details: error.message,
        });
      }
    }

    if (url.pathname === "/avatar") {
      const index = await getIndexForRead();
      const itemId = decodeURIComponent(url.searchParams.get("id") || "");
      const role = String(url.searchParams.get("role") || "poster").toLowerCase();
      const requestedUsername = decodeURIComponent(url.searchParams.get("username") || "");
      if (!itemId || !["poster", "cameo"].includes(role)) {
        return json(response, 400, { error: "Invalid avatar request" });
      }

      const item = listingService.itemDetails(index, itemId);
      if (!item) return json(response, 404, { error: "Item not found" });

      const filePath = await resolveAvatarPath(item, role, requestedUsername);
      if (!filePath) {
        response.writeHead(404, {
          "Cache-Control": "no-store, max-age=0",
          Pragma: "no-cache",
          Expires: "0",
        });
        response.end();
        return;
      }

      return sendFile(response, filePath, mimeTypeForExt(path.extname(filePath).toLowerCase()));
    }

    if (url.pathname === "/media") {
      const index = await getIndexForRead();
      const itemId = decodeURIComponent(url.searchParams.get("id") || "");
      const kind = url.searchParams.get("kind") || "media";
      const filePath = listingService.localFileForRequest(index, itemId, kind);
      if (!filePath || !(await pathPointsToFile(filePath))) {
        return json(response, 404, { error: "Media not found" });
      }

      return sendFile(response, filePath, mimeTypeForExt(path.extname(filePath).toLowerCase()), {
        "Content-Disposition": serializers.contentDispositionInline(filePath),
      });
    }

    const assetPath = url.pathname === "/"
      ? path.join(PUBLIC_DIR, "index.html")
      : path.resolve(PUBLIC_DIR, `.${url.pathname}`);
    if (isPathInside(PUBLIC_DIR, assetPath) && await pathPointsToFile(assetPath)) {
      const ext = path.extname(assetPath).toLowerCase();
      const contentType = ext === ".html" ? "text/html; charset=utf-8" : mimeTypeForExt(ext);
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
    const currentIndex = indexState.getCurrent();
    const index = currentIndex
      || (indexState.isBuilding()
        ? await indexState.startBuild()
        : await indexState.ensureReady());
    console.log(`Indexed ${index.stats.totalItems} items`);
    if (index.stats.manifestErrors?.length) {
      console.warn(`Skipped ${index.stats.manifestErrors.length} malformed manifest file(s).`);
    }
  } catch (error) {
    console.error(`Initial index build failed: ${error.message}`);
  }
}

function startupLogLines(port) {
  return [
    `Viewer URL: http://${BIND_HOST === "127.0.0.1" ? "localhost" : BIND_HOST}:${port}`,
    `Data directory: ${DATA_DIR}`,
    `App data directory: ${APP_DATA_DIR}`,
    CONFIG_PATH ? `Config file: ${CONFIG_PATH}` : null,
    `SQLite cache: ${ENABLE_SQLITE_CACHE ? DB_PATH : "disabled by environment"}`,
    `TXT cache: ${TXT_CACHE_PATH}`,
  ].filter(Boolean);
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
    if (typeof process.send === "function") {
      try {
        process.send({
          type: "listening",
          host: BIND_HOST,
          port: actualPort,
        });
      } catch {}
    }
    console.log(`Sora2 Vault Viewer running at http://${displayHost}:${actualPort}`);
    for (const line of startupLogLines(actualPort)) {
      console.log(line);
    }
    if (startupCacheState.renewRequested && !ENABLE_SQLITE_CACHE) {
      console.log("SQLite renew-on-start was requested, but the SQLite cache is disabled.");
    } else if (startupCacheState.markerInvalid) {
      console.warn("The persisted renew-on-start marker was unreadable. Treating it as a one-shot renew request.");
    } else if (startupCacheState.markerConsumeError) {
      console.warn(`Failed to consume the renew-on-start marker: ${startupCacheState.markerConsumeError.message}`);
    } else if (startupCacheState.renewRequested && startupCacheState.renewError) {
      console.warn(`SQLite renew-on-start failed: ${startupCacheState.renewError.message}`);
    } else if (startupCacheState.renewCompleted) {
      console.log(
        startupCacheState.renewSource === "next-start"
          ? "SQLite renew-on-start cleared the cached database from a next-start request before rebuilding."
          : "SQLite renew-on-start cleared the cached database before rebuilding.",
      );
    }
    if (indexState.getCurrent()) {
      void logIndexSummary();
      console.log("Using cached SQLite index at startup. Automatic rescan is disabled.");
      console.log("Use the Rescan button when you want to rebuild the cache from manifests and local files.");
    } else {
      void indexState.startBuild();
      void logIndexSummary();
    }
    console.log("Press Ctrl+C in this terminal to stop the server.");
  });

  return server;
}

module.exports = {
  startServer,
};
