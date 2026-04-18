(() => {
const viewer = window.SoraViewer = window.SoraViewer || {};

viewer.DEFAULT_FILTERS = {
  query: "",
  sources: [],
  sort: "date-desc",
  dateFrom: "",
  dateTo: "",
  localOnly: true,
  withText: false,
  withMedia: false,
  showCameo: true,
};

viewer.DEFAULT_PAGINATION = {
  total: 0,
  limit: 24,
  offset: 0,
  page: 0,
  totalPages: 0,
  hasPrevious: false,
  hasNext: false,
};

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
  pagination: { ...viewer.DEFAULT_PAGINATION },
  pendingPageAction: null,
  filters: { ...viewer.DEFAULT_FILTERS },
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
viewer.VIEW_STATE_STORAGE_KEY = "sora-viewer:view-state:v1";
viewer.VIEW_STATE_QUERY_KEYS = [
  "query",
  "sources",
  "sort",
  "dateFrom",
  "dateTo",
  "localOnly",
  "withText",
  "withMedia",
  "showCameo",
  "limit",
  "offset",
  "item",
];

viewer.safeLocalStorage = function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

viewer.parseBooleanParam = function parseBooleanParam(value, fallback) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

viewer.parsePositiveInteger = function parsePositiveInteger(value, fallback, { allowZero = false } = {}) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (allowZero && parsed === 0) return 0;
  return parsed > 0 ? parsed : fallback;
};

viewer.normalizeViewState = function normalizeViewState(raw = {}) {
  const filters = {
    ...viewer.DEFAULT_FILTERS,
    query: String(raw.query || "").trim(),
    sources: [...new Set((Array.isArray(raw.sources) ? raw.sources : []).filter(Boolean))],
    sort: String(raw.sort || viewer.DEFAULT_FILTERS.sort),
    dateFrom: String(raw.dateFrom || ""),
    dateTo: String(raw.dateTo || ""),
    localOnly: Boolean(raw.localOnly ?? viewer.DEFAULT_FILTERS.localOnly),
    withText: Boolean(raw.withText ?? viewer.DEFAULT_FILTERS.withText),
    withMedia: Boolean(raw.withMedia ?? viewer.DEFAULT_FILTERS.withMedia),
    showCameo: Boolean(raw.showCameo ?? viewer.DEFAULT_FILTERS.showCameo),
  };

  return {
    query: filters.query,
    sources: filters.sources,
    sort: filters.sort,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    localOnly: filters.localOnly,
    withText: filters.withText,
    withMedia: filters.withMedia,
    showCameo: filters.showCameo,
    limit: viewer.parsePositiveInteger(raw.limit, viewer.DEFAULT_PAGINATION.limit),
    offset: viewer.parsePositiveInteger(raw.offset, viewer.DEFAULT_PAGINATION.offset, { allowZero: true }),
    selectedId: String(raw.selectedId || raw.item || "").trim(),
  };
};

viewer.serializeViewState = function serializeViewState() {
  return viewer.normalizeViewState({
    query: viewer.state.filters.query,
    sources: viewer.state.filters.sources,
    sort: viewer.state.filters.sort,
    dateFrom: viewer.state.filters.dateFrom,
    dateTo: viewer.state.filters.dateTo,
    localOnly: viewer.state.filters.localOnly,
    withText: viewer.state.filters.withText,
    withMedia: viewer.state.filters.withMedia,
    showCameo: viewer.state.filters.showCameo,
    limit: viewer.state.pagination.limit,
    offset: viewer.state.pagination.offset,
    selectedId: viewer.state.selectedId,
  });
};

viewer.readViewStateFromLocation = function readViewStateFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const hasKnownState = viewer.VIEW_STATE_QUERY_KEYS.some((key) => params.has(key));
  if (!hasKnownState) return null;

  return viewer.normalizeViewState({
    query: params.get("query"),
    sources: String(params.get("sources") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    sort: params.get("sort"),
    dateFrom: params.get("dateFrom"),
    dateTo: params.get("dateTo"),
    localOnly: viewer.parseBooleanParam(params.get("localOnly"), viewer.DEFAULT_FILTERS.localOnly),
    withText: viewer.parseBooleanParam(params.get("withText"), viewer.DEFAULT_FILTERS.withText),
    withMedia: viewer.parseBooleanParam(params.get("withMedia"), viewer.DEFAULT_FILTERS.withMedia),
    showCameo: viewer.parseBooleanParam(params.get("showCameo"), viewer.DEFAULT_FILTERS.showCameo),
    limit: viewer.parsePositiveInteger(params.get("limit"), viewer.DEFAULT_PAGINATION.limit),
    offset: viewer.parsePositiveInteger(params.get("offset"), viewer.DEFAULT_PAGINATION.offset, { allowZero: true }),
    item: params.get("item"),
  });
};

viewer.readViewStateFromStorage = function readViewStateFromStorage() {
  const storage = viewer.safeLocalStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(viewer.VIEW_STATE_STORAGE_KEY);
    if (!raw) return null;
    return viewer.normalizeViewState(JSON.parse(raw));
  } catch {
    return null;
  }
};

viewer.applyViewState = function applyViewState(nextState = {}) {
  const normalized = viewer.normalizeViewState(nextState);

  viewer.state.filters.query = normalized.query;
  viewer.state.filters.sources = normalized.sources;
  viewer.state.filters.sort = normalized.sort;
  viewer.state.filters.dateFrom = normalized.dateFrom;
  viewer.state.filters.dateTo = normalized.dateTo;
  viewer.state.filters.localOnly = normalized.localOnly;
  viewer.state.filters.withText = normalized.withText;
  viewer.state.filters.withMedia = normalized.withMedia;
  viewer.state.filters.showCameo = normalized.showCameo;
  viewer.state.pagination.limit = normalized.limit;
  viewer.state.pagination.offset = normalized.offset;
  viewer.state.selectedId = normalized.selectedId || null;
};

viewer.restoreViewState = function restoreViewState() {
  const locationState = viewer.readViewStateFromLocation();
  const storedState = locationState ? null : viewer.readViewStateFromStorage();
  const nextState = locationState || storedState;
  if (!nextState) return;
  viewer.applyViewState(nextState);
};

viewer.syncFormFromState = function syncFormFromState() {
  const { els, state } = viewer;
  if (!els.query) return;

  els.query.value = state.filters.query;

  if (els.sort) {
    const sortOptions = [...els.sort.options].map((option) => option.value);
    els.sort.value = sortOptions.includes(state.filters.sort) ? state.filters.sort : viewer.DEFAULT_FILTERS.sort;
    state.filters.sort = els.sort.value;
  }

  if (els.pageSize) {
    const pageSizeOptions = [...els.pageSize.options].map((option) => option.value);
    const nextPageSize = String(state.pagination.limit || viewer.DEFAULT_PAGINATION.limit);
    els.pageSize.value = pageSizeOptions.includes(nextPageSize) ? nextPageSize : String(viewer.DEFAULT_PAGINATION.limit);
    state.pagination.limit = Number(els.pageSize.value || viewer.DEFAULT_PAGINATION.limit);
  }

  els.dateFrom.value = state.filters.dateFrom;
  els.dateTo.value = state.filters.dateTo;
  els.localOnly.checked = state.filters.localOnly;
  els.withText.checked = state.filters.withText;
  els.withMedia.checked = state.filters.withMedia;
  els.showCameo.checked = state.filters.showCameo;
};

viewer.persistViewState = function persistViewState() {
  const snapshot = viewer.serializeViewState();
  const storage = viewer.safeLocalStorage();

  if (storage) {
    try {
      storage.setItem(viewer.VIEW_STATE_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {}
  }

  if (!window.history?.replaceState) return;

  const params = new URLSearchParams(window.location.search);
  for (const key of viewer.VIEW_STATE_QUERY_KEYS) {
    params.delete(key);
  }

  if (snapshot.query) params.set("query", snapshot.query);

  const visibleSources = viewer.filterableSources();
  const hasCustomSourceSelection = snapshot.sources.length > 0
    && (!visibleSources.length || snapshot.sources.length !== visibleSources.length);
  if (hasCustomSourceSelection) {
    params.set("sources", snapshot.sources.join(","));
  }

  if (snapshot.sort && snapshot.sort !== viewer.DEFAULT_FILTERS.sort) params.set("sort", snapshot.sort);
  if (snapshot.dateFrom) params.set("dateFrom", snapshot.dateFrom);
  if (snapshot.dateTo) params.set("dateTo", snapshot.dateTo);
  if (snapshot.localOnly !== viewer.DEFAULT_FILTERS.localOnly) params.set("localOnly", snapshot.localOnly ? "1" : "0");
  if (snapshot.withText !== viewer.DEFAULT_FILTERS.withText) params.set("withText", snapshot.withText ? "1" : "0");
  if (snapshot.withMedia !== viewer.DEFAULT_FILTERS.withMedia) params.set("withMedia", snapshot.withMedia ? "1" : "0");
  if (snapshot.showCameo !== viewer.DEFAULT_FILTERS.showCameo) params.set("showCameo", snapshot.showCameo ? "1" : "0");
  if (snapshot.limit !== viewer.DEFAULT_PAGINATION.limit) params.set("limit", String(snapshot.limit));
  if (snapshot.offset > 0) params.set("offset", String(snapshot.offset));
  if (snapshot.selectedId) params.set("item", snapshot.selectedId);

  const nextSearch = params.toString();
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
};

viewer.sourceDirectoryName = function sourceDirectoryName(source) {
  if (!source) return "";
  return source;
};

viewer.isCustomUserSource = function isCustomUserSource(source) {
  return /^v2_@/i.test(source || "");
};

viewer.isCharSource = function isCharSource(source) {
  return /^v2_char(?:_drafts)?_@/i.test(source || "");
};

viewer.isCharDraftSource = function isCharDraftSource(source) {
  return /^v2_char_drafts_@/i.test(source || "");
};

viewer.charSourceIdentity = function charSourceIdentity(source) {
  if (viewer.isCharDraftSource(source)) {
    return source.replace(/^v2_char_drafts_/i, "");
  }
  if (viewer.isCharSource(source)) {
    return source.replace(/^v2_char_/i, "");
  }
  return "";
};

viewer.isPrimaryNavSource = function isPrimaryNavSource(source) {
  return ["v2_profile", "v2_liked", "v2_draft", "v2_drafts"].includes(source || "");
};

viewer.visibleSources = function visibleSources(sources = viewer.SOURCE_ORDER) {
  return (sources || []).filter((source) => {
    return viewer.isPrimaryNavSource(source) || viewer.isCustomUserSource(source) || viewer.isCharSource(source);
  });
};

viewer.filterableSources = function filterableSources(sources = viewer.SOURCE_ORDER) {
  return viewer.visibleSources(sources);
};

viewer.primarySources = function primarySources(sources = viewer.SOURCE_ORDER) {
  return viewer.visibleSources(sources).filter((source) => {
    return !viewer.isCustomUserSource(source) && !viewer.isCharSource(source);
  });
};

viewer.customSources = function customSources(sources = viewer.SOURCE_ORDER) {
  return viewer.visibleSources(sources).filter((source) => viewer.isCustomUserSource(source));
};

viewer.charSources = function charSources(sources = viewer.SOURCE_ORDER) {
  return viewer.visibleSources(sources).filter((source) => viewer.isCharSource(source));
};

viewer.charSourceGroups = function charSourceGroups(sources = viewer.SOURCE_ORDER) {
  const groups = new Map();
  for (const source of viewer.charSources(sources)) {
    const identity = viewer.charSourceIdentity(source);
    if (!identity) continue;
    if (!groups.has(identity)) {
      groups.set(identity, {
        id: identity,
        label: identity,
        sources: [],
      });
    }
    groups.get(identity).sources.push(source);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sources: group.sources.sort(viewer.compareSources),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "ja"));
};

viewer.compareSources = function compareSources(left, right) {
  if (left === right) return 0;
  if (left === "v2_profile") return -1;
  if (right === "v2_profile") return 1;
  const leftIsCustomUser = viewer.isCustomUserSource(left);
  const rightIsCustomUser = viewer.isCustomUserSource(right);
  const leftIsChar = viewer.isCharSource(left);
  const rightIsChar = viewer.isCharSource(right);
  if (leftIsCustomUser !== rightIsCustomUser) return leftIsCustomUser ? 1 : -1;
  if (leftIsChar !== rightIsChar) return leftIsChar ? 1 : -1;
  return viewer.sourceDirectoryName(left).localeCompare(viewer.sourceDirectoryName(right), "ja");
};

viewer.normalizeSources = function normalizeSources(sources) {
  return [...new Set((sources || []).filter(Boolean))].sort(viewer.compareSources);
};

viewer.sourceDisplayName = function sourceDisplayName(source) {
  if (source === "v2_profile") return "Profile";
  if (source === "v2_draft" || source === "v2_drafts") return "draft";
  if (viewer.isCharDraftSource(source)) return `${viewer.charSourceIdentity(source)} drafts`;
  if (viewer.isCharSource(source)) return viewer.charSourceIdentity(source);
  if (typeof source === "string" && source.startsWith("v2_")) {
    return source.slice(3);
  }
  return viewer.sourceDirectoryName(source);
};

viewer.setAvailableSources = function setAvailableSources(sources) {
  const nextSources = viewer.normalizeSources(sources);
  const nextFilterableSources = viewer.filterableSources(nextSources);
  const previousSources = viewer.SOURCE_ORDER;
  const previousFilterableSources = viewer.filterableSources(previousSources);
  const hadAllSourcesSelected =
    previousFilterableSources.length > 0
    && previousFilterableSources.every((source) => viewer.state.filters.sources.includes(source));

  viewer.SOURCE_ORDER = nextSources;

  if (!nextFilterableSources.length) {
    viewer.state.filters.sources = [];
    return;
  }

  if (!viewer.state.filters.sources.length || hadAllSourcesSelected) {
    viewer.state.filters.sources = [...nextFilterableSources];
    return;
  }

  const nextSelectedSources = viewer.state.filters.sources.filter((source) => nextFilterableSources.includes(source));
  viewer.state.filters.sources = nextSelectedSources.length ? nextSelectedSources : [...nextFilterableSources];
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
