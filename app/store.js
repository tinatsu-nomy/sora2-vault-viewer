const fs = require("fs");

const { parseJson, sortableDuration } = require("./indexer");

function createStore({ enabled, dbPath, appDataDir, schemaVersion }) {
  let db = null;
  let DatabaseSync = null;
  let status = {
    enabled: false,
    path: dbPath,
    savedItems: 0,
    error: enabled ? null : "disabled by default",
  };

  function getStatus() {
    return { ...status };
  }

  function getDb() {
    if (!enabled) return null;
    if (db) return db;

    fs.mkdirSync(appDataDir, { recursive: true });

    try {
      if (!DatabaseSync) {
        ({ DatabaseSync } = require("node:sqlite"));
      }

      db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS cache_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      const currentSchemaVersion = db.prepare("SELECT value FROM cache_meta WHERE key = ?").get("schemaVersion")?.value || null;
      if (currentSchemaVersion !== schemaVersion) {
        db.exec(`
          DELETE FROM cache_meta;
          DROP TABLE IF EXISTS items;
          DROP TABLE IF EXISTS items_fts;
        `);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          source TEXT,
          kind TEXT,
          date TEXT,
          date_sort_ms INTEGER,
          prompt TEXT,
          gen_id TEXT,
          generation_id TEXT,
          task_id TEXT,
          post_id TEXT,
          poster_username TEXT,
          owner_usernames_json TEXT NOT NULL,
          cameo_owner_usernames_json TEXT NOT NULL,
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
      `);

      db.prepare(`
        INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)
      `).run("schemaVersion", schemaVersion);

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
    const database = getDb();
    if (!database) return;

    let txActive = false;
    try {
      const insert = database.prepare(`
        INSERT OR REPLACE INTO items (
          id, source, kind, date, date_sort_ms, prompt, gen_id, generation_id, task_id, post_id,
          poster_username, owner_usernames_json, cameo_owner_usernames_json,
          duration, duration_sort, ratio, width, height, like_count, view_count,
          is_liked, has_local_media, has_local_text, thumb_url, preview_url, download_url,
          local_media_path, local_txt_path, search_text, detail_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
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

      database.exec("BEGIN");
      txActive = true;
      database.exec("DELETE FROM items");
      database.exec("DELETE FROM items_fts");

      for (const item of index.items) {
        insert.run(
          item.id,
          item.source,
          item.kind,
          item.date,
          item.dateSortMs,
          item.prompt,
          item.genId,
          item.generationId,
          item.taskId,
          item.postId,
          item.posterUsername || null,
          JSON.stringify(item.ownerUsernames || []),
          JSON.stringify(item.cameoOwnerUsernames || []),
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
          JSON.stringify(item),
        );
        insertFts.run(item.id, item.searchText);
      }

      setMeta.run("builtAt", index.builtAt);
      setMeta.run("totalItems", String(index.stats.totalItems));
      setMeta.run("dbPath", dbPath);
      setMeta.run("statsJson", JSON.stringify(index.stats));
      database.exec("COMMIT");
      txActive = false;

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

  function queryItems({ joins, whereClause, orderBy, values, limit, offset }) {
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
        items.cameo_owner_usernames_json AS cameoOwnerUsernamesJson,
        items.is_liked AS isLiked,
        items.preview_url AS previewUrl,
        items.download_url AS downloadUrl,
        items.thumb_url AS thumbUrl,
        items.has_local_media AS hasLocalMedia,
        items.has_local_text AS hasLocalText
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
    getStatus,
    getDb,
    persistIndex,
    loadIndexMeta,
    queryItems,
    getItemDetail,
    getLocalFile,
  };
}

module.exports = {
  createStore,
};
