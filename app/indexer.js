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
  sortableIdCoreForItem,
  sortableDuration,
} = require("./indexing/common");
const {
  listManifestFiles,
  manifestDedupeKeyFromItem,
  parseManifestItem,
  readManifestDescriptor,
  streamManifestItems,
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

function parseManifestExportedAt(value) {
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function compareManifestPriority(left, right) {
  const leftExportedAtMs = left?.exportedAtMs;
  const rightExportedAtMs = right?.exportedAtMs;

  if (leftExportedAtMs != null && rightExportedAtMs != null && leftExportedAtMs !== rightExportedAtMs) {
    return rightExportedAtMs - leftExportedAtMs;
  }
  if (leftExportedAtMs != null && rightExportedAtMs == null) return -1;
  if (leftExportedAtMs == null && rightExportedAtMs != null) return 1;

  return String(right?.file || "").localeCompare(String(left?.file || ""));
}

function countUniqueCameoProfiles(entry) {
  const posterUsername = String(entry?.posterUsername || "").trim().replace(/^@+/, "");
  const usernames = (entry?.cameoProfiles || [])
    .map((profile) => String(profile?.username || "").trim().replace(/^@+/, ""))
    .filter(Boolean)
    .filter((username) => username !== posterUsername);
  return [...new Set(usernames)].length;
}

function mergeProfileMetadata(baseProfile, incomingProfile) {
  return {
    username: baseProfile?.username || incomingProfile?.username || null,
    userId: baseProfile?.userId || incomingProfile?.userId || null,
    displayName: baseProfile?.displayName || incomingProfile?.displayName || null,
    description: baseProfile?.description || incomingProfile?.description || null,
    ownerUsername: baseProfile?.ownerUsername || incomingProfile?.ownerUsername || null,
  };
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
  const cameoProfilesByUsername = new Map();
  for (const profile of [...(baseEntry.cameoProfiles || []), ...(incomingEntry.cameoProfiles || [])]) {
    if (!profile?.username) continue;
    const existingProfile = cameoProfilesByUsername.get(profile.username);
    cameoProfilesByUsername.set(
      profile.username,
      existingProfile ? mergeProfileMetadata(existingProfile, profile) : profile,
    );
  }
  const cameoProfiles = [...cameoProfilesByUsername.values()];
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
    posterDisplayName: baseEntry.posterDisplayName || incomingEntry.posterDisplayName || null,
    posterDescription: baseEntry.posterDescription || incomingEntry.posterDescription || null,
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

async function buildIndex({
  dataDir,
  sourceDirs,
  databaseStatus,
  txtCachePath = null,
  sourceOrder = [],
  onProgress = null,
}) {
  const entries = new Map();
  const lookupMap = new Map();
  const manifests = [];
  const manifestErrors = [];
  const manifestFiles = await listManifestFiles(dataDir);
  const manifestDescriptors = [];
  const seenManifestKeys = new Map();
  const txtRecordCache = createTxtRecordCache(txtCachePath);
  const reportProgress = (progress) => {
    if (typeof onProgress === "function") onProgress(progress);
  };

  reportProgress({
    phase: "manifest-descriptors",
    message: manifestFiles.length
      ? "Reading manifest headers..."
      : "No manifest files found. Matching local files...",
    detail: manifestFiles.length ? "" : "Falling back to local file indexing only.",
    current: 0,
    total: manifestFiles.length,
    unit: "manifest",
  });

  for (const [manifestIndex, manifestPath] of manifestFiles.entries()) {
    try {
      const descriptor = await readManifestDescriptor(manifestPath);
      manifestDescriptors.push({
        file: descriptor.file,
        exportedAt: descriptor.exportedAt,
        exportedAtMs: parseManifestExportedAt(descriptor.exportedAt),
        total: descriptor.total,
        scanSources: descriptor.scanSources,
      });
    } catch (error) {
      manifestErrors.push({
        file: manifestPath,
        error: `${error.code || "JSON_ERROR"}: ${error.message}`,
      });
      continue;
    } finally {
      reportProgress({
        phase: "manifest-descriptors",
        message: "Reading manifest headers...",
        detail: path.basename(manifestPath),
        current: manifestIndex + 1,
        total: manifestFiles.length,
        unit: "manifest",
      });
    }
  }

  manifestDescriptors.sort(compareManifestPriority);
  manifests.push(...manifestDescriptors.map((descriptor) => ({
    file: descriptor.file,
    exportedAt: descriptor.exportedAt,
    total: descriptor.total,
    scanSources: descriptor.scanSources,
  })));

  reportProgress({
    phase: "manifest-items",
    message: manifestDescriptors.length
      ? "Reading manifest items..."
      : "No manifest items to read.",
    detail: manifestDescriptors.length ? "" : "Proceeding to local file matching.",
    current: 0,
    total: manifestDescriptors.length,
    unit: "manifest",
  });

  for (const [descriptorIndex, descriptor] of manifestDescriptors.entries()) {
    try {
      const manifestTotal = Number.isFinite(descriptor.total) ? descriptor.total : null;
      await streamManifestItems(descriptor.file, async (item, itemIndex) => {
        if (itemIndex === 0 || (itemIndex + 1) % 250 === 0) {
          reportProgress({
            phase: "manifest-items",
            message: `Reading manifest ${descriptorIndex + 1} of ${manifestDescriptors.length}...`,
            detail: manifestTotal != null
              ? `${path.basename(descriptor.file)} (${itemIndex + 1}/${manifestTotal} items)`
              : `${path.basename(descriptor.file)} (${itemIndex + 1} items)`,
            current: descriptorIndex + 1,
            total: manifestDescriptors.length,
            unit: "manifest",
          });
        }

        const dedupeKey = manifestDedupeKeyFromItem(item);
        const entry = parseManifestItem(item, descriptor.file, descriptor.exportedAt, itemIndex);
        if (dedupeKey && seenManifestKeys.has(dedupeKey)) {
          const existingEntryId = seenManifestKeys.get(dedupeKey);
          const existingEntry = entries.get(existingEntryId);
          if (existingEntry) {
            const mergedEntry = mergeManifestEntries(entry, existingEntry);
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
          return;
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
      });
    } catch (error) {
      manifestErrors.push({
        file: descriptor.file,
        error: `${error.code || "JSON_ERROR"}: ${error.message}`,
      });
      continue;
    } finally {
      reportProgress({
        phase: "manifest-items",
        message: `Reading manifest ${descriptorIndex + 1} of ${manifestDescriptors.length}...`,
        detail: path.basename(descriptor.file),
        current: descriptorIndex + 1,
        total: manifestDescriptors.length,
        unit: "manifest",
      });
    }
  }

  reportProgress({
    phase: "local-files",
    message: "Matching local videos and text files...",
    detail: "",
    current: 0,
    total: Object.keys(sourceDirs).length,
    unit: "source",
  });

  const localAttachResult = await attachLocalFiles(entries, lookupMap, sourceDirs, {
    txtRecordCache,
    onProgress: reportProgress,
  });

  reportProgress({
    phase: "finalizing",
    message: "Saving text cache and preparing the final index...",
    detail: "",
    current: null,
    total: null,
    unit: null,
  });
  await txtRecordCache.persist();

  const items = [...entries.values()];
  const sourceSet = new Set();
  let manifestItemsCount = 0;
  let localOnlyItemsCount = 0;
  let withLocalMediaCount = 0;
  let withLocalTextCount = 0;
  const sourceDiagnostics = new Map();

  for (const entry of localAttachResult?.sourceDiagnostics || []) {
    sourceDiagnostics.set(entry.source, {
      ...entry,
      indexedItems: 0,
      primaryItems: 0,
      manifestItems: 0,
      localOnlyItems: 0,
      remoteOnlyItems: 0,
      itemsWithAnyLocalMedia: 0,
      itemsWithAnyLocalText: 0,
      itemsWithSourceLocalMedia: 0,
      itemsWithSourceLocalText: 0,
    });
  }

  function ensureSourceDiagnostics(source) {
    if (!source) return null;
    if (!sourceDiagnostics.has(source)) {
      sourceDiagnostics.set(source, {
        source,
        directoryPath: sourceDirs[source] || null,
        files: 0,
        mp4Files: 0,
        txtFiles: 0,
        fileGroups: 0,
        mediaGroups: 0,
        textGroups: 0,
        matchedGroups: 0,
        unmatchedGroups: 0,
        uniqueGenerationIds: 0,
        uniquePostIds: 0,
        uniqueTaskIds: 0,
        indexedItems: 0,
        primaryItems: 0,
        manifestItems: 0,
        localOnlyItems: 0,
        remoteOnlyItems: 0,
        itemsWithAnyLocalMedia: 0,
        itemsWithAnyLocalText: 0,
        itemsWithSourceLocalMedia: 0,
        itemsWithSourceLocalText: 0,
      });
    }
    return sourceDiagnostics.get(source);
  }

  for (const entry of items) {
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
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    entry.cameoCount = countUniqueCameoProfiles(entry);
    entry.dateSortMs = dateSortMs;
    entry.sortIdCore = sortableIdCoreForItem(entry);
    entry.hasLocalMedia = Boolean(entry.local?.mediaPath);
    entry.hasLocalText = Boolean(entry.local?.txtPath);
    entry.searchText = searchText;

    if (entry.kind === "manifest") manifestItemsCount += 1;
    if (entry.kind === "local-only") localOnlyItemsCount += 1;
    if (entry.hasLocalMedia) withLocalMediaCount += 1;
    if (entry.hasLocalText) withLocalTextCount += 1;
    for (const source of entry.sourceMemberships || [entry.source]) {
      if (source) sourceSet.add(source);
      const diagnostics = ensureSourceDiagnostics(source);
      if (!diagnostics) continue;
      diagnostics.indexedItems += 1;
      if (entry.source === source) diagnostics.primaryItems += 1;
      if (entry.kind === "manifest") diagnostics.manifestItems += 1;
      if (entry.kind === "local-only") diagnostics.localOnlyItems += 1;
      if (entry.kind === "manifest" && !entry.hasLocalMedia && !entry.hasLocalText) diagnostics.remoteOnlyItems += 1;
      if (entry.hasLocalMedia) diagnostics.itemsWithAnyLocalMedia += 1;
      if (entry.hasLocalText) diagnostics.itemsWithAnyLocalText += 1;
      if (entry.localVariants?.[source]?.mediaPath) diagnostics.itemsWithSourceLocalMedia += 1;
      if (entry.localVariants?.[source]?.txtPath) diagnostics.itemsWithSourceLocalText += 1;
    }
  }

  items.sort((left, right) => {
    return (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER)
      || right.id.localeCompare(left.id);
  });

  const statsSourceOrder = [...new Set([
    ...sourceOrder,
    ...sourceSet,
  ])].filter((source) => sourceSet.has(source));
  statsSourceOrder.sort(compareSourceKeys);

  const stats = {
    totalItems: items.length,
    manifestItems: manifestItemsCount,
    localOnlyItems: localOnlyItemsCount,
    withLocalMedia: withLocalMediaCount,
    withLocalText: withLocalTextCount,
    sources: [...sourceSet].sort(compareSourceKeys),
    sourceOrder: statsSourceOrder,
    sourceDiagnostics: statsSourceOrder
      .map((source) => ensureSourceDiagnostics(source))
      .filter(Boolean),
    manifests,
    manifestErrors,
    database: { ...(databaseStatus || {}) },
  };

  reportProgress({
    phase: "finalizing",
    message: "Final index snapshot ready.",
    detail: `${items.length} items prepared`,
    current: items.length,
    total: items.length,
    unit: "item",
  });

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
