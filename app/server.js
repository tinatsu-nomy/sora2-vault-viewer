const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

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

const TEXT_DECODERS = [
  { name: "utf-8", decoder: new TextDecoder("utf-8", { fatal: false }) },
  { name: "shift_jis", decoder: new TextDecoder("shift_jis", { fatal: false }) },
];

let cachedIndex = null;
let db = null;
let DatabaseSync = null;
let dbStatus = {
  enabled: false,
  path: DB_PATH,
  savedItems: 0,
  error: ENABLE_SQLITE_CACHE ? null : "disabled by default",
};

function listManifestFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^soravault_manifest_.*\.json$/i.test(entry.name))
    .map((entry) => path.join(DATA_DIR, entry.name))
    .sort();
}

function isPathInside(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getDb() {
  if (!ENABLE_SQLITE_CACHE) return null;
  if (db) return db;
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  try {
    if (!DatabaseSync) {
      ({ DatabaseSync } = require("node:sqlite"));
    }
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const currentSchemaVersion = db.prepare("SELECT value FROM cache_meta WHERE key = ?").get("schemaVersion")?.value || null;
    if (currentSchemaVersion !== SQLITE_SCHEMA_VERSION) {
      db.exec(`
        DELETE FROM cache_meta;
        DROP TABLE IF EXISTS items;
        DROP TABLE IF EXISTS items_fts;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        source TEXT,
        kind TEXT,
        date TEXT,
        date_sort_ms INTEGER,
        prompt TEXT,
        gen_id TEXT,
        generation_id TEXT,
        task_id TEXT,
        post_id TEXT,
        poster_username TEXT,
        owner_usernames_json TEXT NOT NULL,
        cameo_owner_usernames_json TEXT NOT NULL,
        duration TEXT,
        duration_sort REAL,
        ratio TEXT,
        width INTEGER,
        height INTEGER,
        like_count INTEGER,
        view_count INTEGER,
        is_liked INTEGER,
        has_local_media INTEGER,
        has_local_text INTEGER,
        thumb_url TEXT,
        preview_url TEXT,
        download_url TEXT,
        local_media_path TEXT,
        local_txt_path TEXT,
        search_text TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_items_source_date ON items(source, date);
      CREATE INDEX IF NOT EXISTS idx_items_date_sort_ms ON items(date_sort_ms);
      CREATE INDEX IF NOT EXISTS idx_items_post_id ON items(post_id);
      CREATE INDEX IF NOT EXISTS idx_items_task_id ON items(task_id);
      CREATE INDEX IF NOT EXISTS idx_items_generation_id ON items(generation_id);
      CREATE INDEX IF NOT EXISTS idx_items_local_flags ON items(has_local_media, has_local_text);
      CREATE INDEX IF NOT EXISTS idx_items_views ON items(view_count);
      CREATE INDEX IF NOT EXISTS idx_items_likes ON items(like_count);
      CREATE INDEX IF NOT EXISTS idx_items_duration_sort ON items(duration_sort);

      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        id UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );
    `);
    db.prepare(`
      INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)
    `).run("schemaVersion", SQLITE_SCHEMA_VERSION);
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
        id, source, kind, date, date_sort_ms, prompt, gen_id, generation_id, task_id, post_id,
        poster_username, owner_usernames_json, cameo_owner_usernames_json,
        duration, duration_sort, ratio, width, height, like_count, view_count,
        is_liked, has_local_media, has_local_text, thumb_url, preview_url, download_url,
        local_media_path, local_txt_path, search_text, detail_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);
    const insertFts = database.prepare(`
      INSERT INTO items_fts (id, search_text) VALUES (?, ?)
    `);
    const setMeta = database.prepare(`
      INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)
    `);

    database.exec("BEGIN");
    txActive = true;
    database.exec("DELETE FROM items");
    database.exec("DELETE FROM items_fts");
    for (const item of index.items) {
      insert.run(
        item.id,
        item.source,
        item.kind,
        item.date,
        item.dateSortMs,
        item.prompt,
        item.genId,
        item.generationId,
        item.taskId,
        item.postId,
        item.posterUsername || null,
        JSON.stringify(item.ownerUsernames || []),
        JSON.stringify(item.cameoOwnerUsernames || []),
        item.duration == null ? null : String(item.duration),
        sortableDuration(item.duration),
        item.ratio,
        item.width,
        item.height,
        typeof item.likeCount === "number" ? item.likeCount : null,
        typeof item.viewCount === "number" ? item.viewCount : null,
        item.isLiked ? 1 : 0,
        item.hasLocalMedia ? 1 : 0,
        item.hasLocalText ? 1 : 0,
        item.thumbUrl,
        item.previewUrl,
        item.downloadUrl,
        item.local?.mediaPath || null,
        item.local?.txtPath || null,
        item.searchText,
        JSON.stringify(item),
      );
      insertFts.run(item.id, item.searchText);
    }
    setMeta.run("builtAt", index.builtAt);
    setMeta.run("totalItems", String(index.stats.totalItems));
    setMeta.run("dbPath", DB_PATH);
    setMeta.run("statsJson", JSON.stringify(index.stats));
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

function parseDateValue(value, { endOfDayIfDateOnly = false } = {}) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsed = endOfDayIfDateOnly
      ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
      : new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
    const timestamp = parsed.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const localDateTimeMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (localDateTimeMatch) {
    const [, year, month, day, hour, minute, second = "0", fraction = "0"] = localDateTimeMatch;
    const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    );
    const timestamp = parsed.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
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
  const posterUsername = item?._raw?.profile?.username || null;
  const cameoOwnerUsernames = [
    ...(post.cameo_profiles || []).map((profile) => profile?.username),
  ].filter(Boolean);
  const uniqueCameoOwnerUsernames = [...new Set(cameoOwnerUsernames)].filter((username) => username !== posterUsername);
  const ownerUsernames = [
    posterUsername,
    ...uniqueCameoOwnerUsernames,
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
    posterUsername,
    ownerUsername: uniqueOwnerUsernames[0] || null,
    ownerUsernames: uniqueOwnerUsernames,
    cameoOwnerUsernames: uniqueCameoOwnerUsernames,
    isLiked: Boolean(item.isLiked),
    previewUrl: item.previewUrl || null,
    downloadUrl: item.downloadUrl || null,
    thumbUrl: item.thumbUrl || null,
    raw: item,
    idTokens: [...idTokens],
  };
}

function shouldSkipManifestSearchKey(key) {
  return /url|uri|path|sig|cursor|share_ref|download|preview|thumb/i.test(String(key || ""));
}

function appendManifestSearchValues(value, values, seen) {
  if (value == null) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (/^https?:\/\//i.test(trimmed)) return;
    values.push(trimmed);
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    values.push(String(value));
    return;
  }

  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      appendManifestSearchValues(item, values, seen);
    }
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (shouldSkipManifestSearchKey(key)) continue;
    appendManifestSearchValues(nestedValue, values, seen);
  }
}

function manifestSearchText(entry) {
  if (!entry?.raw?._raw) return "";
  const values = [];
  appendManifestSearchValues(entry.raw._raw, values, new Set());
  return values.join("\n");
}

function sortableDuration(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
  const manifestErrors = [];
  const manifestFiles = listManifestFiles();

  for (const manifestPath of manifestFiles) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      manifestErrors.push({
        file: manifestPath,
        error: `${error.code || "JSON_ERROR"}: ${error.message}`,
      });
      continue;
    }

    manifests.push({
      file: manifestPath,
      exportedAt: raw.exported_at,
      total: raw.total,
      scanSources: raw.scan_sources,
    });
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
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
    const dateSortMs = parseDateValue(entry.date);
    const searchText = [
      entry.prompt,
      entry.source,
      entry.date,
      entry.genId,
      entry.generationId,
      entry.taskId,
      entry.postId,
      entry.posterUsername,
      ...(entry.ownerUsernames || []),
      ...(entry.cameoOwnerUsernames || []),
      entry.manifestFile ? path.basename(entry.manifestFile) : null,
      manifestSearchText(entry),
      entry.local?.txtRaw,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    return {
      ...entry,
      dateSortMs,
      hasLocalMedia: Boolean(entry.local?.mediaPath),
      hasLocalText: Boolean(entry.local?.txtPath),
      searchText,
    };
  });

  items.sort((a, b) => {
    return (b.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (a.dateSortMs ?? Number.MIN_SAFE_INTEGER) || b.id.localeCompare(a.id);
  });

  const stats = {
    totalItems: items.length,
    manifestItems: items.filter((item) => item.kind === "manifest").length,
    localOnlyItems: items.filter((item) => item.kind === "local-only").length,
    withLocalMedia: items.filter((item) => item.hasLocalMedia).length,
    withLocalText: items.filter((item) => item.hasLocalText).length,
    sources: [...new Set(items.map((item) => item.source))].sort(),
    manifests,
    manifestErrors,
    database: { ...dbStatus },
  };

  const index = { items, stats, builtAt: new Date().toISOString() };
  persistIndexToDb(index);
  index.stats.database = { ...dbStatus };
  return index;
}

function loadIndexFromDb() {
  const database = getDb();
  if (!database) return null;

  const metaRows = database.prepare("SELECT key, value FROM cache_meta").all();
  const meta = new Map(metaRows.map((row) => [row.key, row.value]));
  const builtAt = meta.get("builtAt") || null;
  const stats = parseJson(meta.get("statsJson"), null);
  if (!builtAt || !stats) return null;

  const countRow = database.prepare("SELECT COUNT(*) AS count FROM items").get();
  dbStatus = {
    enabled: true,
    path: DB_PATH,
    savedItems: Number(countRow?.count || 0),
    error: null,
  };

  return {
    builtAt,
    stats: {
      ...stats,
      database: { ...dbStatus },
    },
  };
}

function ensureIndex() {
  if (!cachedIndex) {
    cachedIndex = loadIndexFromDb() || buildIndex();
  }
  return cachedIndex;
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

function parseListParams(url) {
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
  const dateFrom = parseDateValue(url.searchParams.get("dateFrom"));
  const dateTo = parseDateValue(url.searchParams.get("dateTo"), { endOfDayIfDateOnly: true });
  const sort = url.searchParams.get("sort") || "date-desc";
  const requestedLimit = Number(url.searchParams.get("limit") || 180);
  const requestedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 180, 240));
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);

  return {
    query,
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
      enabled: Boolean(stats.database?.enabled),
      savedItems: Number(stats.database?.savedItems || 0),
      error: stats.database?.error || null,
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

function listItemsFromDb(url) {
  const database = getDb();
  if (!database) return null;

  const params = parseListParams(url);
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
  const fromClause = `FROM items ${joins.join(" ")}`;
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

  const countSql = `SELECT COUNT(*) AS count ${fromClause} ${whereClause}`;
  const total = Number(database.prepare(countSql).get(...values)?.count || 0);
  const safeOffset = total === 0 ? 0 : Math.min(params.offset, Math.floor((total - 1) / params.limit) * params.limit);

  const dataSql = `
    SELECT
      items.id,
      items.kind,
      items.source,
      items.date,
      items.prompt,
      items.gen_id AS genId,
      items.generation_id AS generationId,
      items.task_id AS taskId,
      items.post_id AS postId,
      items.duration,
      items.ratio,
      items.width,
      items.height,
      items.like_count AS likeCount,
      items.view_count AS viewCount,
      items.poster_username AS posterUsername,
      items.cameo_owner_usernames_json AS cameoOwnerUsernamesJson,
      items.is_liked AS isLiked,
      items.preview_url AS previewUrl,
      items.download_url AS downloadUrl,
      items.thumb_url AS thumbUrl,
      items.has_local_media AS hasLocalMedia,
      items.has_local_text AS hasLocalText
    ${fromClause}
    ${whereClause}
    ${orderBy}
    LIMIT ? OFFSET ?
  `;
  const rows = database.prepare(dataSql).all(...values, params.limit, safeOffset);

  return {
    items: rows.map(serializeListRow),
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

function listItems(index, url) {
  const dbListing = listItemsFromDb(url);
  if (dbListing) return dbListing;

  const params = parseListParams(url);
  let filtered = index.items;
  if (params.query) filtered = filtered.filter((item) => item.searchText.includes(params.query));
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
  const id = url.pathname.replace("/api/item/", "");
  const database = getDb();
  if (database) {
    const row = database.prepare("SELECT detail_json FROM items WHERE id = ?").get(decodeURIComponent(id));
    return row ? parseJson(row.detail_json, null) : null;
  }
  return index.items.find((item) => item.id === decodeURIComponent(id)) || null;
}

function localFileForRequest(index, url) {
  const id = decodeURIComponent(url.searchParams.get("id") || "");
  const kind = url.searchParams.get("kind") || "media";
  const database = getDb();
  if (database) {
    const row = database
      .prepare("SELECT local_media_path AS mediaPath, local_txt_path AS txtPath FROM items WHERE id = ?")
      .get(id);
    if (!row) return null;
    if (kind === "media") return row.mediaPath || null;
    if (kind === "txt") return row.txtPath || null;
    return null;
  }
  const item = index.items.find((entry) => entry.id === id);
  if (!item) return null;
  if (kind === "media") return item.local?.mediaPath || null;
  if (kind === "txt") return item.local?.txtPath || null;
  return null;
}

function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/api/index") {
    try {
      const index = ensureIndex();
      const listing = listItems(index, url);
      return json(response, 200, {
        builtAt: index.builtAt,
        stats: serializeStats(index.stats),
        items: listing.items,
        pagination: listing.pagination,
      });
    } catch (error) {
      return json(response, 500, { error: "Failed to build index", details: error.message });
    }
  }

  if (url.pathname.startsWith("/api/item/")) {
    try {
      const index = ensureIndex();
      const item = itemDetails(index, url);
      if (!item) return json(response, 404, { error: "Item not found" });
      return json(response, 200, serializeDetailItem(item));
    } catch (error) {
      return json(response, 500, { error: "Failed to load item details", details: error.message });
    }
  }

  if (url.pathname === "/api/rebuild" && request.method === "POST") {
    try {
      const rebuiltIndex = buildIndex();
      cachedIndex = rebuiltIndex;
      return json(response, 200, { ok: true, builtAt: cachedIndex.builtAt, stats: serializeStats(cachedIndex.stats) });
    } catch (error) {
      return json(response, 500, { error: "Failed to rebuild index", details: error.message });
    }
  }

  if (url.pathname === "/media") {
    try {
      const index = ensureIndex();
      const filePath = localFileForRequest(index, url);
      if (!filePath || !fs.existsSync(filePath)) return json(response, 404, { error: "Media not found" });
      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === ".mp4" ? "video/mp4" : ext === ".txt" ? "text/plain; charset=utf-8" : "application/octet-stream";
      return sendFile(response, filePath, contentType, {
        "Content-Disposition": contentDispositionInline(filePath),
      });
    } catch (error) {
      return json(response, 500, { error: "Failed to serve media", details: error.message });
    }
  }

  const assetPath = url.pathname === "/"
    ? path.join(PUBLIC_DIR, "index.html")
    : path.resolve(PUBLIC_DIR, `.${url.pathname}`);
  if (isPathInside(PUBLIC_DIR, assetPath) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
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

  server.listen(port, BIND_HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const displayHost = BIND_HOST === "127.0.0.1" ? "localhost" : BIND_HOST;
    console.log(`Sora2 Vault Viewer running at http://${displayHost}:${actualPort}`);
    try {
      const index = ensureIndex();
      console.log(`Indexed ${index.stats.totalItems} items`);
      if (index.stats.manifestErrors?.length) {
        console.warn(`Skipped ${index.stats.manifestErrors.length} malformed manifest file(s).`);
      }
    } catch (error) {
      console.error(`Initial index build failed: ${error.message}`);
    }
    console.log("Press Ctrl+C in this terminal to stop the server.");
  });

  return server;
}

if (require.main === module) {
  startServer(DEFAULT_PORT);
}

module.exports = {
  startServer,
};
