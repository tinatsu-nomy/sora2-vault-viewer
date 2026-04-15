const fs = require("fs");
const path = require("path");

const fsp = fs.promises;

const TEXT_DECODERS = [
  { name: "utf-8", decoder: new TextDecoder("utf-8", { fatal: false }) },
  { name: "shift_jis", decoder: new TextDecoder("shift_jis", { fatal: false }) },
];

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
  if (!value) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (!likelyBrokenText(value)) score += 1000;
  if (/Prompt/i.test(value)) score += 100;
  if (/[一-龯ぁ-んァ-ヶ]/.test(value)) score += 50;
  score += Math.min(value.length, 500);
  return score;
}

async function listManifestFiles(dataDir) {
  try {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^soravault_manifest_.*\.json$/i.test(entry.name))
      .map((entry) => path.join(dataDir, entry.name))
      .sort();
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function walkFiles(dirPath) {
  if (!dirPath) return [];

  const results = [];
  const stack = [dirPath];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }

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

async function parseTxtRecord(filePath, sourceDirName) {
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

function parseManifestItem(item, manifestPath, exportedAt, itemIndex) {
  const post = item?._raw?.post || {};
  const attachment = post.attachments?.[0] || item?._raw || {};
  const source = item.source || "unknown";
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

  const generationId = item?._raw?.post?.attachments?.[0]?.generation_id || item?._raw?.generation_id || null;
  const taskId = item.taskId || item?._raw?.task_id || null;
  const postId = item.postId || item?._raw?.post?.id || null;
  const preferredId = item.genId || generationId || postId || taskId;
  const manifestStem = path.basename(manifestPath, path.extname(manifestPath));

  return {
    id: preferredId ? `${source}:${preferredId}` : `${source}:manifest:${manifestStem}:${itemIndex}`,
    kind: "manifest",
    source,
    date: item.date || null,
    prompt: item.prompt || item?._raw?.post?.text || item?._raw?.prompt || "",
    manifestExportedAt: exportedAt,
    manifestFile: manifestPath,
    mode: item.mode || null,
    genId: item.genId || null,
    generationId,
    taskId,
    postId,
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

function addLookup(map, key, entryId) {
  if (!key) return;
  const normalized = slugForText(key);
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, new Set());
  map.get(normalized).add(entryId);
}

function localAttachmentForGroup(group, localRecord) {
  return {
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
}

function scoreLocalMatch(entry, localRecord) {
  if (!entry || entry.source !== localRecord.source) return -1;

  const entryLookupValues = new Set(
    [
      entry.id,
      entry.genId,
      entry.generationId,
      entry.taskId,
      entry.postId,
      ...(entry.idTokens || []),
    ]
      .filter(Boolean)
      .map((value) => slugForText(value)),
  );

  const exactIds = [
    localRecord.generationId,
    localRecord.postId,
    localRecord.taskId,
  ]
    .filter(Boolean)
    .map((value) => slugForText(value));

  for (const value of exactIds) {
    if (!entryLookupValues.has(value)) return -1;
  }

  let score = 0;
  if (localRecord.generationId) score += 100;
  if (localRecord.postId) score += 90;
  if (localRecord.taskId) score += 80;

  const localTokens = new Set(
    [
      ...localRecord.idTokens,
      localRecord.stem,
    ]
      .filter(Boolean)
      .map((value) => slugForText(value)),
  );

  for (const token of localTokens) {
    if (entryLookupValues.has(token)) score += 10;
  }

  const localPrompt = slugForText(localRecord.prompt).trim();
  const entryPrompt = slugForText(entry.prompt).trim();
  if (localPrompt && entryPrompt && localPrompt === entryPrompt) {
    score += 5;
  }

  return score;
}

async function attachLocalFiles(entries, lookupMap, sourceDirs) {
  const unmatchedLocals = [];

  for (const [source, dirPath] of Object.entries(sourceDirs)) {
    const grouped = new Map();
    const filePaths = await walkFiles(dirPath);

    for (const filePath of filePaths) {
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
        ? await parseTxtRecord(group.txtPath, source)
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

      let matchedEntry = null;
      let matchedScore = -1;
      let matchedTie = false;

      for (const entryId of candidateIds) {
        const entry = entries.get(entryId);
        const score = scoreLocalMatch(entry, localRecord);
        if (score < 0) continue;
        if (score > matchedScore) {
          matchedEntry = entry;
          matchedScore = score;
          matchedTie = false;
          continue;
        }
        if (score === matchedScore) {
          matchedTie = true;
        }
      }

      if (matchedEntry && !matchedTie) {
        matchedEntry.local = localAttachmentForGroup(group, localRecord);
      } else {
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
          local: localAttachmentForGroup(group, localRecord),
        });
      }
    }
  }

  for (const entry of unmatchedLocals) {
    entries.set(entry.id, entry);
  }
}

async function buildIndex({ dataDir, sourceDirs, databaseStatus }) {
  const entries = new Map();
  const lookupMap = new Map();
  const manifests = [];
  const manifestErrors = [];
  const manifestFiles = await listManifestFiles(dataDir);

  for (const manifestPath of manifestFiles) {
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
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

    for (const [itemIndex, item] of (Array.isArray(raw.items) ? raw.items : []).entries()) {
      const entry = parseManifestItem(item, manifestPath, raw.exported_at, itemIndex);
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

  await attachLocalFiles(entries, lookupMap, sourceDirs);

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

  items.sort((left, right) => {
    return (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER)
      || right.id.localeCompare(left.id);
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
    database: { ...(databaseStatus || {}) },
  };

  return {
    items,
    stats,
    builtAt: new Date().toISOString(),
  };
}

module.exports = {
  buildIndex,
  parseDateValue,
  parseJson,
  slugForText,
  sortableDuration,
};
