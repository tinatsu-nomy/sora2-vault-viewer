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
  manifestSearchText,
  parseManifestItem,
} = require("./indexing/manifest");
const { attachLocalFiles } = require("./indexing/local-match");

const fsp = fs.promises;

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
