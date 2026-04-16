const fs = require("fs");
const path = require("path");

const {
  basenameWithoutExt,
  extractIdTokens,
} = require("./common");

const fsp = fs.promises;

const TEXT_DECODERS = [
  { name: "utf-8", decoder: new TextDecoder("utf-8", { fatal: false }) },
  { name: "shift_jis", decoder: new TextDecoder("shift_jis", { fatal: false }) },
];
const TXT_RECORD_CACHE_VERSION = 1;

function cloneTxtRecord(record) {
  if (!record) return null;
  return {
    ...record,
    idTokens: Array.isArray(record.idTokens) ? [...record.idTokens] : [],
  };
}

function createTxtRecordCache(cachePath) {
  const state = {
    enabled: Boolean(cachePath),
    loaded: false,
    dirty: false,
    entries: new Map(),
    seenPaths: new Set(),
  };

  async function ensureLoaded() {
    if (!state.enabled || state.loaded) return;
    state.loaded = true;

    try {
      const raw = await fsp.readFile(cachePath, "utf8");
      const payload = JSON.parse(raw);
      if (payload?.version !== TXT_RECORD_CACHE_VERSION || !Array.isArray(payload.entries)) return;

      for (const entry of payload.entries) {
        if (!entry?.filePath || !entry?.record) continue;
        state.entries.set(entry.filePath, {
          mtimeMs: entry.mtimeMs,
          size: entry.size,
          record: entry.record,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        state.entries.clear();
      }
    }
  }

  async function get(filePath, stat) {
    if (!state.enabled) return null;
    state.seenPaths.add(filePath);
    await ensureLoaded();

    const cached = state.entries.get(filePath);
    if (!cached) return null;
    if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return null;
    return cloneTxtRecord(cached.record);
  }

  async function set(filePath, stat, record) {
    if (!state.enabled) return;
    state.seenPaths.add(filePath);
    await ensureLoaded();
    state.entries.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      record: cloneTxtRecord(record),
    });
    state.dirty = true;
  }

  async function persist() {
    if (!state.enabled) return;
    await ensureLoaded();

    for (const filePath of [...state.entries.keys()]) {
      if (!state.seenPaths.has(filePath)) {
        state.entries.delete(filePath);
        state.dirty = true;
      }
    }

    if (!state.dirty) return;

    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    const payload = {
      version: TXT_RECORD_CACHE_VERSION,
      entries: [...state.entries.entries()].map(([filePath, entry]) => ({
        filePath,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        record: entry.record,
      })),
    };
    await fsp.writeFile(cachePath, JSON.stringify(payload), "utf8");
    state.dirty = false;
  }

  return {
    get,
    persist,
    set,
  };
}

function likelyBrokenText(value) {
  if (!value) return false;
  return /�|ƒ|„|ں|پ~/.test(value);
}

function scoreDecodedText(value) {
  if (!value) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (!likelyBrokenText(value)) score += 1000;
  if (/Prompt/i.test(value)) score += 100;
  if (/[一-龯ぁ-んァ-ヶ]/.test(value)) score += 50;
  score += Math.min(value.length, 500);
  return score;
}

async function decodeTextFile(filePath) {
  const raw = await fsp.readFile(filePath);
  let best = { text: "", encoding: "utf-8", score: Number.NEGATIVE_INFINITY };
  for (const candidate of TEXT_DECODERS) {
    const text = candidate.decoder.decode(raw);
    const score = scoreDecodedText(text);
    if (score > best.score) {
      best = { text, encoding: candidate.name, score };
    }
  }
  return { text: best.text.replace(/\r\n/g, "\n"), encoding: best.encoding };
}

async function parseTxtRecord(filePath, sourceDirName, txtRecordCache = null) {
  const stat = await fsp.stat(filePath);
  const cachedRecord = await txtRecordCache?.get(filePath, stat);
  if (cachedRecord) return cachedRecord;

  const { text, encoding } = await decodeTextFile(filePath);
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

  const record = {
    type: "localFile",
    source: sourceDirName,
    declaredSource: metadata.Source || null,
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

  await txtRecordCache?.set(filePath, stat, record);
  return record;
}

module.exports = {
  createTxtRecordCache,
  decodeTextFile,
  parseTxtRecord,
};
