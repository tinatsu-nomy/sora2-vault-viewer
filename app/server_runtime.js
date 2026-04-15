const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

const { buildIndex, parseDateValue, parseJson, slugForText } = require("./indexer");
const { createStore } = require("./store");

const fsp = fs.promises;

const DEFAULT_PORT = Number(process.env.PORT || 3210);
const MAX_PORT_ATTEMPTS = 20;
const SQLITE_SCHEMA_VERSION = "3";
const BIND_HOST = process.env.SORA_BIND_HOST || "127.0.0.1";
const ENABLE_SQLITE_CACHE = process.env.SORA_ENABLE_SQLITE_CACHE === "1";
const DEBUG_MODE = process.env.SORA_VIEWER_DEBUG === "1";
const ROOT = process.env.SORA_VIEWER_ROOT
  ? path.resolve(process.env.SORA_VIEWER_ROOT)
  : path.resolve(__dirname, "..");
const DATA_DIR = process.env.SORA_DATA_DIR
  ? path.resolve(process.env.SORA_DATA_DIR)
  : path.join(ROOT, "sora2_data");
const PUBLIC_DIR = path.join(ROOT, "app", "public");
const APP_DATA_DIR = path.join(ROOT, "app", "data");
const DB_PATH = process.env.SORA_SQLITE_PATH || path.join(APP_DATA_DIR, "sora-index.sqlite");

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

const indexState = {
  current: store.loadIndexMeta(),
  buildPromise: null,
  lastError: null,
};

function parseSearchQuery(value) {
  if (value == null) {
    return {
      textQuery: "",
      usernamePrefixes: [],
    };
  }

  const terms = String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const textTerms = [];
  const usernamePrefixes = [];

  for (const term of terms) {
    if (!term.startsWith("@")) {
      textTerms.push(term);
      continue;
    }

    const normalizedUsername = term.replace(/^@+/, "").trim();
    if (normalizedUsername) {
      usernamePrefixes.push(slugForText(normalizedUsername));
    }
  }

  return {
    textQuery: slugForText(textTerms.join(" ")),
    usernamePrefixes,
  };
}

function isPathInside(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function buildFtsMatchQuery(query) {
  const terms = String(query || "")
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (!terms.length) return null;
  if (terms.some((term) => /["':*()\-]/.test(term))) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

async function buildAndCacheIndex() {
  const builtIndex = await buildIndex({
    dataDir: DATA_DIR,
    sourceDirs: SOURCE_DIRS,
    databaseStatus: store.getStatus(),
  });
  store.persistIndex(builtIndex);
  builtIndex.stats.database = store.getStatus();
  indexState.current = builtIndex;
  indexState.lastError = null;
  return builtIndex;
}

function startIndexBuild() {
  if (indexState.buildPromise) {
    return indexState.buildPromise;
  }

  indexState.buildPromise = buildAndCacheIndex()
    .catch((error) => {
      indexState.lastError = error;
      throw error;
    })
    .finally(() => {
      indexState.buildPromise = null;
    });

  return indexState.buildPromise;
}

async function ensureIndexReady() {
  if (indexState.current) return indexState.current;
  return startIndexBuild();
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function mediaUrlFor(itemId, kind = "media") {
  return `/media?id=${encodeURIComponent(itemId)}&kind=${encodeURIComponent(kind)}`;
}

function fileNameOnly(filePath) {
  return path.basename(String(filePath || ""));
}

function contentDispositionInline(filePath) {
  const fileName = path.basename(filePath);
  const safeAsciiName = fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  const encodedName = encodeURIComponent(fileName);
  return `inline; filename="${safeAsciiName}"; filename*=UTF-8''${encodedName}`;
}

function sendFile(response, filePath, contentType, extraHeaders = {}) {
  response.writeHead(200, { "Content-Type": contentType, ...extraHeaders });
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

function parseListParams(url) {
  const searchQuery = parseSearchQuery(url.searchParams.get("query"));
  const query = searchQuery.textQuery;
  const source = url.searchParams.get("source");
  const hasSourcesParam = url.searchParams.has("sources");
  const sources = url.searchParams
    .get("sources")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) || [];
  const localOnly = url.searchParams.get("localOnly") === "1";
  const withText = url.searchParams.get("withText") === "1";
  const withMedia = url.searchParams.get("withMedia") === "1";
  const dateFrom = parseDateValue(url.searchParams.get("dateFrom"));
  const dateTo = parseDateValue(url.searchParams.get("dateTo"), { endOfDayIfDateOnly: true });
  const sort = url.searchParams.get("sort") || "date-desc";
  const requestedLimit = Number(url.searchParams.get("limit") || 180);
  const requestedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 180, 240));
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);

  return {
    query,
    usernamePrefixes: searchQuery.usernamePrefixes,
    source,
    hasSourcesParam,
    sources,
    localOnly,
    withText,
    withMedia,
    dateFrom,
    dateTo,
    sort,
    limit,
    offset,
  };
}

function serializeListItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    date: item.date,
    prompt: item.prompt,
    genId: item.genId,
    generationId: item.generationId,
    taskId: item.taskId,
    postId: item.postId,
    duration: item.duration,
    ratio: item.ratio,
    width: item.width,
    height: item.height,
    likeCount: item.likeCount,
    viewCount: item.viewCount,
    posterUsername: item.posterUsername || null,
    cameoOwnerUsernames: item.cameoOwnerUsernames || [],
    isLiked: item.isLiked,
    previewUrl: DEBUG_MODE ? item.previewUrl : null,
    downloadUrl: DEBUG_MODE ? item.downloadUrl : null,
    thumbUrl: DEBUG_MODE ? item.thumbUrl : null,
    mediaUrl: item.hasLocalMedia ? mediaUrlFor(item.id, "media") : null,
    hasLocalMedia: item.hasLocalMedia,
    hasLocalText: item.hasLocalText,
  };
}

function serializeListRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    date: row.date,
    prompt: row.prompt,
    genId: row.genId,
    generationId: row.generationId,
    taskId: row.taskId,
    postId: row.postId,
    duration: row.duration,
    ratio: row.ratio,
    width: row.width,
    height: row.height,
    likeCount: row.likeCount,
    viewCount: row.viewCount,
    posterUsername: row.posterUsername || null,
    cameoOwnerUsernames: parseJson(row.cameoOwnerUsernamesJson, []),
    isLiked: Boolean(row.isLiked),
    previewUrl: DEBUG_MODE ? row.previewUrl : null,
    downloadUrl: DEBUG_MODE ? row.downloadUrl : null,
    thumbUrl: DEBUG_MODE ? row.thumbUrl : null,
    mediaUrl: row.hasLocalMedia ? mediaUrlFor(row.id, "media") : null,
    hasLocalMedia: Boolean(row.hasLocalMedia),
    hasLocalText: Boolean(row.hasLocalText),
  };
}

function serializeStats(stats) {
  const databaseStatus = store.getStatus();
  return {
    totalItems: stats.totalItems,
    manifestItems: stats.manifestItems,
    localOnlyItems: stats.localOnlyItems,
    withLocalMedia: stats.withLocalMedia,
    withLocalText: stats.withLocalText,
    sources: stats.sources,
    manifests: (stats.manifests || []).map((manifest) => ({
      file: fileNameOnly(manifest.file),
      exportedAt: manifest.exportedAt || null,
      total: manifest.total ?? null,
    })),
    manifestErrors: (stats.manifestErrors || []).map((entry) => ({
      file: fileNameOnly(entry.file),
      error: entry.error,
    })),
    database: {
      enabled: Boolean(databaseStatus.enabled),
      savedItems: Number(databaseStatus.savedItems || 0),
      error: databaseStatus.error || null,
      configured: ENABLE_SQLITE_CACHE,
    },
    debugEnabled: DEBUG_MODE,
  };
}

function serializeDetailItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    date: item.date,
    prompt: item.prompt,
    genId: item.genId,
    generationId: item.generationId,
    taskId: item.taskId,
    postId: item.postId,
    width: item.width,
    height: item.height,
    ratio: item.ratio,
    duration: item.duration,
    likeCount: item.likeCount,
    viewCount: item.viewCount,
    posterUsername: item.posterUsername || null,
    cameoOwnerUsernames: item.cameoOwnerUsernames || [],
    hasLocalMedia: item.hasLocalMedia,
    hasLocalText: item.hasLocalText,
    mediaUrl: item.hasLocalMedia ? mediaUrlFor(item.id, "media") : null,
    previewUrl: DEBUG_MODE ? item.previewUrl : null,
    downloadUrl: DEBUG_MODE ? item.downloadUrl : null,
    thumbUrl: DEBUG_MODE ? item.thumbUrl : null,
    permalink: DEBUG_MODE ? item.raw?._raw?.post?.permalink || null : null,
    local: item.local
      ? {
          txtEncoding: item.local.txtEncoding || null,
          txtRaw: item.local.txtRaw || null,
          txtPrompt: item.local.txtPrompt || null,
          parsed: item.local.parsed || null,
          txtUrl: item.hasLocalText ? mediaUrlFor(item.id, "txt") : null,
        }
      : null,
    debug: DEBUG_MODE
      ? {
          manifestFile: item.manifestFile || null,
          localMediaPath: item.local?.mediaPath || null,
          localTxtPath: item.local?.txtPath || null,
          raw: item.raw || null,
        }
      : null,
  };
}

function usernamePrefixLikePattern(prefix) {
  return `${escapeLikePattern(prefix)}%`;
}

function usernameJsonPrefixLikePattern(prefix) {
  return `%\"${escapeLikePattern(prefix)}%`;
}

function itemMatchesUsernamePrefixes(item, prefixes) {
  if (!prefixes?.length) return true;
  const usernames = new Set(
    [
      item?.posterUsername,
      ...(item?.ownerUsernames || []),
      ...(item?.cameoOwnerUsernames || []),
    ]
      .filter(Boolean)
      .map((value) => slugForText(value)),
  );

  return prefixes.every((prefix) => {
    for (const username of usernames) {
      if (username.startsWith(prefix)) return true;
    }
    return false;
  });
}

function listItemsFromDb(params) {
  const joins = [];
  const where = [];
  const values = [];

  if (params.query) {
    const ftsQuery = buildFtsMatchQuery(params.query);
    if (ftsQuery) {
      joins.push("JOIN items_fts ON items_fts.id = items.id");
      where.push("items_fts MATCH ?");
      values.push(ftsQuery);
    } else {
      where.push("items.search_text LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLikePattern(params.query)}%`);
    }
  }

  for (const prefix of params.usernamePrefixes) {
    where.push(`(
      LOWER(COALESCE(items.poster_username, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(items.owner_usernames_json, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(items.cameo_owner_usernames_json, '')) LIKE ? ESCAPE '\\'
    )`);
    values.push(
      usernamePrefixLikePattern(prefix),
      usernameJsonPrefixLikePattern(prefix),
      usernameJsonPrefixLikePattern(prefix),
    );
  }

  if (params.hasSourcesParam) {
    if (!params.sources.length) {
      return {
        items: [],
        pagination: {
          total: 0,
          limit: params.limit,
          offset: 0,
          page: 0,
          totalPages: 0,
          hasPrevious: false,
          hasNext: false,
        },
      };
    }
    where.push(`items.source IN (${params.sources.map(() => "?").join(", ")})`);
    values.push(...params.sources);
  } else if (params.source && params.source !== "all") {
    where.push("items.source = ?");
    values.push(params.source);
  }

  if (params.localOnly) where.push("(items.has_local_media = 1 OR items.has_local_text = 1)");
  if (params.withText) where.push("items.has_local_text = 1");
  if (params.withMedia) where.push("items.has_local_media = 1");
  if (params.dateFrom != null) {
    where.push("items.date_sort_ms IS NOT NULL AND items.date_sort_ms >= ?");
    values.push(params.dateFrom);
  }
  if (params.dateTo != null) {
    where.push("items.date_sort_ms IS NOT NULL AND items.date_sort_ms <= ?");
    values.push(params.dateTo);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = (() => {
    switch (params.sort) {
      case "date-asc":
        return "ORDER BY COALESCE(items.date_sort_ms, -9223372036854775808) ASC, items.id ASC";
      case "views-desc":
        return "ORDER BY COALESCE(items.view_count, 0) DESC, COALESCE(items.date_sort_ms, -9223372036854775808) DESC, items.id DESC";
      case "views-asc":
        return "ORDER BY COALESCE(items.view_count, 0) ASC, COALESCE(items.date_sort_ms, -9223372036854775808) ASC, items.id ASC";
      case "likes-desc":
        return "ORDER BY COALESCE(items.like_count, 0) DESC, COALESCE(items.date_sort_ms, -9223372036854775808) DESC, items.id DESC";
      case "likes-asc":
        return "ORDER BY COALESCE(items.like_count, 0) ASC, COALESCE(items.date_sort_ms, -9223372036854775808) ASC, items.id ASC";
      case "prompt-asc":
        return "ORDER BY COALESCE(items.prompt, '') COLLATE NOCASE ASC, items.id ASC";
      case "prompt-desc":
        return "ORDER BY COALESCE(items.prompt, '') COLLATE NOCASE DESC, items.id DESC";
      case "duration-asc":
        return "ORDER BY COALESCE(items.duration_sort, 0) ASC, items.id ASC";
      case "duration-desc":
        return "ORDER BY COALESCE(items.duration_sort, 0) DESC, items.id DESC";
      case "source-asc":
        return `
          ORDER BY CASE items.source
            WHEN 'v2_profile' THEN 0
            WHEN 'v2_liked' THEN 1
            WHEN 'v2_drafts' THEN 2
            ELSE 9
          END ASC,
          COALESCE(items.date_sort_ms, -9223372036854775808) ASC,
          items.id ASC
        `;
      case "date-desc":
      default:
        return "ORDER BY COALESCE(items.date_sort_ms, -9223372036854775808) DESC, items.id DESC";
    }
  })();

  const queryResult = store.queryItems({
    joins,
    whereClause,
    orderBy,
    values,
    limit: params.limit,
    offset: params.offset,
  });
  if (!queryResult) return null;

  return {
    items: queryResult.rows.map(serializeListRow),
    pagination: queryResult.pagination,
  };
}

function listItems(index, url) {
  const params = parseListParams(url);
  const dbListing = listItemsFromDb(params);
  if (dbListing) return dbListing;

  let filtered = index.items;
  if (params.query) filtered = filtered.filter((item) => item.searchText.includes(params.query));
  if (params.usernamePrefixes.length) {
    filtered = filtered.filter((item) => itemMatchesUsernamePrefixes(item, params.usernamePrefixes));
  }
  if (params.hasSourcesParam) {
    const allowedSources = new Set(params.sources);
    filtered = filtered.filter((item) => allowedSources.has(item.source));
  } else if (params.source && params.source !== "all") {
    filtered = filtered.filter((item) => item.source === params.source);
  }
  if (params.localOnly) filtered = filtered.filter((item) => item.hasLocalMedia || item.hasLocalText);
  if (params.withText) filtered = filtered.filter((item) => item.hasLocalText);
  if (params.withMedia) filtered = filtered.filter((item) => item.hasLocalMedia);
  if (params.dateFrom != null) filtered = filtered.filter((item) => item.dateSortMs != null && item.dateSortMs >= params.dateFrom);
  if (params.dateTo != null) filtered = filtered.filter((item) => item.dateSortMs != null && item.dateSortMs <= params.dateTo);

  const sorted = [...filtered];
  sorted.sort((left, right) => {
    const leftPrompt = left.prompt || "";
    const rightPrompt = right.prompt || "";
    const leftViews = Number(left.viewCount || 0);
    const rightViews = Number(right.viewCount || 0);
    const leftLikes = Number(left.likeCount || 0);
    const rightLikes = Number(right.likeCount || 0);
    switch (params.sort) {
      case "date-asc":
        return (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
      case "views-desc":
        return rightViews - leftViews || (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) || right.id.localeCompare(left.id);
      case "views-asc":
        return leftViews - rightViews || (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
      case "likes-desc":
        return rightLikes - leftLikes || (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) || right.id.localeCompare(left.id);
      case "likes-asc":
        return leftLikes - rightLikes || (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
      case "prompt-asc":
        return leftPrompt.localeCompare(rightPrompt, "ja");
      case "prompt-desc":
        return rightPrompt.localeCompare(leftPrompt, "ja");
      case "duration-asc":
        return Number(left.duration || 0) - Number(right.duration || 0);
      case "duration-desc":
        return Number(right.duration || 0) - Number(left.duration || 0);
      case "source-asc": {
        const sourceOrder = SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source);
        if (sourceOrder !== 0) return sourceOrder;
        return (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
      }
      case "date-desc":
      default:
        return (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) || right.id.localeCompare(left.id);
    }
  });

  const total = sorted.length;
  const safeOffset = total === 0 ? 0 : Math.min(params.offset, Math.floor((total - 1) / params.limit) * params.limit);
  const items = sorted.slice(safeOffset, safeOffset + params.limit).map(serializeListItem);

  return {
    items,
    pagination: {
      total,
      limit: params.limit,
      offset: safeOffset,
      page: total === 0 ? 0 : Math.floor(safeOffset / params.limit) + 1,
      totalPages: total === 0 ? 0 : Math.ceil(total / params.limit),
      hasPrevious: safeOffset > 0,
      hasNext: safeOffset + params.limit < total,
    },
  };
}

function itemDetails(index, url) {
  const id = decodeURIComponent(url.pathname.replace("/api/item/", ""));
  const dbItem = store.getItemDetail(id);
  if (dbItem) return dbItem;
  return index.items.find((item) => item.id === id) || null;
}

function localFileForRequest(index, url) {
  const id = decodeURIComponent(url.searchParams.get("id") || "");
  const kind = url.searchParams.get("kind") || "media";
  const dbFile = store.getLocalFile(id, kind);
  if (dbFile) return dbFile;

  const item = index.items.find((entry) => entry.id === id);
  if (!item) return null;
  if (kind === "media") return item.local?.mediaPath || null;
  if (kind === "txt") return item.local?.txtPath || null;
  return null;
}

async function handleRequest(request, response) {
  try {
    const host = request.headers.host || `${BIND_HOST}:${DEFAULT_PORT}`;
    const url = new URL(request.url, `http://${host}`);

    if (url.pathname === "/api/index") {
      const index = await ensureIndexReady();
      const listing = listItems(index, url);
      return json(response, 200, {
        builtAt: index.builtAt,
        stats: serializeStats(index.stats),
        items: listing.items,
        pagination: listing.pagination,
      });
    }

    if (url.pathname.startsWith("/api/item/")) {
      const index = await ensureIndexReady();
      const item = itemDetails(index, url);
      if (!item) return json(response, 404, { error: "Item not found" });
      return json(response, 200, serializeDetailItem(item));
    }

    if (url.pathname === "/api/rebuild" && request.method === "POST") {
      try {
        const rebuiltIndex = await startIndexBuild();
        return json(response, 200, { ok: true, builtAt: rebuiltIndex.builtAt, stats: serializeStats(rebuiltIndex.stats) });
      } catch (error) {
        return json(response, 500, { error: "Failed to rebuild index", details: error.message });
      }
    }

    if (url.pathname === "/media") {
      const index = await ensureIndexReady();
      const filePath = localFileForRequest(index, url);
      if (!filePath || !(await pathPointsToFile(filePath))) {
        return json(response, 404, { error: "Media not found" });
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === ".mp4" ? "video/mp4" : ext === ".txt" ? "text/plain; charset=utf-8" : "application/octet-stream";
      return sendFile(response, filePath, contentType, {
        "Content-Disposition": contentDispositionInline(filePath),
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
    const message = indexState.lastError && !indexState.current
      ? indexState.lastError.message
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
    const index = await ensureIndexReady();
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
    void logIndexSummary();
    console.log("Press Ctrl+C in this terminal to stop the server.");
  });

  return server;
}

module.exports = {
  startServer,
};
