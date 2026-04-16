const { parseJson, slugForText } = require("../indexer");
const { buildFtsMatchQuery, escapeLikePattern, parseListParams } = require("./query");

function createListingService({
  sourceOrder,
  store,
  serializeListItem,
  serializeListRow,
}) {
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

  function listItemsFromDb(params) {
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
      where.push(`items.source IN (${params.sources.map(() => "?").join(", ")})`);
      values.push(...params.sources);
    } else if (params.source && params.source !== "all") {
      where.push("items.source = ?");
      values.push(params.source);
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
          return `
            ORDER BY CASE items.source
              WHEN 'v2_profile' THEN 0
              WHEN 'v2_liked' THEN 1
              WHEN 'v2_drafts' THEN 2
              ELSE 9
            END ASC,
            COALESCE(items.date_sort_ms, -9223372036854775808) ASC,
            items.id ASC
          `;
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
    const dbListing = listItemsFromDb(params);
    if (dbListing) return dbListing;

    let filtered = index.items;
    if (params.query) filtered = filtered.filter((item) => item.searchText.includes(params.query));
    if (params.usernamePrefixes.length) {
      filtered = filtered.filter((item) => itemMatchesUsernamePrefixes(item, params.usernamePrefixes));
    }
    if (params.hasSourcesParam) {
      const allowedSources = new Set(params.sources);
      filtered = filtered.filter((item) => allowedSources.has(item.source));
    } else if (params.source && params.source !== "all") {
      filtered = filtered.filter((item) => item.source === params.source);
    }
    if (params.localOnly) filtered = filtered.filter((item) => item.hasLocalMedia || item.hasLocalText);
    if (params.withText) filtered = filtered.filter((item) => item.hasLocalText);
    if (params.withMedia) filtered = filtered.filter((item) => item.hasLocalMedia);
    if (params.dateFrom != null) filtered = filtered.filter((item) => item.dateSortMs != null && item.dateSortMs >= params.dateFrom);
    if (params.dateTo != null) filtered = filtered.filter((item) => item.dateSortMs != null && item.dateSortMs <= params.dateTo);

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
          const sourceIndex = sourceOrder.indexOf(left.source) - sourceOrder.indexOf(right.source);
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

  function itemDetails(index, itemId) {
    const dbItem = store.getItemDetail(itemId);
    if (dbItem) return dbItem;
    return index.items.find((item) => item.id === itemId) || null;
  }

  function localFileForRequest(index, itemId, kind) {
    const dbFile = store.getLocalFile(itemId, kind);
    if (dbFile) return dbFile;

    const item = index.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    if (kind === "media") return item.local?.mediaPath || null;
    if (kind === "txt") return item.local?.txtPath || null;
    return null;
  }

  return {
    itemDetails,
    listItems,
    localFileForRequest,
  };
}

module.exports = {
  createListingService,
};
