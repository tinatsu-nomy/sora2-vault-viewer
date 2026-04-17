(() => {
const viewer = window.SoraViewer = window.SoraViewer || {};
const { state, els } = viewer;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function eyeIconMarkup() {
  return `
    <svg class="metric-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2.2 12c2.1-3.8 5.8-6 9.8-6s7.7 2.2 9.8 6c-2.1 3.8-5.8 6-9.8 6S4.3 15.8 2.2 12Z"></path>
      <circle cx="12" cy="12" r="3.2"></circle>
    </svg>
  `;
}

function heartIconMarkup() {
  return `
    <svg class="metric-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 21.3 10.6 20C5.4 15.2 2 12.1 2 8.3 2 5.2 4.4 3 7.4 3c1.7 0 3.4.8 4.6 2.2C13.2 3.8 14.9 3 16.6 3 19.6 3 22 5.2 22 8.3c0 3.8-3.4 6.9-8.6 11.7L12 21.3Z"></path>
    </svg>
  `;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function formatResolution(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  return `${width} x ${height}`;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(Number(left) || 0);
  let b = Math.abs(Number(right) || 0);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function formatAspectRatio(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function normalizedPromptText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\(?none\)?$/i.test(text)) return "";
  return text;
}

function displayTitle(item) {
  const prompt = normalizedPromptText(item?.prompt);
  if (prompt) return prompt;

  const localPrompt = normalizedPromptText(item?.local?.txtPrompt);
  if (localPrompt) return localPrompt;

  return "";
}

function accessibleItemLabel(item) {
  return displayTitle(item) || item?.genId || item?.postId || item?.taskId || "selected item";
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

function avatarUrlForItem(item, role, username = "") {
  if (!item?.id) return "";
  const params = new URLSearchParams({
    id: item.id,
    role,
  });
  if (username) params.set("username", username);
  return `/avatar?${params.toString()}`;
}

function avatarDotMarkup(url) {
  const imageUrl = url || "/avatar-fallback.svg";
  return `
    <span class="avatar-dot" aria-hidden="true">
      <img src="${escapeHtml(imageUrl)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/avatar-fallback.svg'">
    </span>
  `;
}

function userInlineMarkup(label, url) {
  return `
    <span class="user-inline">
      ${avatarDotMarkup(url)}
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

function cameoEntries(item) {
  if (item?.cameoProfiles?.length) {
    return item.cameoProfiles
      .filter((profile) => profile?.username)
      .map((profile) => ({
        username: profile.username,
        userId: profile.userId || null,
      }));
  }

  return (item?.cameoOwnerUsernames || [])
    .filter(Boolean)
    .map((username) => ({
      username,
      userId: null,
    }));
}

function cameoInlineMarkup(item) {
  const entries = cameoEntries(item);
  if (!entries.length) return "";
  return entries
    .map((entry) => userInlineMarkup(`@${entry.username}`, avatarUrlForItem(item, "cameo", entry.username)))
    .join("");
}

function sourceLabel(source) {
  if (!source) return "unknown";
  if (source === "v2_profile") return "profile";
  if (source === "v2_draft" || source === "v2_drafts") return "draft";
  return viewer.sourceDirectoryName(source) || source;
}

function sourceLabelsForItem(item) {
  const sources = item?.sourceMemberships?.length ? item.sourceMemberships : [item?.source].filter(Boolean);
  return [...new Set(sources.map((source) => sourceLabel(source)).filter(Boolean))];
}

function navChips() {
  return [...(els.topnav?.querySelectorAll(".nav-chip") || [])];
}

function sourceMenuMarkup({
  sources,
  menuRole,
  summaryLabel,
  title,
  toggleLabel,
}) {
  if (!sources.length) return "";
  const sourceOptions = sources
    .map((source) => `
      <label class="source-menu-option">
        <input type="checkbox" class="source-menu-checkbox" data-source="${escapeHtml(source)}" />
        <span>${escapeHtml(viewer.sourceDisplayName(source))}</span>
      </label>
    `)
    .join("");
  return `
    <details class="source-menu" data-role="${escapeHtml(menuRole)}">
      <summary class="nav-chip source-menu-summary">${escapeHtml(summaryLabel)}</summary>
      <div class="source-menu-panel">
        <div class="source-menu-head">
          <strong>${escapeHtml(title)}</strong>
          <span class="subtle" data-role="${escapeHtml(`${menuRole}-count`)}"></span>
        </div>
        <label class="source-menu-master-toggle">
          <input type="checkbox" data-role="${escapeHtml(`${menuRole}-toggle`)}" />
          <span>${escapeHtml(toggleLabel)}</span>
        </label>
        <div class="source-menu-list">
          ${sourceOptions}
        </div>
      </div>
    </details>
  `;
}

function charSourceMenuMarkup(groups) {
  if (!groups.length) return "";
  const sourceOptions = groups
    .map((group) => `
      <label class="source-menu-option">
        <input type="checkbox" class="source-menu-checkbox" data-char-group="${escapeHtml(group.id)}" />
        <span>${escapeHtml(group.label)}</span>
      </label>
    `)
    .join("");
  return `
    <details class="source-menu" data-role="char-sources">
      <summary class="nav-chip source-menu-summary">Chars</summary>
      <div class="source-menu-panel">
        <div class="source-menu-head">
          <strong>Character sources</strong>
          <span class="subtle" data-role="char-sources-count"></span>
        </div>
        <label class="source-menu-master-toggle">
          <input type="checkbox" data-role="char-sources-toggle" />
          <span>Enable all chars</span>
        </label>
        <div class="source-menu-list">
          ${sourceOptions}
        </div>
      </div>
    </details>
  `;
}

function renderSourceNav() {
  if (!els.topnav) return;

  const primarySourceButtons = viewer.primarySources()
    .map((source) => `
      <button type="button" class="nav-chip" data-source="${escapeHtml(source)}">${escapeHtml(viewer.sourceDisplayName(source))}</button>
    `)
    .join("");
  const customSourceMenu = sourceMenuMarkup({
    sources: viewer.customSources(),
    menuRole: "custom-sources",
    summaryLabel: "Users",
    title: "User sources",
    toggleLabel: "Enable all users",
  });
  const charSourceMenu = charSourceMenuMarkup(viewer.charSourceGroups());

  els.topnav.innerHTML = `
    <button type="button" class="nav-chip" data-source="all">All</button>
    ${primarySourceButtons}
    ${customSourceMenu}
    ${charSourceMenu}
  `;

  syncNavChips();
}

function metadataResolutionText(item) {
  const manifestResolution = formatResolution(item?.width, item?.height);
  if (manifestResolution) return manifestResolution;
  return String(item?.local?.parsed?.resolution || "").trim();
}

function metadataRatioText(item) {
  const manifestRatio = String(item?.ratio || "").trim();
  if (manifestRatio) return manifestRatio;
  return String(item?.local?.parsed?.aspectRatio || "").trim();
}

function syncNavChips() {
  const selectedSources = new Set(state.filters.sources);
  const visibleSources = viewer.visibleSources();
  const allSelected = visibleSources.every((source) => selectedSources.has(source));

  for (const chip of navChips()) {
    const chipSource = chip.dataset.source;
    const isActive = chipSource === "all" ? allSelected : selectedSources.has(chipSource);
    chip.classList.toggle("active", isActive);
    chip.setAttribute("aria-pressed", isActive ? "true" : "false");
  }

  for (const checkbox of els.topnav?.querySelectorAll(".source-menu-checkbox") || []) {
    if (checkbox.dataset.charGroup) {
      const group = viewer.charSourceGroups(visibleSources).find((entry) => entry.id === checkbox.dataset.charGroup);
      const selectedCount = group ? group.sources.filter((source) => selectedSources.has(source)).length : 0;
      checkbox.checked = Boolean(group?.sources.length) && selectedCount === group.sources.length;
      checkbox.indeterminate = selectedCount > 0 && selectedCount < (group?.sources.length || 0);
      continue;
    }
    checkbox.checked = selectedSources.has(checkbox.dataset.source);
  }

  const sourceMenus = [
    {
      menuRole: "custom-sources",
      summaryLabel: "Users",
      sources: viewer.customSources(visibleSources),
    },
    {
      menuRole: "char-sources",
      summaryLabel: "Chars",
      sources: viewer.charSourceGroups(visibleSources),
    },
  ];

  for (const { menuRole, summaryLabel, sources } of sourceMenus) {
    const selectedMenuSources = menuRole === "char-sources"
      ? sources.filter((group) => group.sources.some((source) => selectedSources.has(source)))
      : sources.filter((source) => selectedSources.has(source));
    const sourceMenu = els.topnav?.querySelector(`[data-role="${menuRole}"]`);
    const sourceSummary = sourceMenu?.querySelector(".source-menu-summary");
    const sourceCount = sourceMenu?.querySelector(`[data-role="${menuRole}-count"]`);
    const sourceToggle = sourceMenu?.querySelector(`[data-role="${menuRole}-toggle"]`);

    if (sourceSummary) {
      const hasSelection = selectedMenuSources.length > 0;
      sourceSummary.classList.toggle("active", hasSelection);
      sourceSummary.setAttribute("aria-pressed", hasSelection ? "true" : "false");
      sourceSummary.textContent = hasSelection
        ? `${summaryLabel} (${selectedMenuSources.length})`
        : `${summaryLabel} (${sources.length})`;
    }

    if (sourceCount) {
      sourceCount.textContent = sources.length
        ? `${selectedMenuSources.length}/${sources.length} selected`
        : "";
    }

    if (sourceToggle) {
      sourceToggle.checked = sources.length > 0 && selectedMenuSources.length === sources.length;
      sourceToggle.indeterminate = selectedMenuSources.length > 0 && selectedMenuSources.length < sources.length;
    }
  }
}

function releaseGalleryMedia() {
  if (viewer.mediaObserver) {
    viewer.mediaObserver.disconnect();
    viewer.mediaObserver = null;
  }

  for (const video of els.list.querySelectorAll(".gallery-video")) {
    pauseGalleryVideo(video);
    video.removeAttribute("src");
    video.load();
    delete video.dataset.loaded;
    video.classList.remove("is-visible");
  }
}

function renderIndexError(message) {
  state.items = [];
  state.stats = null;
  state.indexStatus = {
    isRefreshing: false,
    isStale: false,
    refreshError: message,
  };
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
  renderIndexStatus();
  viewer.setSectionLoading(els.detailSection, false);
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

function renderIndexStatus() {
  const banner = els.indexStatusBanner;
  if (!banner) return;

  if (state.indexStatus?.isRefreshing) {
    banner.className = "index-status-banner";
    banner.innerHTML = `
      <strong class="index-status-title">Background Update Running</strong>
      <span class="index-status-text">Showing the previous index until the latest scan finishes.</span>
    `;
    banner.classList.remove("hidden");
    return;
  }

  if (state.indexStatus?.refreshError) {
    banner.className = "index-status-banner warn";
    banner.innerHTML = `
      <strong class="index-status-title">Background Update Failed</strong>
      <span class="index-status-text">Showing the last completed index. ${escapeHtml(state.indexStatus.refreshError)}</span>
    `;
    banner.classList.remove("hidden");
    return;
  }

  banner.className = "index-status-banner hidden";
  banner.innerHTML = "";
}

function renderStats() {
  const stats = state.stats;
  if (!stats) {
    els.stats.innerHTML = "";
    return;
  }
  const pathRows = [
    stats.paths?.dataDir ? `<div class="subtle">data: ${escapeHtml(stats.paths.dataDir)}</div>` : "",
    stats.paths?.appDataDir ? `<div class="subtle">app-data: ${escapeHtml(stats.paths.appDataDir)}</div>` : "",
    stats.paths?.configPath ? `<div class="subtle">config: ${escapeHtml(stats.paths.configPath)}</div>` : "",
    stats.paths?.sqlitePath ? `<div class="subtle">sqlite: ${escapeHtml(stats.paths.sqlitePath)}</div>` : "",
    stats.paths?.txtCachePath ? `<div class="subtle">txt-cache: ${escapeHtml(stats.paths.txtCachePath)}</div>` : "",
  ]
    .filter(Boolean)
    .join("");
  const startupLogs = (stats.startupLogs || [])
    .map((line) => `<div class="subtle">${escapeHtml(line)}</div>`)
    .join("");
  const manifestRows = (stats.manifests || [])
    .map((manifest) => {
      const fileName = String(manifest.file || "").split(/[\\/]/).pop() || "unknown";
      return `<div class="subtle">${escapeHtml(fileName)}</div>`;
    })
    .join("");
  const sourceCount = Array.isArray(stats.sourceOrder)
    ? stats.sourceOrder.length
    : Array.isArray(stats.sources)
      ? stats.sources.length
      : 0;

  els.stats.innerHTML = `
    <div class="summary-grid">
      <article class="summary-card summary-card-feature">
        <span class="summary-label">Library</span>
        <strong>${stats.totalItems}</strong>
        <small>Total indexed items</small>
      </article>
      <article class="summary-card">
        <span class="summary-label">Playback</span>
        <strong>${stats.withLocalMedia}</strong>
        <small>Playable locally</small>
      </article>
      <article class="summary-card">
        <span class="summary-label">Text</span>
        <strong>${stats.withLocalText}</strong>
        <small>Items with TXT</small>
      </article>
      <article class="summary-card">
        <span class="summary-label">Manifest Gap</span>
        <strong>${stats.localOnlyItems}</strong>
        <small>Local-only items</small>
      </article>
      <article class="summary-card">
        <span class="summary-label">Sources</span>
        <strong>${sourceCount}</strong>
        <small>Visible source buckets</small>
      </article>
    </div>
    <details class="stats-drawer">
      <summary>Diagnostics, manifests, and storage paths</summary>
      <div class="stats-drawer-grid">
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
        <article class="summary-card db-card summary-card-wide summary-card-light">
          <strong>Paths</strong>
          ${pathRows || '<div class="subtle">No runtime paths available</div>'}
        </article>
        <article class="summary-card db-card summary-card-wide summary-card-light">
          <strong>Startup Log</strong>
          ${startupLogs || '<div class="subtle">No startup logs available</div>'}
        </article>
      </div>
    </details>
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
  if (viewer.mediaObserver) {
    viewer.mediaObserver.disconnect();
    viewer.mediaObserver = null;
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

  viewer.mediaObserver = new IntersectionObserver(
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
    viewer.mediaObserver.observe(video);
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
  await viewer.renderDetail();
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
  els.resultMeta.textContent = total === 0 ? "0 items" : `${start}-${end} of ${total} items`;
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
      const posterUsername = formatPosterUsername(item);
      const cameoCount = cameoEntries(item).length;
      const sourceBadges = sourceLabelsForItem(item)
        .map((label) => `<span class="badge">${escapeHtml(label)}</span>`)
        .join("");
      const metadataBits = [
        item.date ? `<span>${escapeHtml(item.date)}</span>` : "",
        item.duration ? `<span>${escapeHtml(String(item.duration))}s</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      const peopleLabel = [
        posterUsername ? `<span>${escapeHtml(posterUsername)}</span>` : "",
        state.filters.showCameo && cameoCount ? `<span>cameo ${escapeHtml(String(cameoCount))}</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      const statBits = [
        typeof item.likeCount === "number" ? `<span>${heartIconMarkup()} ${escapeHtml(String(item.likeCount))}</span>` : "",
        typeof item.viewCount === "number" ? `<span>${eyeIconMarkup()} ${escapeHtml(String(item.viewCount))}</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      return `
        <article class="gallery-card ${item.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(item.id)}">
          ${createMediaMarkup(item)}
          <button
            type="button"
            class="gallery-select-button"
            data-id="${escapeHtml(item.id)}"
            aria-pressed="${item.id === state.selectedId ? "true" : "false"}"
            aria-label="Open details for ${escapeHtml(accessibleItemLabel(item))}"
          >
            <span class="sr-only">Open details for ${escapeHtml(accessibleItemLabel(item))}</span>
          </button>
          <div class="gallery-overlay">
            <div class="gallery-top">
              <div class="badge-row">
                ${sourceBadges}
                ${item.hasLocalMedia ? '<span class="badge good">local play</span>' : '<span class="badge warn">remote only</span>'}
                ${item.local?.txtRaw ? '<span class="badge">TXT</span>' : ""}
              </div>
            </div>
            <div class="gallery-bottom">
              <div class="gallery-title">${escapeHtml(title)}</div>
              <div class="gallery-meta-line">
                ${metadataBits || '<span>No timeline metadata</span>'}
              </div>
              <div class="gallery-footer">
                <div class="gallery-people">
                  ${peopleLabel || "<span>Open for more details</span>"}
                </div>
                <div class="gallery-stat-line">
                  ${statBits || "<span>tap to inspect</span>"}
                </div>
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

      if (pageAction === "first") state.pagination.offset = 0;
      if (pageAction === "prev") state.pagination.offset = Math.max(0, state.pagination.offset - state.pagination.limit);
      if (pageAction === "next") state.pagination.offset += state.pagination.limit;
      if (pageAction === "last") state.pagination.offset = Math.max(0, (state.pagination.totalPages - 1) * state.pagination.limit);
      state.pendingPageAction = pageAction;
      renderPagination();
      viewer.showPageLoadingModal();
      viewer.syncFiltersFromForm();
      releaseGalleryMedia();
      try {
        await viewer.fetchIndex({ reason: "page" });
        window.scrollTo({ top: 0, behavior: "smooth" });
      } finally {
        const remainingMs = viewer.MIN_PAGE_BUTTON_LOADING_MS - (Date.now() - startedAt);
        if (remainingMs > 0) {
          await viewer.delay(remainingMs);
        }
        state.pendingPageAction = null;
        viewer.hidePageLoadingModal();
        renderPagination();
      }
    });
  }
}

async function renderDetail() {
  if (!state.selectedId) {
    viewer.setSectionLoading(els.detailSection, false);
    els.detail.innerHTML = "Select a card to see its details here.";
    return;
  }

  const selectedId = state.selectedId;
  const requestToken = ++viewer.detailRequestToken;
  viewer.setSectionLoading(els.detailSection, true);
  let item;
  try {
    item = await viewer.fetchDetail(selectedId);
  } catch (error) {
    if (requestToken !== viewer.detailRequestToken || selectedId !== state.selectedId) {
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
    if (requestToken === viewer.detailRequestToken && selectedId === state.selectedId) {
      viewer.setSectionLoading(els.detailSection, false);
    }
  }

  if (requestToken !== viewer.detailRequestToken || selectedId !== state.selectedId) {
    return;
  }

  const localMediaUrl = item.mediaUrl || null;
  const posterUsername = formatPosterUsername(item);
  const cameoUsernames = formatCameoUsernames(item);
  const posterInline = posterUsername ? userInlineMarkup(posterUsername, avatarUrlForItem(item, "poster")) : "";
  const cameoInline = cameoInlineMarkup(item);
  const summaryChips = [
    item.hasLocalMedia ? '<span class="detail-chip accent">Local playback</span>' : '<span class="detail-chip">Remote links only</span>',
    item.date ? `<span class="detail-chip">${escapeHtml(item.date)}</span>` : "",
    sourceLabelsForItem(item).length ? `<span class="detail-chip">${escapeHtml(sourceLabelsForItem(item).join(", "))}</span>` : "",
    posterUsername ? `<span class="detail-chip">${userInlineMarkup(`posted by ${posterUsername}`, avatarUrlForItem(item, "poster"))}</span>` : "",
    typeof item.likeCount === "number" ? `<span class="detail-chip">${heartIconMarkup()} ${escapeHtml(item.likeCount)}</span>` : "",
    typeof item.viewCount === "number" ? `<span class="detail-chip">${eyeIconMarkup()} ${escapeHtml(item.viewCount)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const links = [
    item.previewUrl ? `<a class="detail-link" href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">Preview</a>` : "",
    item.downloadUrl ? `<a class="detail-link" href="${escapeHtml(item.downloadUrl)}" target="_blank" rel="noreferrer">Download</a>` : "",
    item.thumbUrl ? `<a class="detail-link" href="${escapeHtml(item.thumbUrl)}" target="_blank" rel="noreferrer">Thumbnail</a>` : "",
    item.permalink ? `<a class="detail-link" href="${escapeHtml(item.permalink)}" target="_blank" rel="noreferrer">Permalink</a>` : "",
  ]
    .filter(Boolean)
    .join("");
  const metadataResolution = metadataResolutionText(item);
  const metadataRatio = metadataRatioText(item);
  const sourceSummary = sourceLabelsForItem(item).join(", ");
  const manifestSupplementLines = [
    item.posterUsername && item.profileUserId
      ? `@${item.posterUsername} : ${item.profileUserId} (profile.user_id)`
      : "",
    ...(item.cameoProfiles || [])
      .filter((profile) => profile?.username && profile?.userId)
      .map((profile) => `@${profile.username} : ${profile.userId} (cameo profile.user_id)`),
  ]
    .filter(Boolean)
    .join("\n");

  els.detail.innerHTML = `
    ${
      localMediaUrl
        ? `<div class="detail-player"><video controls autoplay loop preload="metadata" playsinline src="${escapeHtml(localMediaUrl)}"></video></div>`
        : '<div class="detail-card"><div class="subtle">No local MP4 was found. Use external links below if available.</div></div>'
    }

    <div class="detail-hero">
      <div class="detail-hero-kicker">Selected clip</div>
      <h3 class="detail-hero-title">${escapeHtml(displayTitle(item))}</h3>
      <div class="detail-hero-chips">${summaryChips || '<span class="detail-chip">No summary metadata</span>'}</div>
    </div>

    <div class="detail-card">
      <h3>Prompt</h3>
      <div class="prompt-box">${escapeHtml(displayTitle(item) || "No prompt text available")}</div>
    </div>

    ${
      links
        ? `
          <div class="detail-card">
            <h3>Open related links</h3>
            <div class="detail-link-grid">${links}</div>
          </div>
        `
        : ""
    }

    <div class="detail-card">
      <h3>Overview</h3>
      <div class="detail-grid">
        <div class="detail-row"><span>source</span><strong>${escapeHtml(sourceSummary)}</strong></div>
        <div class="detail-row"><span>date</span><strong>${escapeHtml(item.date || "")}</strong></div>
        <div class="detail-row"><span>posted by</span><strong>${posterInline}</strong></div>
        ${state.filters.showCameo ? `<div class="detail-row"><span>cameo</span><strong class="detail-user-list">${cameoInline || escapeHtml(cameoUsernames)}</strong></div>` : ""}
        <div class="detail-row"><span class="detail-label-icon">${heartIconMarkup()}</span><strong>${escapeHtml(item.likeCount ?? "")}</strong></div>
        <div class="detail-row"><span class="detail-label-icon">${eyeIconMarkup()}</span><strong>${escapeHtml(item.viewCount ?? "")}</strong></div>
        <div class="detail-row"><span>duration</span><strong>${escapeHtml(String(item.duration || item.local?.parsed?.duration || ""))}</strong></div>
        <div class="detail-row"><span>resolution</span><strong data-detail-resolution>${escapeHtml(metadataResolution)}</strong></div>
        <div class="detail-row hidden" data-detail-metadata-resolution-row><span>metadata resolution</span><strong>${escapeHtml(metadataResolution)}</strong></div>
        <div class="detail-row"><span>ratio</span><strong data-detail-ratio>${escapeHtml(metadataRatio)}</strong></div>
        <div class="detail-row hidden" data-detail-metadata-ratio-row><span>metadata ratio</span><strong>${escapeHtml(metadataRatio)}</strong></div>
      </div>
    </div>

    ${
      item.local?.txtRaw
        ? `
          <div class="detail-card">
            <details class="detail-disclosure">
              <summary>TXT transcript</summary>
              <div class="detail-disclosure-content">
                <div class="subtle" style="margin-bottom:10px;">encoding: ${escapeHtml(item.local.txtEncoding || "unknown")}</div>
                <div class="text-box">${escapeHtml(item.local.txtRaw)}</div>
              </div>
            </details>
          </div>
        `
        : ""
    }

    ${
      manifestSupplementLines
        ? `
          <div class="detail-card">
            <details class="detail-disclosure">
              <summary>Manifest supplement</summary>
              <div class="detail-disclosure-content">
                <div class="text-box">${escapeHtml(manifestSupplementLines)}</div>
              </div>
            </details>
          </div>
        `
        : ""
    }

    ${
      item.debug
        ? `
          <div class="detail-card">
            <details class="detail-disclosure">
              <summary>Debug paths and manifest search fields</summary>
              <div class="detail-disclosure-content detail-stack">
                <div>
                  <div class="subtle" style="margin-bottom:10px;">Local files</div>
                  <div class="text-box">${escapeHtml(
                    [item.debug.localMediaPath, item.debug.localTxtPath].filter(Boolean).join("\n") || "No local files detected",
                  )}</div>
                </div>
                <div>
                  <div class="subtle" style="margin-bottom:10px;">Manifest search fields</div>
                  <div class="text-box">${escapeHtml(item.debug.manifestSearchText || "No manifest search fields")}</div>
                </div>
              </div>
            </details>
          </div>
        `
        : ""
    }
  `;

  const detailVideo = els.detail.querySelector(".detail-player video");
  if (detailVideo) {
    const resolutionValue = els.detail.querySelector("[data-detail-resolution]");
    const ratioValue = els.detail.querySelector("[data-detail-ratio]");
    const metadataResolutionRow = els.detail.querySelector("[data-detail-metadata-resolution-row]");
    const metadataRatioRow = els.detail.querySelector("[data-detail-metadata-ratio-row]");

    const syncActualMediaFacts = () => {
      const actualResolution = formatResolution(detailVideo.videoWidth, detailVideo.videoHeight);
      const actualRatio = formatAspectRatio(detailVideo.videoWidth, detailVideo.videoHeight);

      if (actualResolution && resolutionValue) {
        resolutionValue.textContent = actualResolution;
        if (metadataResolutionRow) {
          metadataResolutionRow.classList.toggle("hidden", !metadataResolution || metadataResolution === actualResolution);
        }
      }

      if (actualRatio && ratioValue) {
        ratioValue.textContent = actualRatio;
        if (metadataRatioRow) {
          metadataRatioRow.classList.toggle("hidden", !metadataRatio || metadataRatio === actualRatio);
        }
      }
    };

    if (detailVideo.readyState >= 1) {
      syncActualMediaFacts();
    } else {
      detailVideo.addEventListener("loadedmetadata", syncActualMediaFacts, { once: true });
    }
    detailVideo.play().catch(() => {});
  }
}

Object.assign(viewer, {
  displayTitle,
  accessibleItemLabel,
  escapeHtml,
  formatCameoUsernames,
  formatPosterUsername,
  releaseGalleryMedia,
  renderDetail,
  renderIndexError,
  renderIndexStatus,
  renderList,
  renderPagination,
  renderSourceNav,
  renderStats,
  sourceLabel,
  syncNavChips,
  updateActiveCard,
});
})();
