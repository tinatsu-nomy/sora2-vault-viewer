const state = {
  items: [],
  stats: null,
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
    sources: ["v2_profile", "v2_liked", "v2_drafts"],
    sort: "date-desc",
    dateFrom: "",
    dateTo: "",
    localOnly: true,
    withText: false,
    withMedia: false,
    showCameo: true,
  },
};

const els = {
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
  navChips: [...document.querySelectorAll(".nav-chip")],
};

let mediaObserver = null;
let detailRequestToken = 0;
let indexRequestToken = 0;
let searchDebounceTimer = null;
const pageCache = new Map();
const detailCache = new Map();
const pagePrefetchInFlight = new Map();
const MAX_PAGE_CACHE_ENTRIES = 18;
const MAX_DETAIL_CACHE_ENTRIES = 120;
const MIN_PAGE_BUTTON_LOADING_MS = 180;

const SOURCE_ORDER = ["v2_profile", "v2_liked", "v2_drafts"];

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function displayTitle(item) {
  return item.prompt || item.posterUsername || "Untitled video";
}

function formatPosterUsername(item) {
  if (!item.posterUsername) return "";
  return `@${item.posterUsername}`;
}

function formatCameoUsernames(item) {
  const usernames = item.cameoOwnerUsernames?.length ? item.cameoOwnerUsernames : [];
  if (!usernames.length) return "";
  return usernames.map((username) => `@${username}`).join(", ");
}

function sourceLabel(source) {
  if (source === "v2_profile") return "profile";
  if (source === "v2_drafts") return "drafts";
  if (source === "v2_liked") return "liked";
  return source || "unknown";
}

function syncNavChips() {
  const selectedSources = new Set(state.filters.sources);
  const allSelected = SOURCE_ORDER.every((source) => selectedSources.has(source));

  for (const chip of els.navChips) {
    const chipSource = chip.dataset.source;
    const isActive = chipSource === "all" ? allSelected : selectedSources.has(chipSource);
    chip.classList.toggle("active", isActive);
    chip.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

function clearSearchDebounce() {
  if (!searchDebounceTimer) return;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = null;
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function rememberPageCache(key, payload) {
  if (!key || !payload) return;
  pageCache.delete(key);
  pageCache.set(key, payload);
  trimCache(pageCache, MAX_PAGE_CACHE_ENTRIES);
}

function rememberDetailCache(id, payload) {
  if (!id || !payload) return;
  detailCache.delete(id);
  detailCache.set(id, payload);
  trimCache(detailCache, MAX_DETAIL_CACHE_ENTRIES);
}

function clearDataCaches() {
  pageCache.clear();
  detailCache.clear();
  pagePrefetchInFlight.clear();
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function pendingPageNumber() {
  return state.pagination.total === 0 ? 1 : Math.floor(state.pagination.offset / state.pagination.limit) + 1;
}

function showPageLoadingModal() {
  const pageNumber = pendingPageNumber();
  els.pageLoadingTitle.textContent = `Loading page ${pageNumber}...`;
  els.pageLoadingMessage.textContent = "Updating the gallery and selected details.";
  els.pageLoadingModal.classList.remove("hidden");
  els.pageLoadingModal.setAttribute("aria-hidden", "false");
}

function hidePageLoadingModal() {
  els.pageLoadingModal.classList.add("hidden");
  els.pageLoadingModal.setAttribute("aria-hidden", "true");
}

function setSectionLoading(section, isLoading, message = "Loading...") {
  if (!section) return;
  section.classList.toggle("is-loading", isLoading);
  section.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (isLoading) {
    section.dataset.loadingLabel = message;
  } else {
    section.dataset.loadingLabel = "";
  }
}

function releaseGalleryMedia() {
  if (mediaObserver) {
    mediaObserver.disconnect();
    mediaObserver = null;
  }

  for (const video of els.list.querySelectorAll(".gallery-video")) {
    pauseGalleryVideo(video);
    video.removeAttribute("src");
    video.load();
    delete video.dataset.loaded;
    video.classList.remove("is-visible");
  }
}

function currentPageQueryString() {
  return buildQueryString();
}

function pageQueryStringForOffset(offset) {
  const params = new URLSearchParams();
  if (state.filters.query) params.set("query", state.filters.query);
  if (state.filters.sources.length !== SOURCE_ORDER.length) params.set("sources", state.filters.sources.join(","));
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

function applyIndexPayload(payload) {
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
  renderStats();
  renderList();
  renderPagination();
  if (!state.selectedId && state.items[0]) state.selectedId = state.items[0].id;
  if (state.selectedId && !state.items.find((item) => item.id === state.selectedId)) {
    state.selectedId = state.items[0]?.id || null;
  }
  updateActiveCard();
}

async function prefetchIndexPage(queryString) {
  if (!queryString || pageCache.has(queryString) || pagePrefetchInFlight.has(queryString)) return;
  const pending = (async () => {
    try {
      const response = await fetch(`/api/index?${queryString}`);
      const payload = await response.json();
      if (!response.ok) return;
      rememberPageCache(queryString, payload);
    } catch {}
  })();
  pagePrefetchInFlight.set(queryString, pending);
  try {
    await pending;
  } finally {
    pagePrefetchInFlight.delete(queryString);
  }
}

function prefetchNeighborPages() {
  const { hasPrevious, hasNext, offset, limit, totalPages } = state.pagination;
  if (!totalPages) return;
  if (hasPrevious) {
    void prefetchIndexPage(pageQueryStringForOffset(offset - limit));
  }
  if (hasNext) {
    void prefetchIndexPage(pageQueryStringForOffset(offset + limit));
  }
}

function buildQueryString() {
  const params = new URLSearchParams();
  if (state.filters.query) params.set("query", state.filters.query);
  if (state.filters.sources.length !== SOURCE_ORDER.length) params.set("sources", state.filters.sources.join(","));
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

function renderIndexError(message) {
  state.items = [];
  state.stats = null;
  state.pagination = {
    total: 0,
    limit: state.pagination.limit,
    offset: 0,
    page: 0,
    totalPages: 0,
    hasPrevious: false,
    hasNext: false,
  };
  state.selectedId = null;
  els.stats.innerHTML = `
    <article class="summary-card db-card">
      <strong>Index Error</strong>
      <div class="subtle">${escapeHtml(message)}</div>
    </article>
  `;
  els.resultMeta.textContent = "Index unavailable";
  els.list.innerHTML = `
    <article class="empty-state">
      <strong>Unable to load the viewer index</strong>
      <div class="subtle">${escapeHtml(message)}</div>
    </article>
  `;
  els.pagination.innerHTML = "";
  els.detail.innerHTML = "Fix the manifest/index issue and try Rescan again.";
}

async function fetchIndex({ reason = "load", useCache = true } = {}) {
  const requestToken = ++indexRequestToken;
  const queryString = currentPageQueryString();
  const loadingMessage = reason === "search" ? "Updating results..." : "Loading...";
  const showGalleryLoading = reason !== "page";

  if (useCache && pageCache.has(queryString)) {
    applyIndexPayload(pageCache.get(queryString));
    void renderDetail();
    prefetchNeighborPages();
    return;
  }

  if (showGalleryLoading) {
    setSectionLoading(els.gallerySection, true, loadingMessage);
  }
  try {
    const response = await fetch(`/api/index?${queryString}`);
    const payload = await response.json();
    if (requestToken !== indexRequestToken) {
      return;
    }

    if (!response.ok) {
      const message = payload?.details ? `${payload.error || "Failed to load index"}: ${payload.details}` : payload?.error || "Failed to load index";
      renderIndexError(message);
      return;
    }

    rememberPageCache(queryString, payload);
    applyIndexPayload(payload);
    await renderDetail();
    prefetchNeighborPages();
  } catch (error) {
    if (requestToken !== indexRequestToken) {
      return;
    }
    renderIndexError(error?.message || "Failed to load index");
  } finally {
    if (showGalleryLoading && requestToken === indexRequestToken) {
      setSectionLoading(els.gallerySection, false);
    }
  }
}

async function fetchDetail(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  const response = await fetch(`/api/item/${encodeURIComponent(id)}`);
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.details ? `${payload.error || "Failed to load details"}: ${payload.details}` : payload?.error || "Failed to load details";
    throw new Error(message);
  }
  rememberDetailCache(id, payload);
  return payload;
}

function renderStats() {
  const stats = state.stats;
  const manifestRows = (stats.manifests || [])
    .map((manifest) => {
      const fileName = String(manifest.file || "").split(/[\\/]/).pop() || "unknown";
      return `<div class="subtle">${escapeHtml(fileName)}</div>`;
    })
    .join("");

  els.stats.innerHTML = `
    <article class="summary-card">
      <strong>${stats.totalItems}</strong>
      <small>Total items</small>
    </article>
    <article class="summary-card">
      <strong>${stats.withLocalMedia}</strong>
      <small>Playable locally</small>
    </article>
    <article class="summary-card">
      <strong>${stats.withLocalText}</strong>
      <small>With TXT</small>
    </article>
    <article class="summary-card">
      <strong>${stats.localOnlyItems}</strong>
      <small>Without manifest</small>
    </article>
    <article class="summary-card db-card">
      <strong>SQLite Cache</strong>
      <div class="subtle">
        ${
          stats.database?.enabled
            ? `saved items: ${escapeHtml(String(stats.database?.savedItems || 0))}`
            : `disabled: ${escapeHtml(stats.database?.error || "unknown")}`
        }
      </div>
    </article>
    <article class="summary-card db-card">
      <strong>Loaded manifests</strong>
      ${manifestRows || '<div class="subtle">No manifest files detected</div>'}
    </article>
  `;
}

function createMediaMarkup(item) {
  const localMediaUrl = item.mediaUrl || null;
  if (localMediaUrl) {
    return `
      <div class="gallery-media">
        <video
          class="gallery-video"
          data-src="${escapeHtml(localMediaUrl)}"
          muted
          loop
          playsinline
          preload="none"
        ></video>
      </div>
    `;
  }

  return `
    <div class="gallery-media">
      <div class="gallery-fallback">
        <div>
          <div>LOCAL VIDEO NOT FOUND</div>
          <div class="subtle" style="margin-top:10px;">External URLs are available in the links below.</div>
        </div>
      </div>
    </div>
  `;
}

function loadGalleryVideo(video) {
  if (!video || video.dataset.loaded === "1") return;
  const src = video.dataset.src;
  if (!src) return;
  video.src = src;
  video.dataset.loaded = "1";
  video.load();
}

function pauseGalleryVideo(video) {
  if (!video) return;
  video.pause();
}

function syncGalleryPlayback() {
  const videos = [...els.list.querySelectorAll(".gallery-video")];
  const visibleVideos = videos.filter((video) => video.classList.contains("is-visible"));

  for (const video of visibleVideos) {
    loadGalleryVideo(video);
    video.play().catch(() => {});
  }

  videos
    .filter((video) => !video.classList.contains("is-visible"))
    .forEach((video) => pauseGalleryVideo(video));
}

function setupGalleryMediaObserver() {
  if (mediaObserver) {
    mediaObserver.disconnect();
    mediaObserver = null;
  }

  const videos = [...els.list.querySelectorAll(".gallery-video")];
  if (!videos.length) return;

  if (!("IntersectionObserver" in window)) {
    videos.forEach((video) => {
      video.classList.add("is-visible");
      loadGalleryVideo(video);
    });
    syncGalleryPlayback();
    return;
  }

  mediaObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0.2) {
          entry.target.classList.add("is-visible");
          loadGalleryVideo(entry.target);
        } else {
          entry.target.classList.remove("is-visible");
          pauseGalleryVideo(entry.target);
        }
      }
      syncGalleryPlayback();
    },
    {
      root: null,
      rootMargin: "240px 0px",
      threshold: [0, 0.2, 0.6],
    },
  );

  for (const video of videos) {
    mediaObserver.observe(video);
  }
}

function updateActiveCard() {
  for (const card of els.list.querySelectorAll(".gallery-card")) {
    const isActive = card.dataset.id === state.selectedId;
    card.classList.toggle("active", isActive);
    const button = card.querySelector(".gallery-select-button");
    if (button) {
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }
}

function galleryCards() {
  return [...els.list.querySelectorAll(".gallery-card")];
}

function gallerySelectButtons() {
  return [...els.list.querySelectorAll(".gallery-select-button")];
}

function horizontalCenter(card) {
  return card.offsetLeft + card.offsetWidth / 2;
}

function rowTops(cards) {
  return [...new Set(cards.map((card) => card.offsetTop))].sort((left, right) => left - right);
}

function rowCards(cards, top) {
  return cards.filter((card) => Math.abs(card.offsetTop - top) <= 4);
}

function findArrowNavigationTarget(currentButton, direction) {
  const buttons = gallerySelectButtons();
  const currentIndex = buttons.indexOf(currentButton);
  if (currentIndex === -1) return null;

  if (direction === "ArrowLeft") return buttons[currentIndex - 1] || null;
  if (direction === "ArrowRight") return buttons[currentIndex + 1] || null;

  const cards = buttons.map((button) => button.closest(".gallery-card")).filter(Boolean);
  const currentCard = currentButton.closest(".gallery-card");
  if (!currentCard) return null;

  const tops = rowTops(cards);
  const currentTop = tops.find((top) => Math.abs(top - currentCard.offsetTop) <= 4);
  const currentRowIndex = tops.indexOf(currentTop);
  const targetRowIndex = direction === "ArrowUp" ? currentRowIndex - 1 : currentRowIndex + 1;
  const targetTop = tops[targetRowIndex];
  if (currentTop == null || targetTop == null) return null;

  const targetCards = rowCards(cards, targetTop);
  if (!targetCards.length) return null;

  const currentCenter = horizontalCenter(currentCard);
  const targetCard = targetCards.reduce((best, candidate) => {
    if (!best) return candidate;
    return Math.abs(horizontalCenter(candidate) - currentCenter) < Math.abs(horizontalCenter(best) - currentCenter)
      ? candidate
      : best;
  }, null);
  return targetCard?.querySelector(".gallery-select-button") || null;
}

async function selectGalleryItem(id) {
  if (!id || id === state.selectedId) return;
  state.selectedId = id;
  updateActiveCard();
  await renderDetail();
}

async function focusAndSelectButton(button) {
  if (!button) return;
  button.focus();
  const card = button.closest(".gallery-card");
  card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  await selectGalleryItem(button.dataset.id);
}

function renderList() {
  const { total, offset } = state.pagination;
  const start = total === 0 ? 0 : offset + 1;
  const end = offset + state.items.length;
  els.resultMeta.textContent =
    total === 0 ? "0 items" : `${start}-${end} of ${total} items`;
  if (!state.items.length) {
    releaseGalleryMedia();
    els.list.innerHTML = `
      <article class="empty-state">
        <strong>No items match the current search and filters</strong>
        <div class="subtle">Try a different search, re-enable more sources, or turn off some filters.</div>
      </article>
    `;
    return;
  }
  els.list.innerHTML = state.items
    .map((item) => {
      const title = displayTitle(item);
      const localMediaUrl = item.mediaUrl || null;
      const posterUsername = formatPosterUsername(item);
      const cameoUsernames = formatCameoUsernames(item);
      return `
        <article
          class="gallery-card ${item.id === state.selectedId ? "active" : ""}"
          data-id="${escapeHtml(item.id)}"
        >
          ${createMediaMarkup(item)}
          <button
            type="button"
            class="gallery-select-button"
            data-id="${escapeHtml(item.id)}"
            aria-pressed="${item.id === state.selectedId ? "true" : "false"}"
            aria-label="Open details for ${escapeHtml(title)}"
          >
            <span class="sr-only">Open details for ${escapeHtml(title)}</span>
          </button>
          <div class="gallery-overlay">
            <div class="gallery-top">
              <div class="badge-row">
                <span class="badge">${escapeHtml(sourceLabel(item.source))}</span>
                ${item.hasLocalMedia ? `<span class="badge good">local play</span>` : `<span class="badge warn">remote only</span>`}
                ${typeof item.likeCount === "number" ? `<span class="badge">♥ ${escapeHtml(String(item.likeCount))}</span>` : ""}
                ${typeof item.viewCount === "number" ? `<span class="badge">◉ ${escapeHtml(String(item.viewCount))}</span>` : ""}
              </div>
            </div>

            <div class="gallery-bottom">
              <div class="gallery-title">${escapeHtml(title)}</div>
              <div class="meta-row">
                ${item.date ? `<span class="meta-pill">${escapeHtml(item.date)}</span>` : ""}
                ${item.duration ? `<span class="meta-pill">${escapeHtml(String(item.duration))}s</span>` : ""}
                ${posterUsername ? `<span class="meta-pill">posted by ${escapeHtml(posterUsername)}</span>` : ""}
                ${state.filters.showCameo && cameoUsernames ? `<span class="meta-pill">cameo ${escapeHtml(cameoUsernames)}</span>` : ""}
              </div>
              <div class="card-links">
                ${localMediaUrl ? `<span>plays in viewer</span>` : ""}
                ${!localMediaUrl && item.previewUrl ? `<a href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">preview</a>` : ""}
                ${item.downloadUrl ? `<a href="${escapeHtml(item.downloadUrl)}" target="_blank" rel="noreferrer">download</a>` : ""}
                ${item.thumbUrl ? `<a href="${escapeHtml(item.thumbUrl)}" target="_blank" rel="noreferrer">thumb</a>` : ""}
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  for (const button of gallerySelectButtons()) {
    button.addEventListener("click", async () => {
      await selectGalleryItem(button.dataset.id);
    });
    button.addEventListener("keydown", async (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const targetButton = findArrowNavigationTarget(button, event.key);
      if (!targetButton) return;
      event.preventDefault();
      await focusAndSelectButton(targetButton);
    });
  }

  setupGalleryMediaObserver();
}

function renderPagination() {
  const { page, totalPages, hasPrevious, hasNext, total } = state.pagination;
  if (!total) {
    els.pagination.innerHTML = "";
    return;
  }

  els.pagination.innerHTML = `
    <div class="pagination-summary">Page ${page} of ${totalPages}</div>
    <div class="pagination-actions">
      <button type="button" class="secondary page-button" data-page="first" ${hasPrevious ? "" : "disabled"}>First</button>
      <button type="button" class="secondary page-button" data-page="prev" ${hasPrevious ? "" : "disabled"}>Previous</button>
      <button type="button" class="secondary page-button" data-page="next" ${hasNext ? "" : "disabled"}>Next</button>
      <button type="button" class="secondary page-button" data-page="last" ${hasNext ? "" : "disabled"}>Last</button>
    </div>
  `;

  const pendingAction = state.pendingPageAction;
  if (pendingAction) {
    for (const button of els.pagination.querySelectorAll(".page-button")) {
      const isPendingButton = button.dataset.page === pendingAction;
      button.disabled = true;
      button.classList.toggle("is-loading", isPendingButton);
      if (isPendingButton) {
        button.dataset.defaultLabel = button.textContent;
        button.textContent = "Loading...";
      }
    }
  }

  for (const button of els.pagination.querySelectorAll(".page-button")) {
    button.addEventListener("click", async () => {
      if (state.pendingPageAction) return;
      const pageAction = button.dataset.page;
      const startedAt = Date.now();
      if (pageAction === "first" && !state.pagination.hasPrevious) return;
      if (pageAction === "prev" && !state.pagination.hasPrevious) return;
      if (pageAction === "next" && !state.pagination.hasNext) return;
      if (pageAction === "last" && !state.pagination.hasNext) return;

      if (pageAction === "first") {
        state.pagination.offset = 0;
      }
      if (pageAction === "prev") {
        state.pagination.offset = Math.max(0, state.pagination.offset - state.pagination.limit);
      }
      if (pageAction === "next") {
        state.pagination.offset += state.pagination.limit;
      }
      if (pageAction === "last") {
        state.pagination.offset = Math.max(0, (state.pagination.totalPages - 1) * state.pagination.limit);
      }
      state.pendingPageAction = pageAction;
      renderPagination();
      showPageLoadingModal();
      syncFiltersFromForm();
      releaseGalleryMedia();
      try {
        await fetchIndex({ reason: "page" });
        window.scrollTo({ top: 0, behavior: "smooth" });
      } finally {
        const remainingMs = MIN_PAGE_BUTTON_LOADING_MS - (Date.now() - startedAt);
        if (remainingMs > 0) {
          await delay(remainingMs);
        }
        state.pendingPageAction = null;
        hidePageLoadingModal();
        renderPagination();
      }
    });
  }
}

async function renderDetail() {
  if (!state.selectedId) {
    els.detail.innerHTML = "Select a card to see its details here.";
    return;
  }

  const selectedId = state.selectedId;
  const requestToken = ++detailRequestToken;
  setSectionLoading(els.detailSection, true);
  let item;
  try {
    item = await fetchDetail(selectedId);
  } catch (error) {
    if (requestToken !== detailRequestToken || selectedId !== state.selectedId) {
      return;
    }
    els.detail.innerHTML = `
      <article class="detail-card">
        <h3>Detail Error</h3>
        <div class="subtle">${escapeHtml(error.message || "Unable to load the selected item.")}</div>
      </article>
    `;
    return;
  } finally {
    if (requestToken === detailRequestToken && selectedId === state.selectedId) {
      setSectionLoading(els.detailSection, false);
    }
  }
  if (requestToken !== detailRequestToken || selectedId !== state.selectedId) {
    return;
  }
  const localMediaUrl = item.mediaUrl || null;
  const posterUsername = formatPosterUsername(item);
  const cameoUsernames = formatCameoUsernames(item);
  const summaryChips = [
    item.date ? `<span class="detail-chip">${escapeHtml(item.date)}</span>` : "",
    posterUsername ? `<span class="detail-chip accent">posted by ${escapeHtml(posterUsername)}</span>` : "",
    typeof item.likeCount === "number" ? `<span class="detail-chip">♥ ${escapeHtml(item.likeCount)}</span>` : "",
    typeof item.viewCount === "number" ? `<span class="detail-chip">◉ ${escapeHtml(item.viewCount)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const links = [
    item.previewUrl ? `<a href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">previewUrl</a>` : "",
    item.downloadUrl ? `<a href="${escapeHtml(item.downloadUrl)}" target="_blank" rel="noreferrer">downloadUrl</a>` : "",
    item.thumbUrl ? `<a href="${escapeHtml(item.thumbUrl)}" target="_blank" rel="noreferrer">thumbUrl</a>` : "",
    item.permalink
      ? `<a href="${escapeHtml(item.permalink)}" target="_blank" rel="noreferrer">permalink</a>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  els.detail.innerHTML = `
    ${
      localMediaUrl
        ? `<div class="detail-player"><video controls autoplay loop preload="metadata" playsinline src="${escapeHtml(localMediaUrl)}"></video></div>`
        : `<div class="detail-card"><div class="subtle">No local MP4 was found. Use external links below if available.</div></div>`
    }

    <div class="detail-hero">
      <div class="detail-hero-kicker">Selected item</div>
      <h3 class="detail-hero-title">${escapeHtml(displayTitle(item))}</h3>
      <div class="detail-hero-chips">${summaryChips || '<span class="detail-chip">No summary metadata</span>'}</div>
    </div>

    <div class="detail-card">
      <h3>Overview</h3>
      <div class="detail-grid">
        <div class="detail-row"><span>source</span><strong>${escapeHtml(sourceLabel(item.source))}</strong></div>
        <div class="detail-row"><span>date</span><strong>${escapeHtml(item.date || "")}</strong></div>
        <div class="detail-row"><span>posted by</span><strong>${escapeHtml(posterUsername)}</strong></div>
        ${
          state.filters.showCameo
            ? `<div class="detail-row"><span>cameo</span><strong>${escapeHtml(cameoUsernames)}</strong></div>`
            : ""
        }
        <div class="detail-row"><span>♥</span><strong>${escapeHtml(item.likeCount ?? "")}</strong></div>
        <div class="detail-row"><span>◉</span><strong>${escapeHtml(item.viewCount ?? "")}</strong></div>
        <div class="detail-row"><span>duration</span><strong>${escapeHtml(String(item.duration || item.local?.parsed?.duration || ""))}</strong></div>
        <div class="detail-row"><span>resolution</span><strong>${escapeHtml(item.width && item.height ? `${item.width} x ${item.height}` : item.local?.parsed?.resolution || "")}</strong></div>
        <div class="detail-row"><span>ratio</span><strong>${escapeHtml(item.ratio || item.local?.parsed?.aspectRatio || "")}</strong></div>
      </div>
    </div>

    <div class="detail-card">
      <h3>Prompt</h3>
      <div class="prompt-box">${escapeHtml(item.prompt || item.local?.txtPrompt || "(empty)")}</div>
    </div>

    ${
      links
        ? `
          <div class="detail-card">
            <h3>Links</h3>
            <div class="links">${links}</div>
          </div>
        `
        : ""
    }

    ${
      item.local?.txtRaw
        ? `
          <div class="detail-card">
            <h3>TXT</h3>
            <div class="subtle" style="margin-bottom:10px;">encoding: ${escapeHtml(item.local.txtEncoding || "unknown")}</div>
            <div class="text-box">${escapeHtml(item.local.txtRaw)}</div>
          </div>
        `
        : ""
    }

    ${
      item.debug
        ? `
          <div class="detail-card">
            <h3>Local Files</h3>
            <div class="text-box">${escapeHtml(
              [item.debug.localMediaPath, item.debug.localTxtPath].filter(Boolean).join("\n") || "No local files detected",
            )}</div>
          </div>

          <div class="detail-card">
            <h3>Manifest JSON</h3>
            <pre class="json-box">${escapeHtml(formatJson(item.debug.raw || {}))}</pre>
          </div>
        `
        : ""
    }
  `;

  const detailVideo = els.detail.querySelector(".detail-player video");
  if (detailVideo) {
    detailVideo.play().catch(() => {});
  }
}

function syncFiltersFromForm() {
  state.filters.query = els.query.value.trim();
  state.filters.sort = els.sort.value;
  state.pagination.limit = Number(els.pageSize.value || state.pagination.limit);
  state.filters.dateFrom = els.dateFrom.value;
  state.filters.dateTo = els.dateTo.value;
  state.filters.localOnly = els.localOnly.checked;
  state.filters.withText = els.withText.checked;
  state.filters.withMedia = els.withMedia.checked;
  state.filters.showCameo = els.showCameo.checked;
}

function updateDateResetButton() {
  const hasDateFilter = Boolean(els.dateFrom.value || els.dateTo.value);
  els.resetDateButton.disabled = !hasDateFilter;
}

async function clearDateFilters() {
  clearSearchDebounce();
  els.dateFrom.value = "";
  els.dateTo.value = "";
  updateDateResetButton();
  resetPagination();
  clearDataCaches();
  await refresh();
}

function applySourceFilter(source) {
  if (source === "all") {
    state.filters.sources = [...SOURCE_ORDER];
  } else if (state.filters.sources.includes(source)) {
    if (state.filters.sources.length === 1) {
      syncNavChips();
      return;
    }
    state.filters.sources = state.filters.sources.filter((item) => item !== source);
  } else {
    state.filters.sources = [...state.filters.sources, source].sort(
      (left, right) => SOURCE_ORDER.indexOf(left) - SOURCE_ORDER.indexOf(right),
    );
  }

  syncNavChips();
  resetPagination();
  clearDataCaches();
  refresh();
}

function resetPagination() {
  state.pagination.offset = 0;
}

async function refresh() {
  syncFiltersFromForm();
  await fetchIndex({ reason: "search" });
}

function setRebuildState(isBusy, message = "") {
  els.rebuildButton.disabled = isBusy;
  els.rebuildButton.textContent = isBusy ? "Rescanning..." : "Rescan";
  els.rebuildStatus.textContent = message;
  els.rebuildStatus.classList.toggle("busy", isBusy);
}

function showRebuildModal(title, message) {
  els.rebuildModalTitle.textContent = title;
  els.rebuildModalMessage.textContent = message;
  els.rebuildModal.classList.remove("hidden");
  els.rebuildModal.setAttribute("aria-hidden", "false");
  els.rebuildModalOk.focus();
}

function hideRebuildModal() {
  els.rebuildModal.classList.add("hidden");
  els.rebuildModal.setAttribute("aria-hidden", "true");
}

els.clearQueryButton.addEventListener("click", async () => {
  clearSearchDebounce();
  els.query.value = "";
  resetPagination();
  clearDataCaches();
  await refresh();
  els.query.focus();
});
els.query.addEventListener("input", () => {
  clearSearchDebounce();
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    resetPagination();
    clearDataCaches();
    await refresh();
  }, 220);
});
els.query.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    clearSearchDebounce();
    resetPagination();
    clearDataCaches();
    await refresh();
  }
});
els.sort.addEventListener("change", async () => {
  resetPagination();
  clearDataCaches();
  await refresh();
});
els.pageSize.addEventListener("change", async () => {
  resetPagination();
  clearDataCaches();
  await refresh();
});

for (const input of [els.dateFrom, els.dateTo]) {
  input.addEventListener("input", () => {
    updateDateResetButton();
    clearSearchDebounce();
    searchDebounceTimer = setTimeout(async () => {
      searchDebounceTimer = null;
      resetPagination();
      clearDataCaches();
      await refresh();
    }, 220);
  });
  input.addEventListener("change", async () => {
    updateDateResetButton();
    clearSearchDebounce();
    resetPagination();
    clearDataCaches();
    await refresh();
  });
  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    clearSearchDebounce();
    resetPagination();
    clearDataCaches();
    await refresh();
  });
}

els.resetDateButton.addEventListener("click", async () => {
  await clearDateFilters();
});

for (const chip of els.navChips) {
  chip.addEventListener("click", () => {
    applySourceFilter(chip.dataset.source);
  });
}

for (const checkbox of [els.localOnly, els.withText, els.withMedia]) {
  checkbox.addEventListener("change", async () => {
    resetPagination();
    clearDataCaches();
    await refresh();
  });
}

els.showCameo.addEventListener("change", async () => {
  syncFiltersFromForm();
  renderList();
  renderPagination();
  await renderDetail();
});

els.rebuildButton.addEventListener("click", async () => {
  setRebuildState(true, "Scanning manifests and local files...");
  try {
    const response = await fetch("/api/rebuild", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.details
        ? `${payload.error || "Rescan failed"}: ${payload.details}`
        : payload?.error || "Rescan failed";
      throw new Error(message);
    }
    clearDataCaches();
    await refresh();
    setRebuildState(false, "");
    showRebuildModal("Rescan complete", "Manifest and local file scanning has finished.");
  } catch (error) {
    setRebuildState(false, "");
    showRebuildModal("Rescan failed", error.message || "Manifest and local file scanning failed.");
  } finally {
    if (els.rebuildButton.disabled) {
      setRebuildState(false, "");
    }
  }
});

els.rebuildModalOk.addEventListener("click", () => {
  hideRebuildModal();
});

els.rebuildModal.addEventListener("click", (event) => {
  if (event.target === els.rebuildModal) {
    hideRebuildModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.rebuildModal.classList.contains("hidden")) {
    hideRebuildModal();
  }
});

updateDateResetButton();
refresh();
