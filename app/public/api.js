(() => {
const viewer = window.SoraViewer = window.SoraViewer || {};
const { state } = viewer;

function pageQueryStringForOffset(offset) {
  const params = new URLSearchParams();
  if (state.filters.query) params.set("query", state.filters.query);
  if (state.filters.sources.length !== viewer.SOURCE_ORDER.length) params.set("sources", state.filters.sources.join(","));
  if (state.filters.sort) params.set("sort", state.filters.sort);
  if (state.filters.dateFrom) params.set("dateFrom", state.filters.dateFrom);
  if (state.filters.dateTo) params.set("dateTo", state.filters.dateTo);
  if (state.filters.localOnly) params.set("localOnly", "1");
  if (state.filters.withText) params.set("withText", "1");
  if (state.filters.withMedia) params.set("withMedia", "1");
  params.set("limit", String(state.pagination.limit));
  params.set("offset", String(Math.max(0, offset)));
  return params.toString();
}

function buildQueryString() {
  const params = new URLSearchParams();
  if (state.filters.query) params.set("query", state.filters.query);
  if (state.filters.sources.length !== viewer.SOURCE_ORDER.length) params.set("sources", state.filters.sources.join(","));
  if (state.filters.sort) params.set("sort", state.filters.sort);
  if (state.filters.dateFrom) params.set("dateFrom", state.filters.dateFrom);
  if (state.filters.dateTo) params.set("dateTo", state.filters.dateTo);
  if (state.filters.localOnly) params.set("localOnly", "1");
  if (state.filters.withText) params.set("withText", "1");
  if (state.filters.withMedia) params.set("withMedia", "1");
  params.set("limit", String(state.pagination.limit));
  params.set("offset", String(state.pagination.offset));
  return params.toString();
}

function currentPageQueryString() {
  return buildQueryString();
}

function applyIndexPayload(payload) {
  viewer.setAvailableSources(payload.stats?.sourceOrder || payload.stats?.sources || []);
  state.builtAt = payload.builtAt || null;
  state.indexStatus = payload.indexStatus || {
    isRefreshing: false,
    isStale: false,
    refreshError: null,
  };
  state.items = payload.items;
  state.stats = payload.stats;
  state.pagination = payload.pagination || {
    total: payload.items.length,
    limit: state.pagination.limit,
    offset: 0,
    page: 1,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  };
  viewer.renderSourceNav();
  viewer.renderIndexStatus();
  viewer.renderStats();
  viewer.renderList();
  viewer.renderPagination();
  if (!state.selectedId && state.items[0]) state.selectedId = state.items[0].id;
  if (state.selectedId && !state.items.find((item) => item.id === state.selectedId)) {
    state.selectedId = state.items[0]?.id || null;
  }
  viewer.updateActiveCard();
  viewer.persistViewState();
}

async function prefetchIndexPage(queryString) {
  if (!queryString || viewer.pageCache.has(queryString) || viewer.pagePrefetchInFlight.has(queryString)) return;
  const pending = (async () => {
    try {
      const response = await fetch(`/api/index?${queryString}`);
      const payload = await response.json();
      if (!response.ok) return;
      viewer.rememberPageCache(queryString, payload);
    } catch {}
  })();
  viewer.pagePrefetchInFlight.set(queryString, pending);
  try {
    await pending;
  } finally {
    viewer.pagePrefetchInFlight.delete(queryString);
  }
}

function prefetchNeighborPages() {
  const { hasPrevious, hasNext, offset, limit, totalPages } = state.pagination;
  if (!totalPages) return;
  if (hasPrevious) void prefetchIndexPage(pageQueryStringForOffset(offset - limit));
  if (hasNext) void prefetchIndexPage(pageQueryStringForOffset(offset + limit));
}

async function fetchIndex({ reason = "load", useCache = true } = {}) {
  const requestToken = ++viewer.indexRequestToken;
  const queryString = currentPageQueryString();
  const loadingMessage = reason === "search" ? "Updating results..." : "Loading...";
  const showGalleryLoading = reason !== "page" && reason !== "background-refresh";

  if (useCache && !state.indexStatus?.isRefreshing && viewer.pageCache.has(queryString)) {
    applyIndexPayload(viewer.pageCache.get(queryString));
    viewer.scheduleIndexRefreshPoll();
    void viewer.renderDetail();
    prefetchNeighborPages();
    return;
  }

  if (showGalleryLoading) {
    viewer.setSectionLoading(viewer.els.gallerySection, true, loadingMessage);
  }

  try {
    const response = await fetch(`/api/index?${queryString}`);
    const payload = await response.json();
    if (requestToken !== viewer.indexRequestToken) {
      return;
    }

    if (!response.ok) {
      const message = payload?.details ? `${payload.error || "Failed to load index"}: ${payload.details}` : payload?.error || "Failed to load index";
      viewer.renderIndexError(message);
      viewer.clearIndexRefreshPoll();
      return;
    }

    const builtAtChanged = state.builtAt && payload.builtAt && state.builtAt !== payload.builtAt;
    if (builtAtChanged) {
      viewer.pageCache.clear();
      viewer.detailCache.clear();
    }
    viewer.rememberPageCache(queryString, payload);
    applyIndexPayload(payload);
    viewer.scheduleIndexRefreshPoll();
    await viewer.renderDetail();
    prefetchNeighborPages();
  } catch (error) {
    if (requestToken !== viewer.indexRequestToken) {
      return;
    }
    viewer.renderIndexError(error?.message || "Failed to load index");
    viewer.clearIndexRefreshPoll();
  } finally {
    if (showGalleryLoading && requestToken === viewer.indexRequestToken) {
      viewer.setSectionLoading(viewer.els.gallerySection, false);
    }
  }
}

async function fetchDetail(id) {
  if (viewer.detailCache.has(id)) return viewer.detailCache.get(id);
  const response = await fetch(`/api/item/${encodeURIComponent(id)}`);
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.details ? `${payload.error || "Failed to load details"}: ${payload.details}` : payload?.error || "Failed to load details";
    throw new Error(message);
  }
  viewer.rememberDetailCache(id, payload);
  return payload;
}

Object.assign(viewer, {
  applyIndexPayload,
  buildQueryString,
  currentPageQueryString,
  fetchDetail,
  fetchIndex,
  pageQueryStringForOffset,
  prefetchNeighborPages,
});
})();
