const fs = require("fs");
const path = require("path");

const {
  basenameWithoutExt,
  extractIdTokens,
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

module.exports = {
  attachLocalFiles,
};
