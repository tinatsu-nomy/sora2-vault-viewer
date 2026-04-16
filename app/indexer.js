const fs = require("fs");
const path = require("path");

const {
  addLookup,
  compareSourceKeys,
  normalizeSourceMemberships,
  parseDateValue,
  parseJson,
  pickPrimarySource,
  slugForText,
  sortableDuration,
} = require("./indexing/common");
const {
  listManifestFiles,
  manifestDedupeKeyFromItem,
  parseManifestItem,
} = require("./indexing/manifest");
const { attachLocalFiles } = require("./indexing/local-match");
const { createTxtRecordCache } = require("./indexing/text");

const fsp = fs.promises;

function mergeTextBlocks(left, right) {
  const values = [left, right]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(values)].join("\n");
}

function mergeManifestEntries(baseEntry, incomingEntry) {
  const sourceMemberships = normalizeSourceMemberships([
    ...(baseEntry.sourceMemberships || [baseEntry.source].filter(Boolean)),
    ...(incomingEntry.sourceMemberships || [incomingEntry.source].filter(Boolean)),
  ]);
  const manifestSources = normalizeSourceMemberships([
    ...(baseEntry.manifestSources || [baseEntry.manifestSource].filter(Boolean)),
    ...(incomingEntry.manifestSources || [incomingEntry.manifestSource].filter(Boolean)),
  ]);
  const ownerUsernames = [...new Set([
    ...(baseEntry.ownerUsernames || []),
    ...(incomingEntry.ownerUsernames || []),
  ])].filter(Boolean);
  const cameoOwnerUsernames = [...new Set([
    ...(baseEntry.cameoOwnerUsernames || []),
    ...(incomingEntry.cameoOwnerUsernames || []),
  ])].filter(Boolean);
  const cameoProfiles = [
    ...new Map(
      [
        ...(baseEntry.cameoProfiles || []),
        ...(incomingEntry.cameoProfiles || []),
      ]
        .filter((profile) => profile?.username)
        .map((profile) => [profile.username, profile]),
    ).values(),
  ];
  const idTokens = [...new Set([
    ...(baseEntry.idTokens || []),
    ...(incomingEntry.idTokens || []),
  ])].filter(Boolean);

  return {
    ...baseEntry,
    source: pickPrimarySource(sourceMemberships) || baseEntry.source || incomingEntry.source,
    manifestSource: pickPrimarySource(manifestSources) || baseEntry.manifestSource || incomingEntry.manifestSource,
    sourceMemberships,
    manifestSources,
    date: baseEntry.date || incomingEntry.date || null,
    prompt: baseEntry.prompt || incomingEntry.prompt || "",
    manifestExportedAt: baseEntry.manifestExportedAt || incomingEntry.manifestExportedAt || null,
    manifestFile: baseEntry.manifestFile || incomingEntry.manifestFile || null,
    mode: baseEntry.mode || incomingEntry.mode || null,
    genId: baseEntry.genId || incomingEntry.genId || null,
    generationId: baseEntry.generationId || incomingEntry.generationId || null,
    taskId: baseEntry.taskId || incomingEntry.taskId || null,
    postId: baseEntry.postId || incomingEntry.postId || null,
    width: baseEntry.width || incomingEntry.width || null,
    height: baseEntry.height || incomingEntry.height || null,
    ratio: baseEntry.ratio || incomingEntry.ratio || null,
    duration: baseEntry.duration || incomingEntry.duration || null,
    likeCount: typeof baseEntry.likeCount === "number" ? baseEntry.likeCount : incomingEntry.likeCount,
    viewCount: typeof baseEntry.viewCount === "number" ? baseEntry.viewCount : incomingEntry.viewCount,
    posterUsername: baseEntry.posterUsername || incomingEntry.posterUsername || null,
    profileUserId: baseEntry.profileUserId || incomingEntry.profileUserId || null,
    ownerUsername: baseEntry.ownerUsername || incomingEntry.ownerUsername || null,
    ownerUsernames,
    cameoOwnerUsernames,
    cameoProfiles,
    isLiked: Boolean(baseEntry.isLiked || incomingEntry.isLiked),
    previewUrl: baseEntry.previewUrl || incomingEntry.previewUrl || null,
    downloadUrl: baseEntry.downloadUrl || incomingEntry.downloadUrl || null,
    thumbUrl: baseEntry.thumbUrl || incomingEntry.thumbUrl || null,
    permalink: baseEntry.permalink || incomingEntry.permalink || null,
    manifestSearchText: mergeTextBlocks(baseEntry.manifestSearchText, incomingEntry.manifestSearchText),
    idTokens,
  };
}

async function buildIndex({ dataDir, sourceDirs, databaseStatus, txtCachePath = null, sourceOrder = [] }) {
  const entries = new Map();
  const lookupMap = new Map();
  const manifests = [];
  const manifestErrors = [];
  const manifestFiles = await listManifestFiles(dataDir);
  const seenManifestKeys = new Map();
  const txtRecordCache = createTxtRecordCache(txtCachePath);

  for (const manifestPath of [...manifestFiles].reverse()) {
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

    manifests.unshift({
      file: manifestPath,
      exportedAt: raw.exported_at,
      total: raw.total,
      scanSources: raw.scan_sources,
    });

    const manifestItems = Array.isArray(raw.items) ? raw.items : [];
    for (let itemIndex = manifestItems.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = manifestItems[itemIndex];
      const dedupeKey = manifestDedupeKeyFromItem(item);
      const entry = parseManifestItem(item, manifestPath, raw.exported_at, itemIndex);
      if (dedupeKey && seenManifestKeys.has(dedupeKey)) {
        const existingEntryId = seenManifestKeys.get(dedupeKey);
        const existingEntry = entries.get(existingEntryId);
        if (existingEntry) {
          const mergedEntry = mergeManifestEntries(existingEntry, entry);
          entries.set(existingEntryId, mergedEntry);
          for (const token of [
            mergedEntry.id,
            mergedEntry.genId,
            mergedEntry.generationId,
            mergedEntry.taskId,
            mergedEntry.postId,
            ...mergedEntry.idTokens,
          ]) {
            addLookup(lookupMap, token, existingEntryId);
          }
        }
        continue;
      }
      if (dedupeKey) seenManifestKeys.set(dedupeKey, entry.id);
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

  await attachLocalFiles(entries, lookupMap, sourceDirs, { txtRecordCache });
  await txtRecordCache.persist();

  const items = [...entries.values()].map((entry) => {
    const dateSortMs = parseDateValue(entry.date);
    const searchText = [
      entry.prompt,
      entry.source,
      ...(entry.sourceMemberships || []),
      entry.manifestSource,
      ...(entry.manifestSources || []),
      entry.date,
      entry.genId,
      entry.generationId,
      entry.taskId,
      entry.postId,
      entry.posterUsername,
      ...(entry.ownerUsernames || []),
      ...(entry.cameoOwnerUsernames || []),
      entry.manifestFile ? path.basename(entry.manifestFile) : null,
      entry.manifestSearchText,
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

  const statsSourceOrder = [...new Set([
    ...sourceOrder,
    ...items.flatMap((item) => item.sourceMemberships || [item.source]).filter(Boolean),
  ])];
  statsSourceOrder.sort(compareSourceKeys);

  const stats = {
    totalItems: items.length,
    manifestItems: items.filter((item) => item.kind === "manifest").length,
    localOnlyItems: items.filter((item) => item.kind === "local-only").length,
    withLocalMedia: items.filter((item) => item.hasLocalMedia).length,
    withLocalText: items.filter((item) => item.hasLocalText).length,
    sources: [...new Set(items.flatMap((item) => item.sourceMemberships || [item.source]).filter(Boolean))].sort(compareSourceKeys),
    sourceOrder: statsSourceOrder,
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
