const fs = require("fs");
const path = require("path");

const {
  addLookup,
  parseDateValue,
  parseJson,
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

async function buildIndex({ dataDir, sourceDirs, databaseStatus, txtCachePath = null }) {
  const entries = new Map();
  const lookupMap = new Map();
  const manifests = [];
  const manifestErrors = [];
  const manifestFiles = await listManifestFiles(dataDir);
  const seenManifestKeys = new Set();
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
      if (dedupeKey && seenManifestKeys.has(dedupeKey)) continue;
      if (dedupeKey) seenManifestKeys.add(dedupeKey);

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

  await attachLocalFiles(entries, lookupMap, sourceDirs, { txtRecordCache });
  await txtRecordCache.persist();

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
