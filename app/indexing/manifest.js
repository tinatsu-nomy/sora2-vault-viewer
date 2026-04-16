const fs = require("fs");
const path = require("path");

const { extractIdTokens } = require("./common");

const fsp = fs.promises;

async function listManifestFiles(dataDir) {
  try {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (!entry.isFile()) return false;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== ".json") return false;
        return entry.name.toLowerCase().startsWith("soravault_manifest_");
      })
      .map((entry) => path.join(dataDir, entry.name))
      .sort();
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
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
    ownerUsername: uniqueOwnerUsernames[0] || null,
    ownerUsernames: uniqueOwnerUsernames,
    cameoOwnerUsernames: uniqueCameoOwnerUsernames,
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
  buildManifestSearchText,
  listManifestFiles,
  manifestDedupeKeyFromItem,
  parseManifestItem,
};
