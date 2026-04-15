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
  filters: {
    query: "",
    sources: ["v2_profile", "v2_liked", "v2_drafts"],
    sort: "date-desc",
    localOnly: true,
    withText: false,
    withMedia: false,
    showCameo: false,
  },
};

const els = {
  query: document.querySelector("#query"),
  source: document.querySelector("#source"),
  sort: document.querySelector("#sort"),
  pageSize: document.querySelector("#pageSize"),
  localOnly: document.querySelector("#localOnly"),
  withText: document.querySelector("#withText"),
  withMedia: document.querySelector("#withMedia"),
  showCameo: document.querySelector("#showCameo"),
  searchButton: document.querySelector("#searchButton"),
  clearQueryButton: document.querySelector("#clearQueryButton"),
  rebuildButton: document.querySelector("#rebuildButton"),
  rebuildStatus: document.querySelector("#rebuildStatus"),
  rebuildModal: document.querySelector("#rebuildModal"),
  rebuildModalMessage: document.querySelector("#rebuildModalMessage"),
  rebuildModalOk: document.querySelector("#rebuildModalOk"),
  list: document.querySelector("#list"),
  detail: document.querySelector("#detail"),
  stats: document.querySelector("#stats"),
  resultMeta: document.querySelector("#resultMeta"),
  pagination: document.querySelector("#pagination"),
  navChips: [...document.querySelectorAll(".nav-chip")],
};

let mediaObserver = null;

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

function buildQueryString() {
  const params = new URLSearchParams();
  if (state.filters.query) params.set("query", state.filters.query);
  if (state.filters.sources.length !== SOURCE_ORDER.length) params.set("sources", state.filters.sources.join(","));
  if (state.filters.sort) params.set("sort", state.filters.sort);
  if (state.filters.localOnly) params.set("localOnly", "1");
  if (state.filters.withText) params.set("withText", "1");
  if (state.filters.withMedia) params.set("withMedia", "1");
  params.set("limit", String(state.pagination.limit));
  params.set("offset", String(state.pagination.offset));
  return params.toString();
}

async function fetchIndex() {
  const response = await fetch(`/api/index?${buildQueryString()}`);
  const payload = await response.json();
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
  populateSourceFilter(payload.stats.sources);
  renderStats();
  renderList();
  renderPagination();
  if (!state.selectedId && state.items[0]) state.selectedId = state.items[0].id;
  if (state.selectedId && !state.items.find((item) => item.id === state.selectedId)) {
    state.selectedId = state.items[0]?.id || null;
  }
  updateActiveCard();
  await renderDetail();
}

async function fetchDetail(id) {
  const response = await fetch(`/api/item/${encodeURIComponent(id)}`);
  return response.json();
}

function populateSourceFilter(sources) {
  const preferredOrder = ["v2_profile", "v2_liked", "v2_drafts"];
  const orderedSources = [...sources].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });

  els.source.innerHTML = `<option value="all">All</option>${orderedSources
    .map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(sourceLabel(source))}</option>`)
    .join("")}`;
  state.filters.sources = orderedSources.filter((source) => state.filters.sources.includes(source));
  els.source.value = state.filters.sources.length === 1 ? state.filters.sources[0] : "all";
  syncNavChips();
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
      <div class="subtle">${escapeHtml(stats.database?.path || "")}</div>
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
  const localMediaUrl = item.localMediaPath ? `/media?path=${encodeURIComponent(item.localMediaPath)}` : null;
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
    card.classList.toggle("active", card.dataset.id === state.selectedId);
  }
}

function renderList() {
  const { total, offset } = state.pagination;
  const start = total === 0 ? 0 : offset + 1;
  const end = offset + state.items.length;
  els.resultMeta.textContent =
    total === 0 ? "0 items" : `${start}-${end} of ${total} items`;
  els.list.innerHTML = state.items
    .map((item) => {
      const title = displayTitle(item);
      const localMediaUrl = item.localMediaPath ? `/media?path=${encodeURIComponent(item.localMediaPath)}` : null;
      const posterUsername = formatPosterUsername(item);
      const cameoUsernames = formatCameoUsernames(item);
      return `
        <article class="gallery-card ${item.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(item.id)}">
          ${createMediaMarkup(item)}
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
                ${posterUsername ? `<span class="meta-pill">poster ${escapeHtml(posterUsername)}</span>` : ""}
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

  for (const card of els.list.querySelectorAll(".gallery-card")) {
    card.addEventListener("click", async () => {
      state.selectedId = card.dataset.id;
      updateActiveCard();
      await renderDetail();
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
      <button type="button" class="secondary page-button" data-page="prev" ${hasPrevious ? "" : "disabled"}>Previous</button>
      <button type="button" class="secondary page-button" data-page="next" ${hasNext ? "" : "disabled"}>Next</button>
    </div>
  `;

  for (const button of els.pagination.querySelectorAll(".page-button")) {
    button.addEventListener("click", async () => {
      if (button.dataset.page === "prev" && state.pagination.hasPrevious) {
        state.pagination.offset = Math.max(0, state.pagination.offset - state.pagination.limit);
      }
      if (button.dataset.page === "next" && state.pagination.hasNext) {
        state.pagination.offset += state.pagination.limit;
      }
      await refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
}

async function renderDetail() {
  if (!state.selectedId) {
    els.detail.innerHTML = "Select a card to see its details here.";
    return;
  }

  const item = await fetchDetail(state.selectedId);
  const localMediaUrl = item.local?.mediaPath ? `/media?path=${encodeURIComponent(item.local.mediaPath)}` : null;
  const posterUsername = formatPosterUsername(item);
  const cameoUsernames = formatCameoUsernames(item);
  const summaryChips = [
    item.date ? `<span class="detail-chip">${escapeHtml(item.date)}</span>` : "",
    posterUsername ? `<span class="detail-chip accent">poster ${escapeHtml(posterUsername)}</span>` : "",
    typeof item.likeCount === "number" ? `<span class="detail-chip">♥ ${escapeHtml(item.likeCount)}</span>` : "",
    typeof item.viewCount === "number" ? `<span class="detail-chip">◉ ${escapeHtml(item.viewCount)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const links = [
    item.previewUrl ? `<a href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">previewUrl</a>` : "",
    item.downloadUrl ? `<a href="${escapeHtml(item.downloadUrl)}" target="_blank" rel="noreferrer">downloadUrl</a>` : "",
    item.thumbUrl ? `<a href="${escapeHtml(item.thumbUrl)}" target="_blank" rel="noreferrer">thumbUrl</a>` : "",
    item.raw?._raw?.post?.permalink
      ? `<a href="${escapeHtml(item.raw._raw.post.permalink)}" target="_blank" rel="noreferrer">permalink</a>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  els.detail.innerHTML = `
    ${
      localMediaUrl
        ? `<div class="detail-player"><video controls autoplay loop preload="metadata" playsinline src="${escapeHtml(localMediaUrl)}"></video></div>`
        : `<div class="detail-card"><div class="subtle">No local MP4 was found. Use the external links below if needed.</div></div>`
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
        <div class="detail-row"><span>poster</span><strong>${escapeHtml(posterUsername)}</strong></div>
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

    <div class="detail-card">
      <h3>Links</h3>
      <div class="links">${links || '<span class="subtle">No external links</span>'}</div>
    </div>

    <div class="detail-card">
      <h3>Local Files</h3>
      <div class="text-box">${escapeHtml(
        [item.local?.mediaPath, item.local?.txtPath].filter(Boolean).join("\n") || "No local files detected",
      )}</div>
    </div>

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

    <div class="detail-card">
      <h3>Manifest JSON</h3>
      <pre class="json-box">${escapeHtml(formatJson(item.raw || {}))}</pre>
    </div>
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
  state.filters.localOnly = els.localOnly.checked;
  state.filters.withText = els.withText.checked;
  state.filters.withMedia = els.withMedia.checked;
  state.filters.showCameo = els.showCameo.checked;
}

function applySourceFilter(source) {
  if (source === "all") {
    const allSelected = SOURCE_ORDER.every((item) => state.filters.sources.includes(item));
    state.filters.sources = allSelected ? [] : [...SOURCE_ORDER];
  } else if (state.filters.sources.includes(source)) {
    state.filters.sources = state.filters.sources.filter((item) => item !== source);
  } else {
    state.filters.sources = [...state.filters.sources, source].sort(
      (left, right) => SOURCE_ORDER.indexOf(left) - SOURCE_ORDER.indexOf(right),
    );
  }

  els.source.value = state.filters.sources.length === 1 ? state.filters.sources[0] : "all";
  syncNavChips();
  resetPagination();
  refresh();
}

function resetPagination() {
  state.pagination.offset = 0;
}

async function refresh() {
  syncFiltersFromForm();
  await fetchIndex();
}

function setRebuildState(isBusy, message = "") {
  els.rebuildButton.disabled = isBusy;
  els.rebuildButton.textContent = isBusy ? "Rescanning..." : "Rescan";
  els.rebuildStatus.textContent = message;
  els.rebuildStatus.classList.toggle("busy", isBusy);
}

function showRebuildModal(message) {
  els.rebuildModalMessage.textContent = message;
  els.rebuildModal.classList.remove("hidden");
  els.rebuildModal.setAttribute("aria-hidden", "false");
  els.rebuildModalOk.focus();
}

function hideRebuildModal() {
  els.rebuildModal.classList.add("hidden");
  els.rebuildModal.setAttribute("aria-hidden", "true");
}

els.searchButton.addEventListener("click", async () => {
  resetPagination();
  await refresh();
});
els.clearQueryButton.addEventListener("click", async () => {
  els.query.value = "";
  resetPagination();
  await refresh();
  els.query.focus();
});
els.query.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    resetPagination();
    await refresh();
  }
});
els.source.addEventListener("change", async () => {
  state.filters.sources = els.source.value === "all" ? [...SOURCE_ORDER] : [els.source.value];
  syncNavChips();
  resetPagination();
  await refresh();
});
els.sort.addEventListener("change", async () => {
  resetPagination();
  await refresh();
});
els.pageSize.addEventListener("change", async () => {
  resetPagination();
  await refresh();
});

for (const chip of els.navChips) {
  chip.addEventListener("click", () => {
    applySourceFilter(chip.dataset.source);
  });
}

for (const checkbox of [els.localOnly, els.withText, els.withMedia, els.showCameo]) {
  checkbox.addEventListener("change", async () => {
    resetPagination();
    await refresh();
  });
}

els.rebuildButton.addEventListener("click", async () => {
  setRebuildState(true, "Scanning manifests and local files...");
  try {
    await fetch("/api/rebuild", { method: "POST" });
    await refresh();
    setRebuildState(false, "");
    showRebuildModal("Manifest and local file scanning has finished.");
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

refresh();
