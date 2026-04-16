(() => {
const viewer = window.SoraViewer = window.SoraViewer || {};

viewer.state = {
  items: [],
  stats: null,
  builtAt: null,
  indexStatus: {
    isRefreshing: false,
    isStale: false,
    refreshError: null,
  },
  selectedId: null,
  pagination: {
    total: 0,
    limit: 24,
    offset: 0,
    page: 0,
    totalPages: 0,
    hasPrevious: false,
    hasNext: false,
  },
  pendingPageAction: null,
  filters: {
    query: "",
    sources: [],
    sort: "date-desc",
    dateFrom: "",
    dateTo: "",
    localOnly: true,
    withText: false,
    withMedia: false,
    showCameo: true,
  },
};

viewer.els = {
  query: document.querySelector("#query"),
  sort: document.querySelector("#sort"),
  pageSize: document.querySelector("#pageSize"),
  dateFrom: document.querySelector("#dateFrom"),
  dateTo: document.querySelector("#dateTo"),
  resetDateButton: document.querySelector("#resetDateButton"),
  localOnly: document.querySelector("#localOnly"),
  withText: document.querySelector("#withText"),
  withMedia: document.querySelector("#withMedia"),
  showCameo: document.querySelector("#showCameo"),
  clearQueryButton: document.querySelector("#clearQueryButton"),
  rebuildButton: document.querySelector("#rebuildButton"),
  rebuildStatus: document.querySelector("#rebuildStatus"),
  topnav: document.querySelector(".topnav"),
  indexStatusBanner: document.querySelector("#indexStatusBanner"),
  rebuildModal: document.querySelector("#rebuildModal"),
  rebuildModalTitle: document.querySelector("#rebuildModalTitle"),
  rebuildModalMessage: document.querySelector("#rebuildModalMessage"),
  rebuildModalOk: document.querySelector("#rebuildModalOk"),
  pageLoadingModal: document.querySelector("#pageLoadingModal"),
  pageLoadingTitle: document.querySelector("#pageLoadingTitle"),
  pageLoadingMessage: document.querySelector("#pageLoadingMessage"),
  gallerySection: document.querySelector(".gallery-section"),
  detailSection: document.querySelector(".detail-section"),
  list: document.querySelector("#list"),
  detail: document.querySelector("#detail"),
  stats: document.querySelector("#stats"),
  resultMeta: document.querySelector("#resultMeta"),
  pagination: document.querySelector("#pagination"),
};

viewer.mediaObserver = null;
viewer.detailRequestToken = 0;
viewer.indexRequestToken = 0;
viewer.searchDebounceTimer = null;
viewer.pageCache = new Map();
viewer.detailCache = new Map();
viewer.pagePrefetchInFlight = new Map();
viewer.refreshPollTimer = null;
viewer.MAX_PAGE_CACHE_ENTRIES = 18;
viewer.MAX_DETAIL_CACHE_ENTRIES = 120;
viewer.MIN_PAGE_BUTTON_LOADING_MS = 180;
viewer.BACKGROUND_REFRESH_POLL_MS = 1200;
viewer.SOURCE_ORDER = [];

viewer.sourceDirectoryName = function sourceDirectoryName(source) {
  if (!source) return "";
  return source;
};

viewer.isCustomUserSource = function isCustomUserSource(source) {
  return /^v2_@/i.test(source || "");
};

viewer.primarySources = function primarySources(sources = viewer.SOURCE_ORDER) {
  return (sources || []).filter((source) => !viewer.isCustomUserSource(source));
};

viewer.customSources = function customSources(sources = viewer.SOURCE_ORDER) {
  return (sources || []).filter((source) => viewer.isCustomUserSource(source));
};

viewer.compareSources = function compareSources(left, right) {
  if (left === right) return 0;
  if (left === "v2_profile") return -1;
  if (right === "v2_profile") return 1;
  const leftIsCustomUser = viewer.isCustomUserSource(left);
  const rightIsCustomUser = viewer.isCustomUserSource(right);
  if (leftIsCustomUser !== rightIsCustomUser) return leftIsCustomUser ? 1 : -1;
  return viewer.sourceDirectoryName(left).localeCompare(viewer.sourceDirectoryName(right), "ja");
};

viewer.normalizeSources = function normalizeSources(sources) {
  return [...new Set((sources || []).filter(Boolean))].sort(viewer.compareSources);
};

viewer.sourceDisplayName = function sourceDisplayName(source) {
  if (source === "v2_profile") return "Profile";
  if (source === "v2_draft" || source === "v2_drafts") return "draft";
  if (typeof source === "string" && source.startsWith("v2_")) {
    return source.slice(3);
  }
  return viewer.sourceDirectoryName(source);
};

viewer.setAvailableSources = function setAvailableSources(sources) {
  const nextSources = viewer.normalizeSources(sources);
  const previousSources = viewer.SOURCE_ORDER;
  const hadAllSourcesSelected =
    previousSources.length > 0
    && previousSources.every((source) => viewer.state.filters.sources.includes(source));

  viewer.SOURCE_ORDER = nextSources;

  if (!nextSources.length) {
    viewer.state.filters.sources = [];
    return;
  }

  if (!viewer.state.filters.sources.length || hadAllSourcesSelected) {
    viewer.state.filters.sources = [...nextSources];
    return;
  }

  const nextSelectedSources = viewer.state.filters.sources.filter((source) => nextSources.includes(source));
  viewer.state.filters.sources = nextSelectedSources.length ? nextSelectedSources : [...nextSources];
};

viewer.clearSearchDebounce = function clearSearchDebounce() {
  if (!viewer.searchDebounceTimer) return;
  clearTimeout(viewer.searchDebounceTimer);
  viewer.searchDebounceTimer = null;
};

viewer.trimCache = function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
};

viewer.rememberPageCache = function rememberPageCache(key, payload) {
  if (!key || !payload || payload.indexStatus?.isRefreshing) return;
  viewer.pageCache.delete(key);
  viewer.pageCache.set(key, payload);
  viewer.trimCache(viewer.pageCache, viewer.MAX_PAGE_CACHE_ENTRIES);
};

viewer.rememberDetailCache = function rememberDetailCache(id, payload) {
  if (!id || !payload) return;
  viewer.detailCache.delete(id);
  viewer.detailCache.set(id, payload);
  viewer.trimCache(viewer.detailCache, viewer.MAX_DETAIL_CACHE_ENTRIES);
};

viewer.clearDataCaches = function clearDataCaches() {
  viewer.pageCache.clear();
  viewer.detailCache.clear();
  viewer.pagePrefetchInFlight.clear();
  viewer.clearIndexRefreshPoll();
};

viewer.delay = function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
};

viewer.pendingPageNumber = function pendingPageNumber() {
  const { state } = viewer;
  return state.pagination.total === 0 ? 1 : Math.floor(state.pagination.offset / state.pagination.limit) + 1;
};

viewer.showPageLoadingModal = function showPageLoadingModal() {
  const { els } = viewer;
  const pageNumber = viewer.pendingPageNumber();
  els.pageLoadingTitle.textContent = `Loading page ${pageNumber}...`;
  els.pageLoadingMessage.textContent = "Updating the gallery and selected details.";
  els.pageLoadingModal.classList.remove("hidden");
  els.pageLoadingModal.setAttribute("aria-hidden", "false");
};

viewer.hidePageLoadingModal = function hidePageLoadingModal() {
  const { els } = viewer;
  els.pageLoadingModal.classList.add("hidden");
  els.pageLoadingModal.setAttribute("aria-hidden", "true");
};

viewer.clearIndexRefreshPoll = function clearIndexRefreshPoll() {
  if (!viewer.refreshPollTimer) return;
  window.clearTimeout(viewer.refreshPollTimer);
  viewer.refreshPollTimer = null;
};

viewer.scheduleIndexRefreshPoll = function scheduleIndexRefreshPoll() {
  viewer.clearIndexRefreshPoll();
  if (!viewer.state.indexStatus?.isRefreshing) return;
  viewer.refreshPollTimer = window.setTimeout(() => {
    viewer.refreshPollTimer = null;
    void viewer.fetchIndex({ reason: "background-refresh", useCache: false });
  }, viewer.BACKGROUND_REFRESH_POLL_MS);
};

viewer.setSectionLoading = function setSectionLoading(section, isLoading, message = "Loading...") {
  if (!section) return;
  section.classList.toggle("is-loading", isLoading);
  section.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (isLoading) {
    section.dataset.loadingLabel = message;
  } else {
    section.dataset.loadingLabel = "";
  }
};
})();
