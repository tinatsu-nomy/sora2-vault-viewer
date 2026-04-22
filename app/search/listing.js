const { parseJson, slugForText } = require("../indexer");
const { compareSourceKeys } = require("../indexing/common");
const { buildFtsMatchQuery, escapeLikePattern, parseListParams } = require("./query");

function createListingService({
  sourceOrder,
  store,
  serializeListItem,
  serializeListRow,
}) {
  function compareSourceMembershipKeys(left, right, activeSourceOrder) {
    const leftIndex = activeSourceOrder.indexOf(left);
    const rightIndex = activeSourceOrder.indexOf(right);
    if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) return leftIndex - rightIndex;
    if (leftIndex >= 0 && rightIndex < 0) return -1;
    if (leftIndex < 0 && rightIndex >= 0) return 1;
    return compareSourceKeys(left, right);
  }

  function sourceOrderByClause(activeSourceOrder) {
    const knownSources = activeSourceOrder.filter(Boolean);
    if (!knownSources.length) {
      return "ORDER BY items.source COLLATE NOCASE ASC, COALESCE(items.date_sort_ms, -9223372036854775808) ASC, items.id ASC";
    }

    const cases = knownSources
      .map((source, index) => `WHEN '${source.replace(/'/g, "''")}' THEN ${index}`)
      .join("\n              ");

    return `
      ORDER BY CASE items.source
              ${cases}
              ELSE ${knownSources.length}
            END ASC,
            COALESCE(items.date_sort_ms, -9223372036854775808) ASC,
            items.id ASC
    `;
  }

  function sourceMembershipPattern(source) {
    return `%\"${escapeLikePattern(source)}\"%`;
  }

  function itemSourceMemberships(item) {
    return item?.sourceMemberships?.length ? item.sourceMemberships : [item?.source].filter(Boolean);
  }

  function usernamePrefixLikePattern(prefix) {
    return `${escapeLikePattern(prefix)}%`;
  }

  function usernameJsonPrefixLikePattern(prefix) {
    return `%\"${escapeLikePattern(prefix)}%`;
  }

  function itemMatchesUsernamePrefixes(item, prefixes) {
    if (!prefixes?.length) return true;
    const usernames = new Set(
      [
        item?.posterUsername,
        ...(item?.ownerUsernames || []),
        ...(item?.cameoOwnerUsernames || []),
      ]
        .filter(Boolean)
        .map((value) => slugForText(value)),
    );

    return prefixes.every((prefix) => {
      for (const username of usernames) {
        if (username.startsWith(prefix)) return true;
      }
      return false;
    });
  }

  function buildListingQueryParts(params) {
    const joins = [];
    const where = [];
    const values = [];

    if (params.query) {
      const ftsQuery = params.forceSimpleTextSearch ? null : buildFtsMatchQuery(params.query);
      if (ftsQuery) {
        joins.push("JOIN items_fts ON items_fts.id = items.id");
        where.push("items_fts MATCH ?");
        values.push(ftsQuery);
      } else {
        where.push("items.search_text LIKE ? ESCAPE '\\'");
        values.push(`%${escapeLikePattern(params.query)}%`);
      }
    }

    for (const prefix of params.usernamePrefixes) {
      where.push(`(
        LOWER(COALESCE(items.poster_username, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(items.owner_usernames_json, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(items.cameo_owner_usernames_json, '')) LIKE ? ESCAPE '\\'
      )`);
      values.push(
        usernamePrefixLikePattern(prefix),
        usernameJsonPrefixLikePattern(prefix),
        usernameJsonPrefixLikePattern(prefix),
      );
    }

    if (params.hasSourcesParam) {
      if (!params.sources.length) {
        return { isEmpty: true, joins, where, values };
      }
      where.push(`(${params.sources.map(() => "items.source = ? OR items.source_memberships_json LIKE ? ESCAPE '\\'").join(" OR ")})`);
      for (const source of params.sources) {
        values.push(source, sourceMembershipPattern(source));
      }
    } else if (params.source && params.source !== "all") {
      where.push("(items.source = ? OR items.source_memberships_json LIKE ? ESCAPE '\\')");
      values.push(params.source, sourceMembershipPattern(params.source));
    }

    if (params.localOnly) where.push("(items.has_local_media = 1 OR items.has_local_text = 1)");
    if (params.withText) where.push("items.has_local_text = 1");
    if (params.withMedia) where.push("items.has_local_media = 1");
    if (params.dateFrom != null) {
      where.push("items.date_sort_ms IS NOT NULL AND items.date_sort_ms >= ?");
      values.push(params.dateFrom);
    }
    if (params.dateTo != null) {
      where.push("items.date_sort_ms IS NOT NULL AND items.date_sort_ms <= ?");
      values.push(params.dateTo);
    }

    return { isEmpty: false, joins, where, values };
  }

  function filteredItems(index, params) {
    let filtered = Array.isArray(index?.items) ? index.items : [];
    if (params.query) filtered = filtered.filter((item) => item.searchText.includes(params.query));
    if (params.usernamePrefixes.length) {
      filtered = filtered.filter((item) => itemMatchesUsernamePrefixes(item, params.usernamePrefixes));
    }
    if (params.hasSourcesParam) {
      const allowedSources = new Set(params.sources);
      filtered = filtered.filter((item) => itemSourceMemberships(item).some((source) => allowedSources.has(source)));
    } else if (params.source && params.source !== "all") {
      filtered = filtered.filter((item) => itemSourceMemberships(item).includes(params.source));
    }
    if (params.localOnly) filtered = filtered.filter((item) => item.hasLocalMedia || item.hasLocalText);
    if (params.withText) filtered = filtered.filter((item) => item.hasLocalText);
    if (params.withMedia) filtered = filtered.filter((item) => item.hasLocalMedia);
    if (params.dateFrom != null) filtered = filtered.filter((item) => item.dateSortMs != null && item.dateSortMs >= params.dateFrom);
    if (params.dateTo != null) filtered = filtered.filter((item) => item.dateSortMs != null && item.dateSortMs <= params.dateTo);
    return filtered;
  }

  function sortPosterRows(rows, sort) {
    const normalizedSort = String(sort || "name-asc");
    const sorted = [...rows];
    sorted.sort((left, right) => {
      const leftName = String(left.posterUsername || "");
      const rightName = String(right.posterUsername || "");
      const leftCount = Number(left.postCount || 0);
      const rightCount = Number(right.postCount || 0);
      const leftLatest = Number(left.latestPostDateSortMs ?? Number.MIN_SAFE_INTEGER);
      const rightLatest = Number(right.latestPostDateSortMs ?? Number.MIN_SAFE_INTEGER);
      const leftLikes = Number(left.totalLikeCount || 0);
      const rightLikes = Number(right.totalLikeCount || 0);

      switch (normalizedSort) {
        case "name-desc":
          return rightName.localeCompare(leftName, "ja");
        case "likes-desc":
          return rightLikes - leftLikes || leftName.localeCompare(rightName, "ja");
        case "likes-asc":
          return leftLikes - rightLikes || leftName.localeCompare(rightName, "ja");
        case "recent-post-desc":
          return rightLatest - leftLatest || leftName.localeCompare(rightName, "ja");
        case "recent-post-asc":
          return leftLatest - rightLatest || leftName.localeCompare(rightName, "ja");
        case "posts-desc":
          return rightCount - leftCount || leftName.localeCompare(rightName, "ja");
        case "posts-asc":
          return leftCount - rightCount || leftName.localeCompare(rightName, "ja");
        case "name-asc":
        default:
          return leftName.localeCompare(rightName, "ja");
      }
    });
    return sorted;
  }

  function listItemsFromDb(params, activeSourceOrder) {
    const queryParts = buildListingQueryParts(params);
    if (queryParts.isEmpty) {
        return {
          items: [],
          pagination: {
            total: 0,
            limit: params.limit,
            offset: 0,
            page: 0,
            totalPages: 0,
            hasPrevious: false,
            hasNext: false,
          },
        };
    }

    const { joins, where, values } = queryParts;
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderBy = (() => {
      switch (params.sort) {
        case "date-asc":
          return "ORDER BY COALESCE(items.date_sort_ms, -9223372036854775808) ASC, items.id ASC";
        case "views-desc":
          return "ORDER BY COALESCE(items.view_count, 0) DESC, COALESCE(items.date_sort_ms, -9223372036854775808) DESC, items.id DESC";
        case "views-asc":
          return "ORDER BY COALESCE(items.view_count, 0) ASC, COALESCE(items.date_sort_ms, -9223372036854775808) ASC, items.id ASC";
        case "likes-desc":
          return "ORDER BY COALESCE(items.like_count, 0) DESC, COALESCE(items.date_sort_ms, -9223372036854775808) DESC, items.id DESC";
        case "likes-asc":
          return "ORDER BY COALESCE(items.like_count, 0) ASC, COALESCE(items.date_sort_ms, -9223372036854775808) ASC, items.id ASC";
        case "prompt-asc":
          return "ORDER BY COALESCE(items.prompt, '') COLLATE NOCASE ASC, items.id ASC";
        case "prompt-desc":
          return "ORDER BY COALESCE(items.prompt, '') COLLATE NOCASE DESC, items.id DESC";
        case "duration-asc":
          return "ORDER BY COALESCE(items.duration_sort, 0) ASC, items.id ASC";
        case "duration-desc":
          return "ORDER BY COALESCE(items.duration_sort, 0) DESC, items.id DESC";
        case "source-asc":
          return sourceOrderByClause(activeSourceOrder);
        case "date-desc":
        default:
          return "ORDER BY COALESCE(items.date_sort_ms, -9223372036854775808) DESC, items.id DESC";
      }
    })();

    const queryResult = store.queryItems({
      joins,
      whereClause,
      orderBy,
      values,
      limit: params.limit,
      offset: params.offset,
    });
    if (!queryResult) return null;

    return {
      items: queryResult.rows.map(serializeListRow),
      pagination: queryResult.pagination,
    };
  }

  function listItems(index, url) {
    const params = parseListParams(url);
    const activeSourceOrder = Array.isArray(index?.stats?.sourceOrder) && index.stats.sourceOrder.length
      ? index.stats.sourceOrder
      : sourceOrder;
    const dbListing = listItemsFromDb(params, activeSourceOrder);
    if (dbListing) return dbListing;

    let filtered = filteredItems(index, params);

    const sorted = [...filtered];
    sorted.sort((left, right) => {
      const leftPrompt = left.prompt || "";
      const rightPrompt = right.prompt || "";
      const leftViews = Number(left.viewCount || 0);
      const rightViews = Number(right.viewCount || 0);
      const leftLikes = Number(left.likeCount || 0);
      const rightLikes = Number(right.likeCount || 0);
      switch (params.sort) {
        case "date-asc":
          return (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
        case "views-desc":
          return rightViews - leftViews || (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) || right.id.localeCompare(left.id);
        case "views-asc":
          return leftViews - rightViews || (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
        case "likes-desc":
          return rightLikes - leftLikes || (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) || right.id.localeCompare(left.id);
        case "likes-asc":
          return leftLikes - rightLikes || (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
        case "prompt-asc":
          return leftPrompt.localeCompare(rightPrompt, "ja");
        case "prompt-desc":
          return rightPrompt.localeCompare(leftPrompt, "ja");
        case "duration-asc":
          return Number(left.duration || 0) - Number(right.duration || 0);
        case "duration-desc":
          return Number(right.duration || 0) - Number(left.duration || 0);
        case "source-asc": {
          const sourceIndex = compareSourceMembershipKeys(left.source, right.source, activeSourceOrder);
          if (sourceIndex !== 0) return sourceIndex;
          return (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) || left.id.localeCompare(right.id);
        }
        case "date-desc":
        default:
          return (right.dateSortMs ?? Number.MIN_SAFE_INTEGER) - (left.dateSortMs ?? Number.MIN_SAFE_INTEGER) || right.id.localeCompare(left.id);
      }
    });

    const total = sorted.length;
    const safeOffset = total === 0 ? 0 : Math.min(params.offset, Math.floor((total - 1) / params.limit) * params.limit);
    const items = sorted.slice(safeOffset, safeOffset + params.limit).map(serializeListItem);

    return {
      items,
      pagination: {
        total,
        limit: params.limit,
        offset: safeOffset,
        page: total === 0 ? 0 : Math.floor(safeOffset / params.limit) + 1,
        totalPages: total === 0 ? 0 : Math.ceil(total / params.limit),
        hasPrevious: safeOffset > 0,
        hasNext: safeOffset + params.limit < total,
      },
    };
  }

  function listPosterUsernames(index, url) {
    const params = parseListParams(url);
    const posterSort = url.searchParams.get("posterSort") || "name-asc";
    const queryParts = buildListingQueryParts(params);
    if (queryParts.isEmpty) return [];

    const dbRows = store.queryPosterUsernames({
      joins: queryParts.joins,
      whereClause: queryParts.where.length ? `WHERE ${queryParts.where.join(" AND ")}` : "WHERE 1 = 1",
      values: queryParts.values,
      orderBy: (() => {
        switch (posterSort) {
          case "name-desc":
            return "ORDER BY items.poster_username COLLATE NOCASE DESC";
          case "likes-desc":
            return "ORDER BY totalLikeCount DESC, items.poster_username COLLATE NOCASE ASC";
          case "likes-asc":
            return "ORDER BY totalLikeCount ASC, items.poster_username COLLATE NOCASE ASC";
          case "recent-post-desc":
            return "ORDER BY latestPostDateSortMs DESC, items.poster_username COLLATE NOCASE ASC";
          case "recent-post-asc":
            return "ORDER BY latestPostDateSortMs ASC, items.poster_username COLLATE NOCASE ASC";
          case "posts-desc":
            return "ORDER BY postCount DESC, items.poster_username COLLATE NOCASE ASC";
          case "posts-asc":
            return "ORDER BY postCount ASC, items.poster_username COLLATE NOCASE ASC";
          case "name-asc":
          default:
            return "ORDER BY items.poster_username COLLATE NOCASE ASC";
        }
      })(),
    });
    if (dbRows) {
      return sortPosterRows(dbRows, posterSort)
        .map((row) => String(row.posterUsername || "").trim())
        .filter(Boolean);
    }

    const filtered = filteredItems(index, params);
    const posterRowsByUsername = new Map();

    for (const item of filtered) {
      const posterUsername = String(item.posterUsername || "").trim();
      if (!posterUsername) continue;
      if (!posterRowsByUsername.has(posterUsername)) {
        posterRowsByUsername.set(posterUsername, {
          posterUsername,
          postCount: 0,
          latestPostDateSortMs: Number.MIN_SAFE_INTEGER,
          totalLikeCount: 0,
        });
      }
      const row = posterRowsByUsername.get(posterUsername);
      row.postCount += 1;
      row.latestPostDateSortMs = Math.max(
        row.latestPostDateSortMs,
        Number(item.dateSortMs ?? Number.MIN_SAFE_INTEGER),
      );
      row.totalLikeCount += Number(item.likeCount || 0);
    }

    return sortPosterRows([...posterRowsByUsername.values()], posterSort)
      .map((row) => row.posterUsername);
  }

  function itemDetails(index, itemId) {
    const dbItem = store.getItemDetail(itemId);
    if (dbItem) return dbItem;
    return (Array.isArray(index?.items) ? index.items : []).find((item) => item.id === itemId) || null;
  }

  function localFileForRequest(index, itemId, kind) {
    const dbFile = store.getLocalFile(itemId, kind);
    if (dbFile) return dbFile;

    const item = (Array.isArray(index?.items) ? index.items : []).find((entry) => entry.id === itemId);
    if (!item) return null;
    if (kind === "media") return item.local?.mediaPath || null;
    if (kind === "txt") return item.local?.txtPath || null;
    return null;
  }

  return {
    itemDetails,
    listItems,
    listPosterUsernames,
    localFileForRequest,
  };
}

module.exports = {
  createListingService,
};
