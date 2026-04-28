const fs = require("fs");

const { parseJson, sortableDuration } = require("./indexer");

function createStore({ enabled, dbPath, appDataDir, schemaVersion }) {
  let db = null;
  let DatabaseSync = null;
  let status = {
    enabled: false,
    path: dbPath,
    savedItems: 0,
    error: enabled ? null : "disabled by environment",
  };

  function getStatus() {
    return { ...status };
  }

  function ensureDatabaseSync() {
    if (!DatabaseSync) {
      ({ DatabaseSync } = require("node:sqlite"));
    }
    return DatabaseSync;
  }

  function initializeDatabase(database, { resetOnSchemaMismatch }) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const currentSchemaVersion = database.prepare("SELECT value FROM cache_meta WHERE key = ?").get("schemaVersion")?.value || null;
    if (resetOnSchemaMismatch && currentSchemaVersion !== schemaVersion) {
      database.exec(`
        DELETE FROM cache_meta;
        DROP TABLE IF EXISTS items;
        DROP TABLE IF EXISTS items_fts;
        DROP TABLE IF EXISTS scan_state;
        DROP TABLE IF EXISTS manifest_inventory;
        DROP TABLE IF EXISTS manifest_items;
        DROP TABLE IF EXISTS source_inventory;
        DROP TABLE IF EXISTS file_inventory;
        DROP TABLE IF EXISTS txt_parse_cache;
        DROP TABLE IF EXISTS group_inventory;
        DROP TABLE IF EXISTS match_inventory;
      `);
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        sort_id_core TEXT,
        source TEXT,
        source_memberships_json TEXT NOT NULL,
        kind TEXT,
        date TEXT,
        date_sort_ms INTEGER,
        card_sort_ms INTEGER,
        prompt TEXT,
        gen_id TEXT,
        generation_id TEXT,
        task_id TEXT,
        post_id TEXT,
        poster_username TEXT,
        cameo_count INTEGER,
        owner_usernames_json TEXT NOT NULL,
        cameo_owner_usernames_json TEXT NOT NULL,
        searchable_usernames_json TEXT NOT NULL,
        duration TEXT,
        duration_sort REAL,
        ratio TEXT,
        width INTEGER,
        height INTEGER,
        like_count INTEGER,
        view_count INTEGER,
        is_liked INTEGER,
        has_local_media INTEGER,
        has_local_text INTEGER,
        thumb_url TEXT,
        preview_url TEXT,
        download_url TEXT,
        local_media_path TEXT,
        local_txt_path TEXT,
        search_text TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_items_source_date ON items(source, date);
      CREATE INDEX IF NOT EXISTS idx_items_date_sort_ms ON items(date_sort_ms);
      CREATE INDEX IF NOT EXISTS idx_items_card_sort_ms ON items(card_sort_ms);
      CREATE INDEX IF NOT EXISTS idx_items_post_id ON items(post_id);
      CREATE INDEX IF NOT EXISTS idx_items_task_id ON items(task_id);
      CREATE INDEX IF NOT EXISTS idx_items_generation_id ON items(generation_id);
      CREATE INDEX IF NOT EXISTS idx_items_local_flags ON items(has_local_media, has_local_text);
      CREATE INDEX IF NOT EXISTS idx_items_views ON items(view_count);
      CREATE INDEX IF NOT EXISTS idx_items_likes ON items(like_count);
      CREATE INDEX IF NOT EXISTS idx_items_duration_sort ON items(duration_sort);

      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        id UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS scan_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manifest_inventory (
        manifest_path TEXT PRIMARY KEY,
        size INTEGER,
        mtime_ms INTEGER,
        exported_at TEXT,
        exported_at_ms INTEGER,
        total_items INTEGER,
        scan_sources_json TEXT NOT NULL,
        content_hash TEXT,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manifest_items (
        manifest_path TEXT NOT NULL,
        item_ordinal INTEGER NOT NULL,
        dedupe_key TEXT,
        item_id TEXT NOT NULL,
        source TEXT,
        manifest_source TEXT,
        source_memberships_json TEXT NOT NULL,
        manifest_sources_json TEXT NOT NULL,
        gen_id TEXT,
        generation_id TEXT,
        task_id TEXT,
        post_id TEXT,
        date TEXT,
        updated_at TEXT,
        posted_at TEXT,
        created_at TEXT,
        sort_timestamp_ms INTEGER,
        prompt TEXT,
        width INTEGER,
        height INTEGER,
        ratio TEXT,
        duration TEXT,
        like_count INTEGER,
        view_count INTEGER,
        poster_username TEXT,
        profile_user_id TEXT,
        poster_display_name TEXT,
        poster_description TEXT,
        owner_username TEXT,
        owner_usernames_json TEXT NOT NULL,
        cameo_owner_usernames_json TEXT NOT NULL,
        cameo_profiles_json TEXT NOT NULL,
        searchable_usernames_json TEXT NOT NULL,
        is_liked INTEGER NOT NULL DEFAULT 0,
        preview_url TEXT,
        download_url TEXT,
        thumb_url TEXT,
        permalink TEXT,
        id_tokens_json TEXT NOT NULL,
        manifest_search_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (manifest_path, item_ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_manifest_items_dedupe_key ON manifest_items(dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_manifest_items_item_id ON manifest_items(item_id);
      CREATE INDEX IF NOT EXISTS idx_manifest_items_gen_id ON manifest_items(gen_id);
      CREATE INDEX IF NOT EXISTS idx_manifest_items_post_id ON manifest_items(post_id);
      CREATE INDEX IF NOT EXISTS idx_manifest_items_task_id ON manifest_items(task_id);

      CREATE TABLE IF NOT EXISTS source_inventory (
        source TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        root_realpath TEXT,
        platform TEXT NOT NULL,
        dir_mtime_ms INTEGER,
        file_count INTEGER NOT NULL DEFAULT 0,
        group_count INTEGER NOT NULL DEFAULT 0,
        inventory_hash TEXT,
        last_scan_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_inventory (
        file_path TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        stem TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        ctime_ms INTEGER,
        parent_dir TEXT NOT NULL,
        real_path_key TEXT,
        file_id TEXT,
        exists_flag INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_inventory_source ON file_inventory(source);
      CREATE INDEX IF NOT EXISTS idx_file_inventory_stem ON file_inventory(source, stem);
      CREATE INDEX IF NOT EXISTS idx_file_inventory_file_id ON file_inventory(file_id);

      CREATE TABLE IF NOT EXISTS txt_parse_cache (
        txt_path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        encoding TEXT,
        declared_source TEXT,
        generation_id TEXT,
        task_id TEXT,
        post_id TEXT,
        date TEXT,
        duration TEXT,
        resolution TEXT,
        aspect_ratio TEXT,
        liked TEXT,
        author_username TEXT,
        author_display_name TEXT,
        cameo_usernames_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        id_tokens_json TEXT NOT NULL,
        parsed_json TEXT NOT NULL,
        cache_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_inventory (
        group_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        stem TEXT NOT NULL,
        media_path TEXT,
        txt_path TEXT,
        group_mtime_ms INTEGER,
        group_hash TEXT,
        declared_source TEXT,
        effective_source TEXT,
        generation_id TEXT,
        task_id TEXT,
        post_id TEXT,
        date TEXT,
        duration TEXT,
        resolution TEXT,
        aspect_ratio TEXT,
        liked TEXT,
        author_username TEXT,
        author_display_name TEXT,
        cameo_usernames_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        id_tokens_json TEXT NOT NULL,
        local_attachment_json TEXT NOT NULL,
        last_built_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_group_inventory_source ON group_inventory(source);
      CREATE INDEX IF NOT EXISTS idx_group_inventory_ids ON group_inventory(generation_id, post_id, task_id);

      CREATE TABLE IF NOT EXISTS match_inventory (
        entry_id TEXT NOT NULL,
        group_key TEXT NOT NULL,
        match_score INTEGER NOT NULL,
        reason TEXT,
        matched_at TEXT NOT NULL,
        PRIMARY KEY (entry_id, group_key)
      );

      CREATE INDEX IF NOT EXISTS idx_match_inventory_group_key ON match_inventory(group_key);
    `);

    database.prepare(`
      INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)
    `).run("schemaVersion", schemaVersion);
  }

  function closeDatabase(database) {
    if (!database) return;
    try {
      database.close();
    } catch {}
  }

  function resetLiveDatabaseHandle() {
    closeDatabase(db);
    db = null;
  }

  function removeSqliteArtifacts(filePath) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        fs.rmSync(`${filePath}${suffix}`, { force: true });
      } catch {}
    }
  }

  function openDatabase(filePath, { resetOnSchemaMismatch = true } = {}) {
    fs.mkdirSync(appDataDir, { recursive: true });
    const SyncDatabase = ensureDatabaseSync();
    const database = new SyncDatabase(filePath);
    initializeDatabase(database, { resetOnSchemaMismatch });
    return database;
  }

  function clearPersistedCache() {
    resetLiveDatabaseHandle();
    removeSqliteArtifacts(dbPath);
    removeSqliteArtifacts(`${dbPath}.next`);
    removeSqliteArtifacts(`${dbPath}.bak`);
    status = {
      enabled: false,
      path: dbPath,
      savedItems: 0,
      error: null,
    };
  }

  function getDb() {
    if (!enabled) return null;
    if (db) return db;

    try {
      db = openDatabase(dbPath, { resetOnSchemaMismatch: true });
      return db;
    } catch (error) {
      db = null;
      status = {
        enabled: false,
        path: dbPath,
        savedItems: 0,
        error: `${error.code || "SQLITE_ERROR"}: ${error.message}`,
      };
      return null;
    }
  }

  function persistIndex(index) {
    if (!enabled) return;

    const nextDbPath = `${dbPath}.next`;
    const backupDbPath = `${dbPath}.bak`;
    let database = null;
    let txActive = false;
    try {
      removeSqliteArtifacts(nextDbPath);
      removeSqliteArtifacts(backupDbPath);
      database = openDatabase(nextDbPath, { resetOnSchemaMismatch: true });

      const insert = database.prepare(`
        INSERT OR REPLACE INTO items (
          id, sort_id_core, source, source_memberships_json, kind, date, date_sort_ms, card_sort_ms, prompt, gen_id, generation_id, task_id, post_id,
          poster_username, cameo_count, owner_usernames_json, cameo_owner_usernames_json, searchable_usernames_json,
          duration, duration_sort, ratio, width, height, like_count, view_count,
          is_liked, has_local_media, has_local_text, thumb_url, preview_url, download_url,
          local_media_path, local_txt_path, search_text, detail_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `);
      const insertFts = database.prepare(`
        INSERT INTO items_fts (id, search_text) VALUES (?, ?)
      `);
      const setMeta = database.prepare(`
        INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)
      `);
      const setScanState = database.prepare(`
        INSERT OR REPLACE INTO scan_state (key, value) VALUES (?, ?)
      `);
      const insertManifestInventory = database.prepare(`
        INSERT OR REPLACE INTO manifest_inventory (
          manifest_path, size, mtime_ms, exported_at, exported_at_ms, total_items,
          scan_sources_json, content_hash, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertManifestItem = database.prepare(`
        INSERT OR REPLACE INTO manifest_items (
          manifest_path, item_ordinal, dedupe_key, item_id, source, manifest_source,
          source_memberships_json, manifest_sources_json, gen_id, generation_id,
          task_id, post_id, date, updated_at, posted_at, created_at, sort_timestamp_ms,
          prompt, width, height, ratio, duration, like_count, view_count, poster_username,
          profile_user_id, poster_display_name, poster_description, owner_username,
          owner_usernames_json, cameo_owner_usernames_json, cameo_profiles_json, searchable_usernames_json, is_liked,
          preview_url, download_url, thumb_url, permalink, id_tokens_json,
          manifest_search_text, payload_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?
        )
      `);
      const insertSourceInventory = database.prepare(`
        INSERT OR REPLACE INTO source_inventory (
          source, root_path, root_realpath, platform, dir_mtime_ms,
          file_count, group_count, inventory_hash, last_scan_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFileInventory = database.prepare(`
        INSERT OR REPLACE INTO file_inventory (
          file_path, source, stem, ext, size, mtime_ms, ctime_ms, parent_dir,
          real_path_key, file_id, exists_flag, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertTxtParseCache = database.prepare(`
        INSERT OR REPLACE INTO txt_parse_cache (
          txt_path, size, mtime_ms, encoding, declared_source, generation_id, task_id,
          post_id, date, duration, resolution, aspect_ratio, liked, author_username,
          author_display_name, cameo_usernames_json, prompt, id_tokens_json, parsed_json, cache_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertGroupInventory = database.prepare(`
        INSERT OR REPLACE INTO group_inventory (
          group_key, source, stem, media_path, txt_path, group_mtime_ms, group_hash,
          declared_source, effective_source, generation_id, task_id, post_id, date, duration,
          resolution, aspect_ratio, liked, author_username, author_display_name,
          cameo_usernames_json, prompt, id_tokens_json, local_attachment_json, last_built_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMatchInventory = database.prepare(`
        INSERT OR REPLACE INTO match_inventory (
          entry_id, group_key, match_score, reason, matched_at
        ) VALUES (?, ?, ?, ?, ?)
      `);

      database.exec("BEGIN");
      txActive = true;
      database.exec("DELETE FROM items");
      database.exec("DELETE FROM items_fts");
      database.exec("DELETE FROM manifest_inventory");
      database.exec("DELETE FROM manifest_items");
      database.exec("DELETE FROM source_inventory");
      database.exec("DELETE FROM file_inventory");
      database.exec("DELETE FROM txt_parse_cache");
      database.exec("DELETE FROM group_inventory");
      database.exec("DELETE FROM match_inventory");
      database.exec("DELETE FROM scan_state");

      for (const item of index.items) {
        const { searchText, dateSortMs, ...detailItem } = item;
        insert.run(
          item.id,
          item.sortIdCore || "",
          item.source,
          JSON.stringify(item.sourceMemberships || [item.source].filter(Boolean)),
          item.kind,
          item.date,
          item.dateSortMs,
          item.cardSortMs,
          item.prompt,
          item.genId,
          item.generationId,
          item.taskId,
          item.postId,
          item.posterUsername || null,
          Number(item.cameoCount || 0),
          JSON.stringify(item.ownerUsernames || []),
          JSON.stringify(item.cameoOwnerUsernames || []),
          JSON.stringify(item.searchableUsernames || []),
          item.duration == null ? null : String(item.duration),
          sortableDuration(item.duration),
          item.ratio,
          item.width,
          item.height,
          typeof item.likeCount === "number" ? item.likeCount : null,
          typeof item.viewCount === "number" ? item.viewCount : null,
          item.isLiked ? 1 : 0,
          item.hasLocalMedia ? 1 : 0,
          item.hasLocalText ? 1 : 0,
          item.thumbUrl,
          item.previewUrl,
          item.downloadUrl,
          item.local?.mediaPath || null,
          item.local?.txtPath || null,
          item.searchText,
          JSON.stringify(detailItem),
        );
        insertFts.run(item.id, item.searchText);
      }

      setMeta.run("builtAt", index.builtAt);
      setMeta.run("totalItems", String(index.stats.totalItems));
      setMeta.run("dbPath", dbPath);
      setMeta.run("statsJson", JSON.stringify(index.stats));
      setScanState.run("lastBuildAt", index.builtAt);
      setScanState.run("inventoryVersion", schemaVersion);

      for (const manifest of index.inventories?.manifestInventory || []) {
        insertManifestInventory.run(
          manifest.manifestPath,
          manifest.size,
          manifest.mtimeMs,
          manifest.exportedAt,
          manifest.exportedAtMs,
          manifest.totalItems,
          manifest.scanSourcesJson,
          manifest.contentHash,
          manifest.lastSeenAt,
        );
      }

      for (const manifestItem of index.inventories?.manifestItems || []) {
        insertManifestItem.run(
          manifestItem.manifestPath,
          manifestItem.itemOrdinal,
          manifestItem.dedupeKey,
          manifestItem.itemId,
          manifestItem.source,
          manifestItem.manifestSource,
          manifestItem.sourceMembershipsJson,
          manifestItem.manifestSourcesJson,
          manifestItem.genId,
          manifestItem.generationId,
          manifestItem.taskId,
          manifestItem.postId,
          manifestItem.date,
          manifestItem.updatedAt,
          manifestItem.postedAt,
          manifestItem.createdAt,
          manifestItem.sortTimestampMs,
          manifestItem.prompt,
          manifestItem.width,
          manifestItem.height,
          manifestItem.ratio,
          manifestItem.duration,
          manifestItem.likeCount,
          manifestItem.viewCount,
          manifestItem.posterUsername,
          manifestItem.profileUserId,
          manifestItem.posterDisplayName,
          manifestItem.posterDescription,
          manifestItem.ownerUsername,
          manifestItem.ownerUsernamesJson,
          manifestItem.cameoOwnerUsernamesJson,
          manifestItem.cameoProfilesJson,
          manifestItem.searchableUsernamesJson,
          manifestItem.isLiked,
          manifestItem.previewUrl,
          manifestItem.downloadUrl,
          manifestItem.thumbUrl,
          manifestItem.permalink,
          manifestItem.idTokensJson,
          manifestItem.manifestSearchText,
          manifestItem.payloadJson,
        );
      }

      for (const source of index.inventories?.sourceInventory || []) {
        insertSourceInventory.run(
          source.source,
          source.rootPath,
          source.rootRealPath,
          source.platform,
          source.dirMtimeMs,
          source.fileCount,
          source.groupCount,
          source.inventoryHash,
          source.lastScanAt,
        );
      }

      for (const file of index.inventories?.fileInventory || []) {
        insertFileInventory.run(
          file.filePath,
          file.source,
          file.stem,
          file.ext,
          file.size,
          file.mtimeMs,
          file.ctimeMs,
          file.parentDir,
          file.realPathKey,
          file.fileId,
          file.existsFlag,
          file.lastSeenAt,
        );
      }

      for (const txt of index.inventories?.txtParseCache || []) {
        insertTxtParseCache.run(
          txt.txtPath,
          txt.size,
          txt.mtimeMs,
          txt.encoding,
          txt.declaredSource,
          txt.generationId,
          txt.taskId,
          txt.postId,
          txt.date,
          txt.duration,
          txt.resolution,
          txt.aspectRatio,
          txt.liked,
          txt.authorUsername,
          txt.authorDisplayName,
          txt.cameoUsernamesJson,
          txt.prompt,
          txt.idTokensJson,
          txt.parsedJson,
          txt.cacheVersion,
        );
      }

      for (const group of index.inventories?.groupInventory || []) {
        insertGroupInventory.run(
          group.groupKey,
          group.source,
          group.stem,
          group.mediaPath,
          group.txtPath,
          group.groupMtimeMs,
          group.groupHash,
          group.declaredSource,
          group.effectiveSource,
          group.generationId,
          group.taskId,
          group.postId,
          group.date,
          group.duration,
          group.resolution,
          group.aspectRatio,
          group.liked,
          group.authorUsername,
          group.authorDisplayName,
          group.cameoUsernamesJson,
          group.prompt,
          group.idTokensJson,
          group.localAttachmentJson,
          group.lastBuiltAt,
        );
      }

      for (const match of index.inventories?.matchInventory || []) {
        insertMatchInventory.run(
          match.entryId,
          match.groupKey,
          match.matchScore,
          match.reason,
          match.matchedAt,
        );
      }

      database.exec("COMMIT");
      txActive = false;
      closeDatabase(database);
      database = null;

      resetLiveDatabaseHandle();
      if (fs.existsSync(dbPath)) {
        removeSqliteArtifacts(backupDbPath);
        fs.renameSync(dbPath, backupDbPath);
      }
      fs.renameSync(nextDbPath, dbPath);
      removeSqliteArtifacts(backupDbPath);

      status = {
        enabled: true,
        path: dbPath,
        savedItems: index.items.length,
        error: null,
      };
    } catch (error) {
      if (txActive) {
        try {
          database.exec("ROLLBACK");
        } catch {}
      }
      closeDatabase(database);
      removeSqliteArtifacts(nextDbPath);

      status = {
        enabled: false,
        path: dbPath,
        savedItems: 0,
        error: `${error.code || "SQLITE_ERROR"}: ${error.message}`,
      };
    }
  }

  function loadIndexMeta() {
    const database = getDb();
    if (!database) return null;

    const metaRows = database.prepare("SELECT key, value FROM cache_meta").all();
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const builtAt = meta.get("builtAt") || null;
    const stats = parseJson(meta.get("statsJson"), null);
    if (!builtAt || !stats) return null;

    const countRow = database.prepare("SELECT COUNT(*) AS count FROM items").get();
    status = {
      enabled: true,
      path: dbPath,
      savedItems: Number(countRow?.count || 0),
      error: null,
    };

    return {
      builtAt,
      stats: {
        ...stats,
        database: getStatus(),
      },
    };
  }

  function queryItems({ joins, whereClause, orderBy, values, limit, offset, extraSelect = "" }) {
    const database = getDb();
    if (!database) return null;

    const fromClause = `FROM items ${joins.join(" ")}`;
    const countSql = `SELECT COUNT(*) AS count ${fromClause} ${whereClause}`;
    const total = Number(database.prepare(countSql).get(...values)?.count || 0);
    const safeOffset = total === 0 ? 0 : Math.min(offset, Math.floor((total - 1) / limit) * limit);

    const dataSql = `
      SELECT
        items.id,
        items.kind,
        items.source,
        items.source_memberships_json AS sourceMembershipsJson,
        items.date,
        items.prompt,
        items.gen_id AS genId,
        items.generation_id AS generationId,
        items.task_id AS taskId,
        items.post_id AS postId,
        items.duration,
        items.ratio,
        items.width,
        items.height,
        items.like_count AS likeCount,
        items.view_count AS viewCount,
        items.poster_username AS posterUsername,
        items.cameo_count AS cameoCount,
        items.cameo_owner_usernames_json AS cameoOwnerUsernamesJson,
        items.is_liked AS isLiked,
        items.preview_url AS previewUrl,
        items.download_url AS downloadUrl,
        items.thumb_url AS thumbUrl,
        items.has_local_media AS hasLocalMedia,
        items.has_local_text AS hasLocalText
        ${extraSelect}
      ${fromClause}
      ${whereClause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const rows = database.prepare(dataSql).all(...values, limit, safeOffset);
    return {
      rows,
      pagination: {
        total,
        limit,
        offset: safeOffset,
        page: total === 0 ? 0 : Math.floor(safeOffset / limit) + 1,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        hasPrevious: safeOffset > 0,
        hasNext: safeOffset + limit < total,
      },
    };
  }

  function queryPosterUsernames({ joins, whereClause, values, orderBy }) {
    const database = getDb();
    if (!database) return null;

    const fromClause = `FROM items ${joins.join(" ")}`;
    const sql = `
      SELECT
        items.poster_username AS posterUsername,
        COUNT(*) AS postCount,
        MAX(COALESCE(items.date_sort_ms, -9223372036854775808)) AS latestPostDateSortMs,
        SUM(COALESCE(items.like_count, 0)) AS totalLikeCount
      ${fromClause}
      ${whereClause}
      AND COALESCE(items.poster_username, '') <> ''
      GROUP BY items.poster_username
      ${orderBy}
    `;

    return database.prepare(sql).all(...values);
  }

  function queryItemIdentifiers({ joins, whereClause, values, orderBy, field }) {
    const database = getDb();
    if (!database) return null;

    const column = (() => {
      switch (field) {
        case "postId":
          return "items.post_id";
        case "taskId":
          return "items.task_id";
        case "genId":
        default:
          return "items.gen_id";
      }
    })();

    const fromClause = `FROM items ${joins.join(" ")}`;
    const sql = `
      SELECT ${column} AS identifier
      ${fromClause}
      ${whereClause}
      ${whereClause ? "AND" : "WHERE"} COALESCE(${column}, '') <> ''
      ${orderBy}
    `;

    return database.prepare(sql).all(...values).map((row) => String(row.identifier || "").trim()).filter(Boolean);
  }

  function getItemDetail(id) {
    const database = getDb();
    if (!database) return null;

    const row = database.prepare("SELECT detail_json FROM items WHERE id = ?").get(id);
    return row ? parseJson(row.detail_json, null) : null;
  }

  function getLocalFile(id, kind) {
    const database = getDb();
    if (!database) return null;

    const row = database
      .prepare("SELECT local_media_path AS mediaPath, local_txt_path AS txtPath FROM items WHERE id = ?")
      .get(id);
    if (!row) return null;
    if (kind === "media") return row.mediaPath || null;
    if (kind === "txt") return row.txtPath || null;
    return null;
  }

  return {
    clearPersistedCache,
    getStatus,
    getDb,
    persistIndex,
    loadIndexMeta,
    queryItems,
    queryItemIdentifiers,
    queryPosterUsernames,
    getItemDetail,
    getLocalFile,
  };
}

module.exports = {
  createStore,
};
