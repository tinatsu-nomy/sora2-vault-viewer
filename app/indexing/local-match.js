const fs = require("fs");
const path = require("path");

const { classifyDirEntry, realPathKey } = require("../fs-utils");
const {
  basenameWithoutExt,
  compareSourceKeys,
  extractIdTokens,
  isCustomUserSource,
  normalizeSourceMemberships,
  pickPrimarySource,
  slugForText,
} = require("./common");
const { parseTxtRecord } = require("./text");

const fsp = fs.promises;

async function walkFiles(dirPath) {
  if (!dirPath) return [];

  const results = [];
  const stack = [dirPath];
  const visitedDirs = new Set();

  while (stack.length) {
    const current = stack.pop();
    const currentKey = await realPathKey(current);
    if (!currentKey || visitedDirs.has(currentKey)) continue;
    visitedDirs.add(currentKey);
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      const resolvedEntry = await classifyDirEntry(current, entry);
      if (resolvedEntry.type === "directory") {
        stack.push(resolvedEntry.path);
      } else if (resolvedEntry.type === "file") {
        results.push(resolvedEntry.path);
      }
    }
  }

  return results;
}

function createSourceDiagnostics(source, fileCount = 0, directoryPath = null) {
  return {
    source,
    directoryPath,
    files: fileCount,
    mp4Files: 0,
    txtFiles: 0,
    fileGroups: 0,
    mediaGroups: 0,
    textGroups: 0,
    matchedGroups: 0,
    unmatchedGroups: 0,
    _generationIds: new Set(),
    _postIds: new Set(),
    _taskIds: new Set(),
  };
}

function finalizeSourceDiagnostics(diagnostics) {
  return {
    source: diagnostics.source,
    directoryPath: diagnostics.directoryPath || null,
    files: diagnostics.files,
    mp4Files: diagnostics.mp4Files,
    txtFiles: diagnostics.txtFiles,
    fileGroups: diagnostics.fileGroups,
    mediaGroups: diagnostics.mediaGroups,
    textGroups: diagnostics.textGroups,
    matchedGroups: diagnostics.matchedGroups,
    unmatchedGroups: diagnostics.unmatchedGroups,
    uniqueGenerationIds: diagnostics._generationIds.size,
    uniquePostIds: diagnostics._postIds.size,
    uniqueTaskIds: diagnostics._taskIds.size,
  };
}

function localAttachmentForGroup(group, localRecord) {
  const effectiveSource = group.effectiveSource || localRecord.effectiveSource || localRecord.declaredSource || localRecord.source || null;
  return {
    mediaPath: group.mediaPath || null,
    source: effectiveSource,
    txtPath: group.txtPath || null,
    txtEncoding: localRecord.encoding,
    parsed: {
      declaredSource: localRecord.declaredSource || null,
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

function sourceMembershipsForEntry(entry) {
  return normalizeSourceMemberships(entry?.sourceMemberships || [entry?.source].filter(Boolean));
}

function applySourceMembership(entry, source) {
  const sourceMemberships = normalizeSourceMemberships([
    ...sourceMembershipsForEntry(entry),
    source,
  ]);
  entry.sourceMemberships = sourceMemberships;
  entry.source = pickPrimarySource(sourceMemberships) || entry.source || source;
}

function localAttachmentPriority(leftAttachment, rightAttachment) {
  return compareSourceKeys(leftAttachment?.source || "", rightAttachment?.source || "");
}

function attachLocalVariant(entry, source, attachment) {
  applySourceMembership(entry, source);
  if (!entry.localVariants) entry.localVariants = {};
  entry.localVariants[source] = attachment;
  if (!entry.local || localAttachmentPriority(attachment, entry.local) < 0) {
    entry.local = attachment;
  }
}

function normalizeUsername(value) {
  if (!value) return "";
  return String(value).trim().replace(/^@+/, "").toLowerCase();
}

function sourceUsername(source) {
  if (!source || !isCustomUserSource(source)) return "";
  return normalizeUsername(source.slice(3));
}

function pathSegmentsRelativeTo(rootDir, filePath) {
  if (!rootDir || !filePath) return [];
  const relativePath = path.relative(rootDir, path.dirname(filePath));
  return relativePath
    .split(path.sep)
    .map((segment) => String(segment || "").trim())
    .filter(Boolean);
}

function deriveNestedCreatorsSource(source, rootDir, filePath) {
  if (source !== "v2_creators") return null;
  const segments = pathSegmentsRelativeTo(rootDir, filePath);
  if (!segments.length) return null;

  const charactersIndex = segments.indexOf("characters");
  if (charactersIndex >= 0) {
    const characterName = segments[charactersIndex + 1];
    const subtype = segments[charactersIndex + 2] || null;
    if (characterName) {
      if (subtype === "drafts") return `v2_char_drafts_@${characterName}`;
      if (subtype === "posts") return `v2_char_@${characterName}`;
    }
    return null;
  }

  const username = segments[0];
  if (username && username !== "characters") {
    return `v2_@${username}`;
  }

  return null;
}

function effectiveLocalSource(localRecord) {
  return localRecord?.effectiveSource || localRecord?.declaredSource || localRecord?.source || null;
}

function usernamesForEntry(entry) {
  return new Set(
    [
      entry?.posterUsername,
      entry?.ownerUsername,
      ...(entry?.ownerUsernames || []),
      ...(entry?.cameoOwnerUsernames || []),
    ]
      .map((value) => normalizeUsername(value))
      .filter(Boolean),
  );
}

function extractMentionedUsernames(value) {
  const matches = new Set();
  const text = String(value || "");
  for (const match of text.matchAll(/@([a-z0-9._-]+)/gi)) {
    const username = normalizeUsername(match[1]);
    if (username) matches.add(username);
  }
  return [...matches];
}

function localOwnerMetadata(source, localRecord) {
  const posterUsername = sourceUsername(source) || null;
  const cameoOwnerUsernames = extractMentionedUsernames(localRecord?.prompt || "")
    .filter((username) => username && username !== posterUsername);
  const cameoProfiles = cameoOwnerUsernames.map((username) => ({
    username,
    userId: null,
  }));
  const ownerUsernames = [posterUsername, ...cameoOwnerUsernames].filter(Boolean);

  return {
    posterUsername,
    ownerUsername: ownerUsernames[0] || null,
    ownerUsernames,
    cameoOwnerUsernames,
    cameoProfiles,
  };
}

function sourceMatchesEntry(entry, localRecord) {
  const entryManifestSources = normalizeSourceMemberships(entry?.manifestSources || [entry?.manifestSource].filter(Boolean));
  const localDeclaredSource = localRecord?.declaredSource || null;
  const localSource = effectiveLocalSource(localRecord);

  if (!entryManifestSources.length) return false;
  if (localDeclaredSource && entryManifestSources.includes(localDeclaredSource)) return true;
  if (entryManifestSources.includes(localSource)) return true;

  const customUsername = sourceUsername(localSource);
  if (!customUsername) return false;
  if (!entryManifestSources.includes("v2_user") && localDeclaredSource !== "v2_user") return false;

  return usernamesForEntry(entry).has(customUsername);
}

function scoreLocalMatch(entry, localRecord) {
  if (!entry) return -1;

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

  const exactIds = [localRecord.generationId, localRecord.postId, localRecord.taskId]
    .filter(Boolean)
    .map((value) => slugForText(value));

  const hasStrongExactId = [localRecord.generationId, localRecord.postId]
    .filter(Boolean)
    .map((value) => slugForText(value))
    .some((value) => entryLookupValues.has(value));

  if (!sourceMatchesEntry(entry, localRecord) && !hasStrongExactId) return -1;

  for (const value of exactIds) {
    if (!entryLookupValues.has(value)) return -1;
  }

  let score = 0;
  if (localRecord.generationId) score += 100;
  if (localRecord.postId) score += 90;
  if (localRecord.taskId) score += 80;

  const localTokens = new Set(
    [...localRecord.idTokens, localRecord.stem]
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

function applyCustomSourceAliases(entries, sourceDirs) {
  const sourceByUsername = new Map();

  for (const source of Object.keys(sourceDirs)) {
    const username = sourceUsername(source);
    if (!username) continue;
    if (sourceByUsername.has(username)) {
      sourceByUsername.set(username, null);
      continue;
    }
    sourceByUsername.set(username, source);
  }

  for (const entry of entries.values()) {
    const manifestSources = normalizeSourceMemberships(entry.manifestSources || [entry.manifestSource].filter(Boolean));
    if (!manifestSources.includes("v2_user")) continue;
    if (sourceMembershipsForEntry(entry).some((source) => sourceUsername(source))) continue;

    const candidates = [
      normalizeUsername(entry.posterUsername),
      normalizeUsername(entry.ownerUsername),
      ...[...(entry.ownerUsernames || []), ...(entry.cameoOwnerUsernames || [])].map((value) => normalizeUsername(value)),
    ].filter(Boolean);

    for (const username of candidates) {
      const mappedSource = sourceByUsername.get(username);
      if (!mappedSource) continue;
      applySourceMembership(entry, mappedSource);
      break;
    }
  }
}

async function attachLocalFiles(entries, lookupMap, sourceDirs, { txtRecordCache = null, onProgress = null } = {}) {
  const unmatchedLocals = new Map();
  const sourceEntries = Object.entries(sourceDirs);
  const sourceDiagnostics = new Map();

  for (const [sourceIndex, [source, dirPath]] of sourceEntries.entries()) {
    const grouped = new Map();
    const filePaths = await walkFiles(dirPath);
    const diagnostics = createSourceDiagnostics(source, filePaths.length, dirPath);
    sourceDiagnostics.set(source, diagnostics);

    onProgress?.({
      phase: "local-files",
      message: `Matching local files for ${source}...`,
      detail: `${filePaths.length} discovered files`,
      current: sourceIndex + 1,
      total: sourceEntries.length,
      unit: "source",
    });

    for (const filePath of filePaths) {
      const stem = basenameWithoutExt(filePath);
      if (!grouped.has(stem)) grouped.set(stem, {});
      const group = grouped.get(stem);
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".mp4") {
        group.mediaPath = filePath;
        diagnostics.mp4Files += 1;
      }
      if (ext === ".txt") {
        group.txtPath = filePath;
        diagnostics.txtFiles += 1;
      }
      group.source = source;
    }
    diagnostics.fileGroups = grouped.size;

    let processedGroups = 0;
    for (const group of grouped.values()) {
      if (group.mediaPath) diagnostics.mediaGroups += 1;
      if (group.txtPath) diagnostics.textGroups += 1;
      const localRecord = group.txtPath
        ? await parseTxtRecord(group.txtPath, source, txtRecordCache)
        : {
            type: "localFile",
            source,
            declaredSource: null,
            generationId: null,
            taskId: null,
            postId: null,
            date: null,
            duration: null,
            resolution: null,
            aspectRatio: null,
            liked: null,
            prompt: "",
            encoding: null,
            stem: basenameWithoutExt(group.mediaPath),
            idTokens: extractIdTokens(group.mediaPath),
            filePath: group.mediaPath,
          };

      const representativePath = group.txtPath || group.mediaPath || localRecord.filePath || null;
      const derivedSource = deriveNestedCreatorsSource(source, dirPath, representativePath);
      const effectiveSource = derivedSource || localRecord.declaredSource || source;
      localRecord.derivedSource = derivedSource;
      localRecord.effectiveSource = effectiveSource;
      group.effectiveSource = effectiveSource;
      if (localRecord.generationId) diagnostics._generationIds.add(localRecord.generationId);
      if (localRecord.postId) diagnostics._postIds.add(localRecord.postId);
      if (localRecord.taskId) diagnostics._taskIds.add(localRecord.taskId);

      processedGroups += 1;
      if (processedGroups === 1 || processedGroups === grouped.size || processedGroups % 100 === 0) {
        onProgress?.({
          phase: "local-files",
          message: `Matching local files for ${source}...`,
          detail: `${processedGroups} of ${grouped.size} file groups`,
          current: sourceIndex + 1,
          total: sourceEntries.length,
          unit: "source",
        });
      }

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
        diagnostics.matchedGroups += 1;
        attachLocalVariant(matchedEntry, effectiveSource, localAttachmentForGroup(group, localRecord));
      } else {
        diagnostics.unmatchedGroups += 1;
        const unmatchedKey = localRecord.generationId || localRecord.postId || localRecord.taskId || localRecord.stem;
        const unmatchedId = `local:${unmatchedKey}`;
        const existingEntry = unmatchedLocals.get(unmatchedId);
        const ownerMetadata = localOwnerMetadata(effectiveSource, localRecord);
        if (existingEntry) {
          attachLocalVariant(existingEntry, effectiveSource, localAttachmentForGroup(group, localRecord));
          existingEntry.date = existingEntry.date || localRecord.date;
          existingEntry.prompt = existingEntry.prompt || localRecord.prompt;
          existingEntry.ratio = existingEntry.ratio || localRecord.aspectRatio || null;
          existingEntry.duration = existingEntry.duration || localRecord.duration || null;
          existingEntry.isLiked = Boolean(existingEntry.isLiked || localRecord.liked === "yes");
          existingEntry.idTokens = [...new Set([...(existingEntry.idTokens || []), ...(localRecord.idTokens || [])])];
          existingEntry.posterUsername = existingEntry.posterUsername || ownerMetadata.posterUsername;
          existingEntry.ownerUsername = existingEntry.ownerUsername || ownerMetadata.ownerUsername;
          existingEntry.ownerUsernames = [...new Set([...(existingEntry.ownerUsernames || []), ...(ownerMetadata.ownerUsernames || [])])];
          existingEntry.cameoOwnerUsernames = [...new Set([...(existingEntry.cameoOwnerUsernames || []), ...(ownerMetadata.cameoOwnerUsernames || [])])];
          existingEntry.cameoProfiles = [
            ...new Map(
              [
                ...(existingEntry.cameoProfiles || []),
                ...(ownerMetadata.cameoProfiles || []),
              ]
                .filter((profile) => profile?.username)
                .map((profile) => [profile.username, profile]),
            ).values(),
          ];
          existingEntry.manifestSources = normalizeSourceMemberships([
            ...(existingEntry.manifestSources || []),
            localRecord.declaredSource || null,
          ]);
          existingEntry.manifestSource = pickPrimarySource(existingEntry.manifestSources) || existingEntry.manifestSource || null;
          continue;
        }

        const unmatchedEntry = {
          id: unmatchedId,
          kind: "local-only",
          source: effectiveSource,
          sourceMemberships: [effectiveSource],
          manifestSource: localRecord.declaredSource || null,
          manifestSources: normalizeSourceMemberships([localRecord.declaredSource || null]),
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
          posterUsername: ownerMetadata.posterUsername,
          ownerUsername: ownerMetadata.ownerUsername,
          ownerUsernames: ownerMetadata.ownerUsernames,
          cameoOwnerUsernames: ownerMetadata.cameoOwnerUsernames,
          cameoProfiles: ownerMetadata.cameoProfiles,
          isLiked: localRecord.liked === "yes",
          previewUrl: null,
          downloadUrl: null,
          thumbUrl: null,
          idTokens: localRecord.idTokens,
          local: null,
        };
        attachLocalVariant(unmatchedEntry, effectiveSource, localAttachmentForGroup(group, localRecord));
        unmatchedLocals.set(unmatchedId, unmatchedEntry);
      }
    }
  }

  for (const entry of unmatchedLocals.values()) {
    entries.set(entry.id, entry);
  }

  applyCustomSourceAliases(entries, sourceDirs);

  return {
    sourceDiagnostics: sourceEntries
      .map(([source]) => sourceDiagnostics.get(source))
      .filter(Boolean)
      .map(finalizeSourceDiagnostics),
  };
}

module.exports = {
  attachLocalFiles,
};
