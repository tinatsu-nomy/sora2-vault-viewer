const state = {
  items: [],
  stats: null,
  selectedId: null,
  filters: {
    query: "",
    source: "all",
    sort: "date-desc",
    localOnly: false,
    withText: false,
    withMedia: false,
  },
};

const els = {
  query: document.querySelector("#query"),
  source: document.querySelector("#source"),
  sort: document.querySelector("#sort"),
  localOnly: document.querySelector("#localOnly"),
  withText: document.querySelector("#withText"),
  withMedia: document.querySelector("#withMedia"),
  searchButton: document.querySelector("#searchButton"),
  rebuildButton: document.querySelector("#rebuildButton"),
  list: document.querySelector("#list"),
  detail: document.querySelector("#detail"),
  stats: document.querySelector("#stats"),
  resultMeta: document.querySelector("#resultMeta"),
  navChips: [...document.querySelectorAll(".nav-chip")],
};

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

function sourceLabel(source) {
  if (source === "v2_profile") return "profile";
  if (source === "v2_drafts") return "drafts";
  if (source === "v2_liked") return "liked";
  return source || "unknown";
}

function syncNavChips() {
  for (const chip of els.navChips) {
    chip.classList.toggle("active", chip.dataset.source === state.filters.source);
  }
}

function buildQueryString() {
  const params = new URLSearchParams();
  if (state.filters.query) params.set("query", state.filters.query);
  if (state.filters.source && state.filters.source !== "all") params.set("source", state.filters.source);
  if (state.filters.sort) params.set("sort", state.filters.sort);
  if (state.filters.localOnly) params.set("localOnly", "1");
  if (state.filters.withText) params.set("withText", "1");
  if (state.filters.withMedia) params.set("withMedia", "1");
  params.set("limit", "180");
  return params.toString();
}

async function fetchIndex() {
  const response = await fetch(`/api/index?${buildQueryString()}`);
  const payload = await response.json();
  state.items = payload.items;
  state.stats = payload.stats;
  populateSourceFilter(payload.stats.sources);
  renderStats();
  renderList();
  if (!state.selectedId && state.items[0]) state.selectedId = state.items[0].id;
  if (state.selectedId && !state.items.find((item) => item.id === state.selectedId)) {
    state.selectedId = state.items[0]?.id || null;
  }
  await renderDetail();
}

async function fetchDetail(id) {
  const response = await fetch(`/api/item/${encodeURIComponent(id)}`);
  return response.json();
}

function populateSourceFilter(sources) {
  const previous = state.filters.source;
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
  els.source.value = sources.includes(previous) || previous === "all" ? previous : "all";
  state.filters.source = els.source.value;
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
          src="${escapeHtml(localMediaUrl)}"
          muted
          loop
          playsinline
          preload="metadata"
          autoplay
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

function renderList() {
  els.resultMeta.textContent = `${state.items.length} items`;
  els.list.innerHTML = state.items
    .map((item) => {
      const title = item.prompt || item.genId || item.postId || item.taskId || "Untitled";
      const localMediaUrl = item.localMediaPath ? `/media?path=${encodeURIComponent(item.localMediaPath)}` : null;
      return `
        <article class="gallery-card ${item.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(item.id)}">
          ${createMediaMarkup(item)}
          <div class="gallery-overlay">
            <div class="gallery-top">
              <div class="badge-row">
                <span class="badge">${escapeHtml(sourceLabel(item.source))}</span>
                ${item.hasLocalMedia ? `<span class="badge good">local play</span>` : `<span class="badge warn">remote only</span>`}
              </div>
            </div>

            <div class="gallery-bottom">
              <div class="gallery-title">${escapeHtml(title)}</div>
              <div class="meta-row">
                ${item.date ? `<span class="meta-pill">${escapeHtml(item.date)}</span>` : ""}
                ${item.duration ? `<span class="meta-pill">${escapeHtml(String(item.duration))}s</span>` : ""}
                ${item.postId ? `<span class="meta-pill">${escapeHtml(item.postId)}</span>` : ""}
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
      renderList();
      await renderDetail();
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
        ? `<div class="detail-player"><video controls loop preload="metadata" playsinline src="${escapeHtml(localMediaUrl)}"></video></div>`
        : `<div class="detail-card"><div class="subtle">No local MP4 was found. Use the external links below if needed.</div></div>`
    }

    <div class="detail-card">
      <h3>${escapeHtml(item.prompt || item.genId || item.postId || item.taskId || "Untitled")}</h3>
      <div class="detail-grid">
        <div class="detail-row"><span>source</span><strong>${escapeHtml(sourceLabel(item.source))}</strong></div>
        <div class="detail-row"><span>date</span><strong>${escapeHtml(item.date || "")}</strong></div>
        <div class="detail-row"><span>genId</span><strong>${escapeHtml(item.genId || item.generationId || "")}</strong></div>
        <div class="detail-row"><span>postId</span><strong>${escapeHtml(item.postId || "")}</strong></div>
        <div class="detail-row"><span>taskId</span><strong>${escapeHtml(item.taskId || "")}</strong></div>
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
}

function syncFiltersFromForm() {
  state.filters.query = els.query.value.trim();
  state.filters.source = els.source.value;
  state.filters.sort = els.sort.value;
  state.filters.localOnly = els.localOnly.checked;
  state.filters.withText = els.withText.checked;
  state.filters.withMedia = els.withMedia.checked;
}

function applySourceFilter(source) {
  state.filters.source = source;
  els.source.value = source;
  syncNavChips();
  refresh();
}

async function refresh() {
  syncFiltersFromForm();
  await fetchIndex();
}

els.searchButton.addEventListener("click", refresh);
els.query.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") await refresh();
});
els.source.addEventListener("change", refresh);
els.sort.addEventListener("change", refresh);

for (const chip of els.navChips) {
  chip.addEventListener("click", () => {
    applySourceFilter(chip.dataset.source);
  });
}

for (const checkbox of [els.localOnly, els.withText, els.withMedia]) {
  checkbox.addEventListener("change", refresh);
}

els.rebuildButton.addEventListener("click", async () => {
  els.rebuildButton.disabled = true;
  try {
    await fetch("/api/rebuild", { method: "POST" });
    await refresh();
  } finally {
    els.rebuildButton.disabled = false;
  }
});

refresh();
