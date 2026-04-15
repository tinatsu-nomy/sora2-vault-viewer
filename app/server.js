const fs = require("fs");
const path = require("path");
const http = require("http");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("url");

const DEFAULT_PORT = Number(process.env.PORT || 3210);
const MAX_PORT_ATTEMPTS = 20;
const ROOT = process.env.SORA_VIEWER_ROOT
  ? path.resolve(process.env.SORA_VIEWER_ROOT)
  : path.resolve(__dirname, "..");
const DATA_DIR = process.env.SORA_DATA_DIR
  ? path.resolve(process.env.SORA_DATA_DIR)
  : path.join(ROOT, "sora2_data");
const PUBLIC_DIR = path.join(ROOT, "app", "public");
const APP_DATA_DIR = path.join(ROOT, "app", "data");
const DB_PATH = process.env.SORA_SQLITE_PATH || path.join(APP_DATA_DIR, "sora-index.sqlite");

const MANIFEST_FILES = fs.existsSync(DATA_DIR)
  ? fs
      .readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^soravault_manifest_.*\.json$/i.test(entry.name))
      .map((entry) => path.join(DATA_DIR, entry.name))
      .sort()
  : [];

const SOURCE_DIRS = {
  v2_drafts: path.join(DATA_DIR, "sora_v2_drafts"),
  v2_liked: path.join(DATA_DIR, "sora_v2_liked"),
  v2_profile: path.join(DATA_DIR, "sora_v2_profile"),
};

const TEXT_DECODERS = [
  { name: "utf-8", decoder: new TextDecoder("utf-8", { fatal: false }) },
  { name: "shift_jis", decoder: new TextDecoder("shift_jis", { fatal: false }) },
];

let cachedIndex = null;
let db = null;
let dbStatus = {
  enabled: true,
  path: DB_PATH,
  savedItems: 0,
  error: null,
};

function getDb() {
  if (db) return db;
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  try {
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        source TEXT,
        kind TEXT,
        date TEXT,
        prompt TEXT,
        gen_id TEXT,
        generation_id TEXT,
        task_id TEXT,
        post_id TEXT,
        duration REAL,
        ratio TEXT,
        width INTEGER,
        height INTEGER,
        is_liked INTEGER,
        has_local_media INTEGER,
        has_local_text INTEGER,
        thumb_url TEXT,
        preview_url TEXT,
        local_media_path TEXT,
        local_txt_path TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_items_source_date ON items(source, date);
      CREATE INDEX IF NOT EXISTS idx_items_post_id ON items(post_id);
      CREATE INDEX IF NOT EXISTS idx_items_task_id ON items(task_id);
      CREATE INDEX IF NOT EXISTS idx_items_generation_id ON items(generation_id);
    `);
    return db;
  } catch (error) {
    db = null;
    dbStatus = {
      enabled: false,
      path: DB_PATH,
      savedItems: 0,
      error: `${error.code || "SQLITE_ERROR"}: ${error.message}`,
    };
    return null;
  }
}

function persistIndexToDb(index) {
  const database = getDb();
  if (!database) return;
  let txActive = false;
  try {
    const insert = database.prepare(`
      INSERT OR REPLACE INTO items (
        id, source, kind, date, prompt, gen_id, generation_id, task_id, post_id,
        duration, ratio, width, height, is_liked, has_local_media, has_local_text,
        thumb_url, preview_url, local_media_path, local_txt_path, payload_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);
    const setMeta = database.prepare(`
      INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)
    `);

    database.exec("BEGIN");
    txActive = true;
    database.exec("DELETE FROM items");
    for (const item of index.items) {
      insert.run(
        item.id,
        item.source,
        item.kind,
        item.date,
        item.prompt,
        item.genId,
        item.generationId,
        item.taskId,
        item.postId,
        typeof item.duration === "number" ? item.duration : null,
        item.ratio,
        item.width,
        item.height,
        item.isLiked ? 1 : 0,
        item.hasLocalMedia ? 1 : 0,
        item.hasLocalText ? 1 : 0,
        item.thumbUrl,
        item.previewUrl,
        item.local?.mediaPath || null,
        item.local?.txtPath || null,
        JSON.stringify(item),
      );
    }
    setMeta.run("builtAt", index.builtAt);
    setMeta.run("totalItems", String(index.stats.totalItems));
    setMeta.run("dbPath", DB_PATH);
    database.exec("COMMIT");
    txActive = false;
    dbStatus = {
      enabled: true,
      path: DB_PATH,
      savedItems: index.items.length,
      error: null,
    };
  } catch (error) {
    if (txActive) {
      try {
        database.exec("ROLLBACK");
      } catch {}
    }
    dbStatus = {
      enabled: false,
      path: DB_PATH,
      savedItems: 0,
      error: `${error.code || "SQLITE_ERROR"}: ${error.message}`,
    };
  }
}

function walkFiles(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const results = [];
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function slugForText(value) {
  if (!value) return "";
  return String(value).toLowerCase();
}

function basenameWithoutExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function extractIdTokens(value) {
  if (!value) return [];
  const text = String(value);
  const matches = new Set();
  const patterns = [
    /gen_[a-z0-9]+/gi,
    /task_[a-z0-9]+/gi,
    /s_[a-z0-9]+(?:-attachment-\d+)?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.add(match[0]);
    }
  }
  return [...matches];
}

function likelyBrokenText(value) {
  if (!value) return false;
  return /�|ƒ|„|ں|پ~/.test(value);
}

function scoreDecodedText(value) {
  if (!value) return -100;
  let score = 0;
  if (/Source\s*:/.test(value)) score += 10;
  if (/Generation ID\s*:/.test(value)) score += 10;
  if (/Prompt/.test(value)) score += 5;
  if (!likelyBrokenText(value)) score += 8;
  score -= (value.match(/�/g) || []).length * 3;
  return score;
}

function decodeTextFile(filePath) {
  const raw = fs.readFileSync(filePath);
  let best = { text: "", encoding: "utf-8", score: -Infinity };
  for (const candidate of TEXT_DECODERS) {
    const text = candidate.decoder.decode(raw);
    const score = scoreDecodedText(text);
    if (score > best.score) {
      best = { text, encoding: candidate.name, score };
    }
  }
  return { text: best.text.replace(/\r\n/g, "\n"), encoding: best.encoding };
}

function parseTxtRecord(filePath, sourceDirName) {
  const { text, encoding } = decodeTextFile(filePath);
  const lines = text.split("\n");
  const metadata = {};
  let promptStart = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/Prompt/.test(line)) {
      promptStart = index + 1;
      continue;
    }
    const match = line.match(/^([^:]+?)\s*:\s*(.+)$/);
    if (match) {
      metadata[match[1].trim()] = match[2].trim();
    }
  }

  const prompt = promptStart >= 0 ? lines.slice(promptStart).join("\n").trim() : "";
  const stem = basenameWithoutExt(filePath);
  const idTokens = new Set(extractIdTokens(stem));
  for (const value of Object.values(metadata)) {
    for (const token of extractIdTokens(value)) {
      idTokens.add(token);
    }
  }

  return {
    type: "localFile",
    source: metadata.Source || sourceDirName,
    generationId: metadata["Generation ID"] || null,
    taskId: metadata["Task ID"] || null,
    postId: metadata["Post ID"] || null,
    date: metadata.Date || null,
    duration: metadata.Duration || null,
    resolution: metadata.Resolution || null,
    aspectRatio: metadata["Aspect ratio"] || null,
    liked: metadata.Liked || null,
    prompt,
    rawText: text,
    encoding,
    stem,
    idTokens: [...idTokens],
    filePath,
  };
}

function parseManifestItem(item, manifestPath, exportedAt) {
  const post = item?._raw?.post || {};
  const attachment = post.attachments?.[0] || item?._raw || {};
  const ownerUsernames = [
    item?._raw?.owner_profile?.username,
    item?._raw?.profile?.owner_profile?.username,
    post.owner_profile?.username,
    post.shared_by_profile?.username,
    post.original_poster?.username,
    ...(post.cameo_profiles || []).map((profile) => profile?.owner_profile?.username),
  ].filter(Boolean);
  const uniqueOwnerUsernames = [...new Set(ownerUsernames)];
  const idTokens = new Set();
  for (const value of [
    item.genId,
    item.taskId,
    item.postId,
    attachment.generation_id,
    attachment.id,
    attachment.task_id,
  ]) {
    for (const token of extractIdTokens(value)) {
      idTokens.add(token);
    }
  }

  return {
    id: `${item.source}:${item.genId || item.postId || item.taskId}`,
    kind: "manifest",
    source: item.source || "",
    date: item.date || null,
    prompt: item.prompt || item?._raw?.post?.text || item?._raw?.prompt || "",
    manifestExportedAt: exportedAt,
    manifestFile: manifestPath,
    mode: item.mode || null,
    genId: item.genId || null,
    generationId: item?._raw?.post?.attachments?.[0]?.generation_id || item?._raw?.generation_id || null,
    taskId: item.taskId || item?._raw?.task_id || null,
    postId: item.postId || item?._raw?.post?.id || null,
    width: item.width || item?._raw?.width || null,
    height: item.height || item?._raw?.height || null,
    ratio: item.ratio || null,
    duration: item.duration || item?._raw?.duration_s || null,
    likeCount: typeof post.like_count === "number" ? post.like_count : null,
    viewCount: typeof post.view_count === "number" ? post.view_count : null,
    ownerUsername: uniqueOwnerUsernames[0] || null,
    ownerUsernames: uniqueOwnerUsernames,
    isLiked: Boolean(item.isLiked),
    previewUrl: item.previewUrl || null,
    downloadUrl: item.downloadUrl || null,
    thumbUrl: item.thumbUrl || null,
    raw: item,
    idTokens: [...idTokens],
  };
}

function addLookup(map, key, entryId) {
  if (!key) return;
  const normalized = slugForText(key);
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, new Set());
  map.get(normalized).add(entryId);
}

function attachLocalFiles(entries, lookupMap) {
  const unmatchedLocals = [];

  for (const [source, dirPath] of Object.entries(SOURCE_DIRS)) {
    const grouped = new Map();
    for (const filePath of walkFiles(dirPath)) {
      const stem = basenameWithoutExt(filePath);
      if (!grouped.has(stem)) grouped.set(stem, {});
      const group = grouped.get(stem);
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".mp4") group.mediaPath = filePath;
      if (ext === ".txt") group.txtPath = filePath;
      group.source = source;
    }

    for (const group of grouped.values()) {
      const localRecord = group.txtPath
        ? parseTxtRecord(group.txtPath, source)
        : {
            type: "localFile",
            source,
            generationId: null,
            taskId: null,
            postId: null,
            date: null,
            duration: null,
            resolution: null,
            aspectRatio: null,
            liked: null,
            prompt: "",
            rawText: "",
            encoding: null,
            stem: basenameWithoutExt(group.mediaPath),
            idTokens: extractIdTokens(group.mediaPath),
            filePath: group.mediaPath,
          };

      const candidateIds = new Set();
      const tokensToMatch = [
        localRecord.generationId,
        localRecord.taskId,
        localRecord.postId,
        ...localRecord.idTokens,
        localRecord.stem,
      ];
      for (const token of tokensToMatch) {
        const bucket = lookupMap.get(slugForText(token));
        if (!bucket) continue;
        for (const id of bucket) candidateIds.add(id);
      }

      let matched = false;
      for (const entryId of candidateIds) {
        const entry = entries.get(entryId);
        if (!entry) continue;
        const sameSource = entry.source === localRecord.source;
        if (!sameSource) continue;
        entry.local = {
          mediaPath: group.mediaPath || null,
          txtPath: group.txtPath || null,
          txtEncoding: localRecord.encoding,
          txtRaw: localRecord.rawText,
          txtPrompt: localRecord.prompt,
          parsed: {
            generationId: localRecord.generationId,
            taskId: localRecord.taskId,
            postId: localRecord.postId,
            date: localRecord.date,
            duration: localRecord.duration,
            resolution: localRecord.resolution,
            aspectRatio: localRecord.aspectRatio,
            liked: localRecord.liked,
          },
        };
        matched = true;
      }

      if (!matched) {
        unmatchedLocals.push({
          id: `local:${source}:${localRecord.generationId || localRecord.postId || localRecord.taskId || localRecord.stem}`,
          kind: "local-only",
          source,
          date: localRecord.date,
          prompt: localRecord.prompt,
          manifestExportedAt: null,
          manifestFile: null,
          mode: "v2",
          genId: localRecord.generationId || null,
          generationId: localRecord.generationId || null,
          taskId: localRecord.taskId || null,
          postId: localRecord.postId || null,
          width: null,
          height: null,
          ratio: localRecord.aspectRatio || null,
          duration: localRecord.duration || null,
          isLiked: localRecord.liked === "yes",
          previewUrl: null,
          downloadUrl: null,
          thumbUrl: null,
          raw: null,
          idTokens: localRecord.idTokens,
          local: {
            mediaPath: group.mediaPath || null,
            txtPath: group.txtPath || null,
            txtEncoding: localRecord.encoding,
            txtRaw: localRecord.rawText,
            txtPrompt: localRecord.prompt,
            parsed: {
              generationId: localRecord.generationId,
              taskId: localRecord.taskId,
              postId: localRecord.postId,
              date: localRecord.date,
              duration: localRecord.duration,
              resolution: localRecord.resolution,
              aspectRatio: localRecord.aspectRatio,
              liked: localRecord.liked,
            },
          },
        });
      }
    }
  }

  for (const entry of unmatchedLocals) {
    entries.set(entry.id, entry);
  }
}

function buildIndex() {
  const entries = new Map();
  const lookupMap = new Map();
  const manifests = [];

  for (const manifestPath of MANIFEST_FILES) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifests.push({
      file: manifestPath,
      exportedAt: raw.exported_at,
      total: raw.total,
      scanSources: raw.scan_sources,
    });
    for (const item of raw.items || []) {
      const entry = parseManifestItem(item, manifestPath, raw.exported_at);
      entries.set(entry.id, entry);
      for (const token of [
        entry.id,
        entry.genId,
        entry.generationId,
        entry.taskId,
        entry.postId,
        ...entry.idTokens,
      ]) {
        addLookup(lookupMap, token, entry.id);
      }
    }
  }

  attachLocalFiles(entries, lookupMap);

  const items = [...entries.values()].map((entry) => {
    const searchText = [
      entry.prompt,
      entry.source,
      entry.date,
      entry.genId,
      entry.generationId,
      entry.taskId,
      entry.postId,
      entry.local?.txtRaw,
      entry.local?.mediaPath,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    return {
      ...entry,
      hasLocalMedia: Boolean(entry.local?.mediaPath),
      hasLocalText: Boolean(entry.local?.txtPath),
      searchText,
    };
  });

  items.sort((a, b) => {
    const left = `${b.date || ""}|${b.id}`;
    const right = `${a.date || ""}|${a.id}`;
    return left.localeCompare(right);
  });

  const stats = {
    totalItems: items.length,
    manifestItems: items.filter((item) => item.kind === "manifest").length,
    localOnlyItems: items.filter((item) => item.kind === "local-only").length,
    withLocalMedia: items.filter((item) => item.hasLocalMedia).length,
    withLocalText: items.filter((item) => item.hasLocalText).length,
    sources: [...new Set(items.map((item) => item.source))].sort(),
    manifests,
    database: { ...dbStatus },
  };

  const index = { items, stats, builtAt: new Date().toISOString() };
  persistIndexToDb(index);
  index.stats.database = { ...dbStatus };
  return index;
}

function ensureIndex() {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath, contentType) {
  response.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(response);
}

function safePathFromQuery(inputPath) {
  if (!inputPath) return null;
  const resolved = path.resolve(inputPath);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
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
    ownerUsername: item.ownerUsername,
    ownerUsernames: item.ownerUsernames || [],
    isLiked: item.isLiked,
    previewUrl: item.previewUrl,
    thumbUrl: item.thumbUrl,
    localMediaPath: item.local?.mediaPath || null,
    hasLocalMedia: item.hasLocalMedia,
    hasLocalText: item.hasLocalText,
  };
}

function listItems(index, url) {
  const query = slugForText(url.searchParams.get("query"));
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
  const sort = url.searchParams.get("sort") || "date-desc";
  const requestedLimit = Number(url.searchParams.get("limit") || 180);
  const requestedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 180, 240));
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);

  let filtered = index.items;
  if (query) filtered = filtered.filter((item) => item.searchText.includes(query));
  if (hasSourcesParam) {
    const allowedSources = new Set(sources);
    filtered = filtered.filter((item) => allowedSources.has(item.source));
  } else if (source && source !== "all") {
    filtered = filtered.filter((item) => item.source === source);
  }
  if (localOnly) filtered = filtered.filter((item) => item.hasLocalMedia || item.hasLocalText);
  if (withText) filtered = filtered.filter((item) => item.hasLocalText);
  if (withMedia) filtered = filtered.filter((item) => item.hasLocalMedia);

  const sorted = [...filtered];
  sorted.sort((left, right) => {
    const leftPrompt = left.prompt || "";
    const rightPrompt = right.prompt || "";
    const leftViews = Number(left.viewCount || 0);
    const rightViews = Number(right.viewCount || 0);
    const leftLikes = Number(left.likeCount || 0);
    const rightLikes = Number(right.likeCount || 0);
    switch (sort) {
      case "date-asc":
        return `${left.date || ""}|${left.id}`.localeCompare(`${right.date || ""}|${right.id}`);
      case "views-desc":
        return rightViews - leftViews || `${right.date || ""}|${right.id}`.localeCompare(`${left.date || ""}|${left.id}`);
      case "views-asc":
        return leftViews - rightViews || `${left.date || ""}|${left.id}`.localeCompare(`${right.date || ""}|${right.id}`);
      case "likes-desc":
        return rightLikes - leftLikes || `${right.date || ""}|${right.id}`.localeCompare(`${left.date || ""}|${left.id}`);
      case "likes-asc":
        return leftLikes - rightLikes || `${left.date || ""}|${left.id}`.localeCompare(`${right.date || ""}|${right.id}`);
      case "prompt-asc":
        return leftPrompt.localeCompare(rightPrompt, "ja");
      case "prompt-desc":
        return rightPrompt.localeCompare(leftPrompt, "ja");
      case "duration-asc":
        return Number(left.duration || 0) - Number(right.duration || 0);
      case "duration-desc":
        return Number(right.duration || 0) - Number(left.duration || 0);
      case "source-asc":
        return `${left.source}|${left.date || ""}|${left.id}`.localeCompare(`${right.source}|${right.date || ""}|${right.id}`, "ja");
      case "date-desc":
      default:
        return `${right.date || ""}|${right.id}`.localeCompare(`${left.date || ""}|${left.id}`);
    }
  });

  const total = sorted.length;
  const safeOffset = total === 0 ? 0 : Math.min(offset, Math.floor((total - 1) / limit) * limit);
  const items = sorted.slice(safeOffset, safeOffset + limit).map(serializeListItem);

  return {
    items,
    pagination: {
      total,
      limit,
      offset: safeOffset,
      page: total === 0 ? 0 : Math.floor(safeOffset / limit) + 1,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasPrevious: safeOffset > 0,
      hasNext: safeOffset + limit < total,
    },
  };
}

function itemDetails(index, url) {
  const id = url.pathname.replace("/api/item/", "");
  return index.items.find((item) => item.id === decodeURIComponent(id)) || null;
}

function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/api/index") {
    const index = ensureIndex();
    const listing = listItems(index, url);
    return json(response, 200, {
      builtAt: index.builtAt,
      stats: index.stats,
      items: listing.items,
      pagination: listing.pagination,
    });
  }

  if (url.pathname.startsWith("/api/item/")) {
    const index = ensureIndex();
    const item = itemDetails(index, url);
    if (!item) return json(response, 404, { error: "Item not found" });
    return json(response, 200, item);
  }

  if (url.pathname === "/api/rebuild" && request.method === "POST") {
    cachedIndex = buildIndex();
    return json(response, 200, { ok: true, builtAt: cachedIndex.builtAt, stats: cachedIndex.stats });
  }

  if (url.pathname === "/media") {
    const filePath = safePathFromQuery(url.searchParams.get("path"));
    if (!filePath || !fs.existsSync(filePath)) return json(response, 404, { error: "Media not found" });
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".mp4" ? "video/mp4" : ext === ".txt" ? "text/plain; charset=utf-8" : "application/octet-stream";
    return sendFile(response, filePath, contentType);
  }

  const assetPath = url.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, url.pathname);
  if (assetPath.startsWith(PUBLIC_DIR) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
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
}

function startServer(port, attempt = 0) {
  const server = http.createServer(handleRequest);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Retrying on ${nextPort}...`);
      startServer(nextPort, attempt + 1);
      return;
    }

    throw error;
  });

  server.listen(port, () => {
    const index = ensureIndex();
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Sora2 Vault Viewer running at http://localhost:${actualPort}`);
    console.log(`Indexed ${index.stats.totalItems} items`);
    console.log("Press Ctrl+C in this terminal to stop the server.");
  });
}

startServer(DEFAULT_PORT);
