const fs = require("fs");
const path = require("path");

const { classifyDirEntry } = require("../fs-utils");
const { extractIdTokens } = require("./common");

const fsp = fs.promises;
const HEADER_SEARCH_LIMIT_CHARS = 16 * 1024 * 1024;
const STREAM_CHUNK_SIZE = 1024 * 1024;
const MERGED_MANIFEST_FILE_RE = /^soravault_manifest_merged_\d{4}-\d{2}-\d{2}_\d{6}_part\d+\.json$/i;
const LEGACY_MANIFEST_FILE_RE = /^soravault_manifest_.+\.json$/i;

function createManifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSupportedManifestFileName(fileName) {
  const name = String(fileName || "");
  return MERGED_MANIFEST_FILE_RE.test(name) || LEGACY_MANIFEST_FILE_RE.test(name);
}

async function listManifestFiles(dataDir) {
  try {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    const manifestPaths = [];
    for (const entry of entries) {
      const resolvedEntry = await classifyDirEntry(dataDir, entry);
      if (resolvedEntry.type !== "file") continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".json") continue;
      if (!isSupportedManifestFileName(entry.name)) continue;
      manifestPaths.push(resolvedEntry.path);
    }
    return manifestPaths.sort();
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function findTopLevelItemsKey(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      if (depth === 1 && text.startsWith("\"items\"", index)) {
        let cursor = index + "\"items\"".length;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
        if (cursor >= text.length) return null;
        if (text[cursor] !== ":") continue;
        cursor += 1;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
        if (cursor >= text.length) return null;
        if (text[cursor] === "[") {
          return {
            keyIndex: index,
            arrayStartIndex: cursor,
          };
        }
      }
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
    }
  }

  return null;
}

function parseManifestDescriptor(raw, manifestPath) {
  return {
    file: manifestPath,
    exportedAt: raw.exported_at || null,
    total: raw.total ?? null,
    scanSources: Array.isArray(raw.scan_sources) ? raw.scan_sources : null,
  };
}

async function readManifestDescriptor(manifestPath) {
  const stream = fs.createReadStream(manifestPath, {
    encoding: "utf8",
    highWaterMark: STREAM_CHUNK_SIZE,
  });

  let headerBuffer = "";
  for await (const chunk of stream) {
    headerBuffer += chunk;
    const itemsKey = findTopLevelItemsKey(headerBuffer);
    if (itemsKey) {
      const descriptorJson = `${headerBuffer.slice(0, itemsKey.keyIndex)}"items":[]}`;
      const raw = JSON.parse(descriptorJson);
      return parseManifestDescriptor(raw, manifestPath);
    }

    if (headerBuffer.length > HEADER_SEARCH_LIMIT_CHARS) {
      throw createManifestError(
        "MANIFEST_HEADER_TOO_LARGE",
        `Could not locate the top-level items array within the first ${HEADER_SEARCH_LIMIT_CHARS} characters.`,
      );
    }
  }

  throw createManifestError("MANIFEST_ITEMS_NOT_FOUND", "Could not locate the top-level items array.");
}

async function streamManifestItems(manifestPath, onItem) {
  const stream = fs.createReadStream(manifestPath, {
    encoding: "utf8",
    highWaterMark: STREAM_CHUNK_SIZE,
  });

  let buffer = "";
  let itemsStarted = false;
  let itemsEnded = false;
  let parseIndex = 0;
  let itemIndex = 0;
  let objectStart = -1;
  let braceDepth = 0;
  let inString = false;
  let escaped = false;

  outer:
  for await (const chunk of stream) {
    buffer += chunk;

    if (!itemsStarted) {
      const itemsKey = findTopLevelItemsKey(buffer);
      if (!itemsKey) {
        if (buffer.length > HEADER_SEARCH_LIMIT_CHARS) {
          throw createManifestError(
            "MANIFEST_HEADER_TOO_LARGE",
            `Could not locate the top-level items array within the first ${HEADER_SEARCH_LIMIT_CHARS} characters.`,
          );
        }
        continue;
      }

      buffer = buffer.slice(itemsKey.arrayStartIndex + 1);
      itemsStarted = true;
      parseIndex = 0;
    }

    while (parseIndex < buffer.length) {
      const char = buffer[parseIndex];

      if (objectStart < 0) {
        if (char === "," || /\s/.test(char)) {
          parseIndex += 1;
          continue;
        }

        if (char === "]") {
          itemsEnded = true;
          break outer;
        }

        if (char !== "{") {
          throw createManifestError(
            "MANIFEST_ITEM_PARSE_ERROR",
            `Unexpected token '${char}' while parsing manifest items.`,
          );
        }

        objectStart = parseIndex;
        braceDepth = 1;
        inString = false;
        escaped = false;
        parseIndex += 1;
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        parseIndex += 1;
        continue;
      }

      if (char === "\"") {
        inString = true;
        parseIndex += 1;
        continue;
      }

      if (char === "{") {
        braceDepth += 1;
        parseIndex += 1;
        continue;
      }

      if (char === "}") {
        braceDepth -= 1;
        parseIndex += 1;

        if (braceDepth === 0) {
          const itemJson = buffer.slice(objectStart, parseIndex);
          const item = JSON.parse(itemJson);
          await onItem(item, itemIndex);
          itemIndex += 1;

          buffer = buffer.slice(parseIndex);
          parseIndex = 0;
          objectStart = -1;
        }
        continue;
      }

      parseIndex += 1;
    }

    if (objectStart >= 0 && objectStart > 0) {
      buffer = buffer.slice(objectStart);
      parseIndex -= objectStart;
      objectStart = 0;
    } else if (objectStart < 0 && parseIndex > 0) {
      buffer = buffer.slice(parseIndex);
      parseIndex = 0;
    }
  }

  if (!itemsStarted) {
    throw createManifestError("MANIFEST_ITEMS_NOT_FOUND", "Could not locate the top-level items array.");
  }

  if (objectStart >= 0) {
    throw createManifestError("MANIFEST_ITEM_TRUNCATED", "Manifest items ended before a JSON object was closed.");
  }

  if (!itemsEnded) {
    const remaining = buffer.trimStart();
    if (!remaining.startsWith("]")) {
      throw createManifestError("MANIFEST_ITEMS_NOT_TERMINATED", "Manifest items array did not terminate cleanly.");
    }
  }
}

function manifestIdentity(item) {
  const post = item?._raw?.post || {};
  const attachment = post.attachments?.[0] || item?._raw || {};
  const source = item?.source || "unknown";
  const generationId = attachment.generation_id || item?._raw?.generation_id || null;
  const taskId = item?.taskId || attachment.task_id || item?._raw?.task_id || null;
  const postId = item?.postId || post.id || null;
  const preferredId = item?.genId || generationId || postId || taskId || null;

  return {
    source,
    generationId,
    taskId,
    postId,
    preferredId,
  };
}

function manifestDedupeKeyFromItem(item) {
  const identity = manifestIdentity(item);
  if (!identity.preferredId) return null;
  return identity.preferredId;
}

function pushSearchValue(values, value) {
  if (value == null) return;
  const text = String(value).trim();
  if (!text) return;
  if (/^https?:\/\//i.test(text)) return;
  values.push(text);
}

function appendProfileSearchValues(profile, values, seen = new Set()) {
  if (!profile || typeof profile !== "object" || seen.has(profile)) return;
  seen.add(profile);

  for (const key of ["username", "display_name", "description", "location", "public_figure_name"]) {
    pushSearchValue(values, profile[key]);
  }

  appendProfileSearchValues(profile.owner_profile, values, seen);
}

function buildManifestSearchText(item) {
  const raw = item?._raw || {};
  const post = raw.post || {};
  const attachment = post.attachments?.[0] || raw || {};
  const values = [];
  const seenProfiles = new Set();

  for (const value of [
    item?.mode,
    raw.model,
    raw.style,
    post.caption,
    post.discovery_phrase,
    post.audience_description,
    post.emoji,
    post.visibility,
    attachment.type,
    attachment.model,
    attachment.style,
  ]) {
    pushSearchValue(values, value);
  }

  appendProfileSearchValues(raw.profile, values, seenProfiles);

  for (const cameoProfile of post.cameo_profiles || []) {
    appendProfileSearchValues(cameoProfile, values, seenProfiles);
  }

  for (const facet of post.text_facets || []) {
    appendProfileSearchValues(facet?.profile, values, seenProfiles);
  }

  return [...new Set(values)].join("\n");
}

function parseManifestItem(item, manifestPath, exportedAt, itemIndex) {
  const post = item?._raw?.post || {};
  const attachment = post.attachments?.[0] || item?._raw || {};
  const {
    source,
    generationId,
    taskId,
    postId,
    preferredId,
  } = manifestIdentity(item);
  const posterUsername = item?._raw?.profile?.username || null;
  const profileUserId = item?._raw?.profile?.user_id || null;
  const posterDisplayName = item?._raw?.profile?.display_name || null;
  const posterDescription = item?._raw?.profile?.description || null;
  const cameoProfiles = (post.cameo_profiles || [])
    .map((profile) => ({
      username: profile?.username || null,
      userId: profile?.user_id || null,
      displayName: profile?.display_name || profile?.owner_profile?.display_name || null,
      description: profile?.description || profile?.owner_profile?.description || null,
      ownerUsername: profile?.owner_profile?.username || null,
    }))
    .filter((profile) => profile.username);
  const cameoOwnerUsernames = [
    ...cameoProfiles.map((profile) => profile.username),
    ...cameoProfiles.map((profile) => profile.ownerUsername),
  ].filter(Boolean);
  const uniqueCameoOwnerUsernames = [...new Set(cameoOwnerUsernames)].filter((username) => username !== posterUsername);
  const uniqueCameoProfiles = cameoProfiles.filter((profile, index, allProfiles) => {
    if (profile.username === posterUsername) return false;
    return allProfiles.findIndex((candidate) => candidate.username === profile.username) === index;
  });
  const ownerUsernames = [posterUsername, ...uniqueCameoOwnerUsernames].filter(Boolean);
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

  const manifestStem = path.basename(manifestPath, path.extname(manifestPath));

  return {
    id: preferredId ? preferredId : `manifest:${manifestStem}:${itemIndex}`,
    kind: "manifest",
    source,
    manifestSource: source,
    sourceMemberships: source === "v2_user" ? [] : [source],
    manifestSources: [source],
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
    profileUserId,
    posterDisplayName,
    posterDescription,
    ownerUsername: uniqueOwnerUsernames[0] || null,
    ownerUsernames: uniqueOwnerUsernames,
    cameoOwnerUsernames: uniqueCameoOwnerUsernames,
    cameoProfiles: uniqueCameoProfiles,
    isLiked: Boolean(item.isLiked),
    previewUrl: item.previewUrl || null,
    downloadUrl: item.downloadUrl || null,
    thumbUrl: item.thumbUrl || null,
    permalink: post.permalink || null,
    manifestSearchText: buildManifestSearchText(item),
    idTokens: [...idTokens],
  };
}

module.exports = {
  isSupportedManifestFileName,
  buildManifestSearchText,
  listManifestFiles,
  manifestDedupeKeyFromItem,
  parseManifestItem,
  readManifestDescriptor,
  streamManifestItems,
};
