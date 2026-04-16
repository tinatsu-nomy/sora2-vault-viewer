const path = require("path");

const { parseJson } = require("../indexer");

function createSerializers({ debugMode, enableSqliteCache, runtimePaths = {} }) {
  function mediaUrlFor(itemId, kind = "media") {
    return `/media?id=${encodeURIComponent(itemId)}&kind=${encodeURIComponent(kind)}`;
  }

  function fileNameOnly(filePath) {
    return path.basename(String(filePath || ""));
  }

  function contentDispositionInline(filePath) {
    const fileName = path.basename(filePath);
    const safeAsciiName = fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
    const encodedName = encodeURIComponent(fileName);
    return `inline; filename="${safeAsciiName}"; filename*=UTF-8''${encodedName}`;
  }

  function serializeListItem(item) {
    return {
      id: item.id,
      kind: item.kind,
      source: item.source,
      date: item.date,
      prompt: item.prompt,
      genId: item.genId,
      generationId: item.generationId,
      taskId: item.taskId,
      postId: item.postId,
      duration: item.duration,
      ratio: item.ratio,
      width: item.width,
      height: item.height,
      likeCount: item.likeCount,
      viewCount: item.viewCount,
      posterUsername: item.posterUsername || null,
      cameoOwnerUsernames: item.cameoOwnerUsernames || [],
      isLiked: item.isLiked,
      previewUrl: debugMode ? item.previewUrl : null,
      downloadUrl: debugMode ? item.downloadUrl : null,
      thumbUrl: debugMode ? item.thumbUrl : null,
      mediaUrl: item.hasLocalMedia ? mediaUrlFor(item.id, "media") : null,
      hasLocalMedia: item.hasLocalMedia,
      hasLocalText: item.hasLocalText,
    };
  }

  function serializeListRow(row) {
    return {
      id: row.id,
      kind: row.kind,
      source: row.source,
      date: row.date,
      prompt: row.prompt,
      genId: row.genId,
      generationId: row.generationId,
      taskId: row.taskId,
      postId: row.postId,
      duration: row.duration,
      ratio: row.ratio,
      width: row.width,
      height: row.height,
      likeCount: row.likeCount,
      viewCount: row.viewCount,
      posterUsername: row.posterUsername || null,
      cameoOwnerUsernames: parseJson(row.cameoOwnerUsernamesJson, []),
      isLiked: Boolean(row.isLiked),
      previewUrl: debugMode ? row.previewUrl : null,
      downloadUrl: debugMode ? row.downloadUrl : null,
      thumbUrl: debugMode ? row.thumbUrl : null,
      mediaUrl: row.hasLocalMedia ? mediaUrlFor(row.id, "media") : null,
      hasLocalMedia: Boolean(row.hasLocalMedia),
      hasLocalText: Boolean(row.hasLocalText),
    };
  }

  function serializeStats(stats, databaseStatus) {
    return {
      totalItems: stats.totalItems,
      manifestItems: stats.manifestItems,
      localOnlyItems: stats.localOnlyItems,
      withLocalMedia: stats.withLocalMedia,
      withLocalText: stats.withLocalText,
      sources: stats.sources,
      manifests: (stats.manifests || []).map((manifest) => ({
        file: fileNameOnly(manifest.file),
        exportedAt: manifest.exportedAt || null,
        total: manifest.total ?? null,
      })),
      manifestErrors: (stats.manifestErrors || []).map((entry) => ({
        file: fileNameOnly(entry.file),
        error: entry.error,
      })),
      database: {
        enabled: Boolean(databaseStatus?.enabled),
        savedItems: Number(databaseStatus?.savedItems || 0),
        error: databaseStatus?.error || null,
        configured: enableSqliteCache,
      },
      paths: {
        dataDir: runtimePaths.dataDir || null,
        appDataDir: runtimePaths.appDataDir || null,
        configPath: runtimePaths.configPath || null,
        sqlitePath: runtimePaths.dbPath || null,
        txtCachePath: runtimePaths.txtCachePath || null,
      },
      startupLogs: [
        runtimePaths.dataDir ? `Data directory: ${runtimePaths.dataDir}` : null,
        runtimePaths.appDataDir ? `App data directory: ${runtimePaths.appDataDir}` : null,
        runtimePaths.configPath ? `Config file: ${runtimePaths.configPath}` : null,
        runtimePaths.dbPath
          ? `SQLite cache: ${enableSqliteCache ? runtimePaths.dbPath : "disabled by environment"}`
          : null,
        runtimePaths.txtCachePath ? `TXT cache: ${runtimePaths.txtCachePath}` : null,
      ].filter(Boolean),
      debugEnabled: debugMode,
    };
  }

  function serializeDetailItem(item) {
    return {
      id: item.id,
      kind: item.kind,
      source: item.source,
      date: item.date,
      prompt: item.prompt,
      genId: item.genId,
      generationId: item.generationId,
      taskId: item.taskId,
      postId: item.postId,
      width: item.width,
      height: item.height,
      ratio: item.ratio,
      duration: item.duration,
      likeCount: item.likeCount,
      viewCount: item.viewCount,
      posterUsername: item.posterUsername || null,
      profileUserId: item.profileUserId || null,
      cameoOwnerUsernames: item.cameoOwnerUsernames || [],
      hasLocalMedia: item.hasLocalMedia,
      hasLocalText: item.hasLocalText,
      mediaUrl: item.hasLocalMedia ? mediaUrlFor(item.id, "media") : null,
      previewUrl: debugMode ? item.previewUrl : null,
      downloadUrl: debugMode ? item.downloadUrl : null,
      thumbUrl: debugMode ? item.thumbUrl : null,
      permalink: debugMode ? item.permalink || null : null,
      local: item.local
        ? {
            txtEncoding: item.local.txtEncoding || null,
            txtRaw: item.local.txtRaw || null,
            txtPrompt: item.local.txtPrompt || null,
            parsed: item.local.parsed || null,
            txtUrl: item.hasLocalText ? mediaUrlFor(item.id, "txt") : null,
          }
        : null,
      debug: debugMode
        ? {
            manifestFile: item.manifestFile || null,
            localMediaPath: item.local?.mediaPath || null,
            localTxtPath: item.local?.txtPath || null,
            manifestSearchText: item.manifestSearchText || null,
          }
        : null,
    };
  }

  return {
    contentDispositionInline,
    mediaUrlFor,
    serializeDetailItem,
    serializeListItem,
    serializeListRow,
    serializeStats,
  };
}

module.exports = {
  createSerializers,
};
