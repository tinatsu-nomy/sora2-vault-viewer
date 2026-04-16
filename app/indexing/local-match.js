const fs = require("fs");
const path = require("path");

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

function localAttachmentForGroup(group, localRecord) {
  return {
    mediaPath: group.mediaPath || null,
    source: group.source || localRecord.source || null,
    txtPath: group.txtPath || null,
    txtEncoding: localRecord.encoding,
    txtRaw: localRecord.rawText,
    txtPrompt: localRecord.prompt,
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

function sourceMatchesEntry(entry, localRecord) {
  const entryManifestSources = normalizeSourceMemberships(entry?.manifestSources || [entry?.manifestSource].filter(Boolean));
  const localDeclaredSource = localRecord?.declaredSource || null;
  const localSource = localRecord?.source || null;

  if (!entryManifestSources.length) return false;
  if (localDeclaredSource && entryManifestSources.includes(localDeclaredSource)) return true;
  if (entryManifestSources.includes(localSource)) return true;

  const customUsername = sourceUsername(localSource);
  if (!customUsername) return false;
  if (!entryManifestSources.includes("v2_user") && localDeclaredSource !== "v2_user") return false;

  return usernamesForEntry(entry).has(customUsername);
}

function scoreLocalMatch(entry, localRecord) {
  if (!entry || !sourceMatchesEntry(entry, localRecord)) return -1;

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

async function attachLocalFiles(entries, lookupMap, sourceDirs, { txtRecordCache = null } = {}) {
  const unmatchedLocals = new Map();

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
        attachLocalVariant(matchedEntry, source, localAttachmentForGroup(group, localRecord));
      } else {
        const unmatchedKey = localRecord.generationId || localRecord.postId || localRecord.taskId || localRecord.stem;
        const unmatchedId = `local:${unmatchedKey}`;
        const existingEntry = unmatchedLocals.get(unmatchedId);
        if (existingEntry) {
          attachLocalVariant(existingEntry, source, localAttachmentForGroup(group, localRecord));
          existingEntry.date = existingEntry.date || localRecord.date;
          existingEntry.prompt = existingEntry.prompt || localRecord.prompt;
          existingEntry.ratio = existingEntry.ratio || localRecord.aspectRatio || null;
          existingEntry.duration = existingEntry.duration || localRecord.duration || null;
          existingEntry.isLiked = Boolean(existingEntry.isLiked || localRecord.liked === "yes");
          existingEntry.idTokens = [...new Set([...(existingEntry.idTokens || []), ...(localRecord.idTokens || [])])];
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
          source,
          sourceMemberships: [source],
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
          isLiked: localRecord.liked === "yes",
          previewUrl: null,
          downloadUrl: null,
          thumbUrl: null,
          idTokens: localRecord.idTokens,
          local: null,
        };
        attachLocalVariant(unmatchedEntry, source, localAttachmentForGroup(group, localRecord));
        unmatchedLocals.set(unmatchedId, unmatchedEntry);
      }
    }
  }

  for (const entry of unmatchedLocals.values()) {
    entries.set(entry.id, entry);
  }

  applyCustomSourceAliases(entries, sourceDirs);
}

module.exports = {
  attachLocalFiles,
};
