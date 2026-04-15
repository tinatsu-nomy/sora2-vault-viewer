const fs = require("fs");
const path = require("path");

const { extractIdTokens } = require("./common");

const fsp = fs.promises;

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

function parseManifestItem(item, manifestPath, exportedAt, itemIndex) {
  const post = item?._raw?.post || {};
  const attachment = post.attachments?.[0] || item?._raw || {};
  const source = item.source || "unknown";
  const posterUsername = item?._raw?.profile?.username || null;
  const cameoOwnerUsernames = [
    ...(post.cameo_profiles || []).map((profile) => profile?.username),
  ].filter(Boolean);
  const uniqueCameoOwnerUsernames = [...new Set(cameoOwnerUsernames)].filter((username) => username !== posterUsername);
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

module.exports = {
  listManifestFiles,
  manifestSearchText,
  parseManifestItem,
};
