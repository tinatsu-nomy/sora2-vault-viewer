(() => {
const viewer = window.SoraViewer = window.SoraViewer || {};

function loadLegacyScript(src) {
  if (!viewer.__scriptLoads) {
    viewer.__scriptLoads = new Map();
  }
  if (viewer.__scriptLoads.has(src)) {
    return viewer.__scriptLoads.get(src);
  }

  const existing = [...document.scripts].find((script) => {
    try {
      const url = new URL(script.src, window.location.href);
      return url.pathname === src;
    } catch {
      return false;
    }
  });

  if (existing) {
    // If the script tag is already in the document by the time app.js runs,
    // it is either already executed (normal deferred boot) or in-flight from a
    // previous fallback injection. In both cases we should not block forever on
    // a load event that may have already fired.
    const ready = Promise.resolve();
    viewer.__scriptLoads.set(src, ready);
    return ready;
  }

  const pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.defer = true;
    script.onload = () => {
      script.dataset.loaded = "1";
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });

  viewer.__scriptLoads.set(src, pending);
  return pending;
}

async function ensureViewerModules() {
  if (!viewer.state) {
    await loadLegacyScript("/state.js");
  }
  if (!viewer.renderList || !viewer.renderDetail || !viewer.renderStats) {
    await loadLegacyScript("/render.js");
  }
  if (!viewer.fetchIndex || !viewer.fetchDetail) {
    await loadLegacyScript("/api.js");
  }
}

async function initViewerApp() {
  if (viewer.__appInitialized) return;
  await ensureViewerModules();
  if (viewer.__appInitialized) return;
  viewer.__appInitialized = true;
  viewer.restoreViewState();

  const { state, els } = viewer;

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

  function resetPagination() {
    state.pagination.offset = 0;
  }

  async function refresh() {
    syncFiltersFromForm();
    viewer.persistViewState();
    await viewer.fetchIndex({ reason: "search" });
  }

  async function clearDateFilters() {
    viewer.clearSearchDebounce();
    els.dateFrom.value = "";
    els.dateTo.value = "";
    updateDateResetButton();
    resetPagination();
    viewer.clearDataCaches();
    await refresh();
  }

  function applySourceFilter(source) {
    if (source === "all") {
      state.filters.sources = [...viewer.filterableSources()];
    } else if (state.filters.sources.includes(source)) {
      if (state.filters.sources.length === 1) {
        viewer.syncNavChips();
        return;
      }
      state.filters.sources = state.filters.sources.filter((item) => item !== source);
    } else {
      state.filters.sources = [...state.filters.sources, source].sort(viewer.compareSources);
    }

    viewer.syncNavChips();
    resetPagination();
    viewer.clearDataCaches();
    void refresh();
  }

  function applyCharGroupFilter(groupId) {
    const group = viewer.charSourceGroups().find((entry) => entry.id === groupId);
    if (!group?.sources.length) {
      viewer.syncNavChips();
      return;
    }

    const allSelected = group.sources.every((source) => state.filters.sources.includes(source));
    if (allSelected) {
      state.filters.sources = state.filters.sources.filter((source) => !group.sources.includes(source));
      if (!state.filters.sources.length) {
        const primarySources = viewer.primarySources();
        state.filters.sources = primarySources.length ? [...primarySources] : [];
      }
    } else {
      state.filters.sources = [...new Set([
        ...state.filters.sources,
        ...group.sources,
      ])].sort(viewer.compareSources);
    }

    viewer.syncNavChips();
    resetPagination();
    viewer.clearDataCaches();
    void refresh();
  }

  function applySourceGroupToggle(group, enabled) {
    const groupSources = group === "chars"
      ? viewer.charSources()
      : viewer.customSources();
    if (!groupSources.length) {
      viewer.syncNavChips();
      return;
    }

    if (enabled) {
      state.filters.sources = [...new Set([
        ...state.filters.sources,
        ...groupSources,
      ])].sort(viewer.compareSources);
    } else {
      state.filters.sources = state.filters.sources.filter((source) => !groupSources.includes(source));
      if (!state.filters.sources.length) {
        const primarySources = viewer.primarySources();
        state.filters.sources = primarySources.length ? [...primarySources] : [];
      }
    }

    viewer.syncNavChips();
    resetPagination();
    viewer.clearDataCaches();
    void refresh();
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

  Object.assign(viewer, {
    applyCharGroupFilter,
    applySourceGroupToggle,
    applySourceFilter,
    hideRebuildModal,
    refresh,
    resetPagination,
    showRebuildModal,
    syncFiltersFromForm,
    updateDateResetButton,
  });

  els.clearQueryButton.addEventListener("click", async () => {
    viewer.clearSearchDebounce();
    els.query.value = "";
    resetPagination();
    viewer.clearDataCaches();
    await refresh();
    els.query.focus();
  });

  els.query.addEventListener("input", () => {
    viewer.clearSearchDebounce();
    viewer.searchDebounceTimer = setTimeout(async () => {
      viewer.searchDebounceTimer = null;
      resetPagination();
      viewer.clearDataCaches();
      await refresh();
    }, 220);
  });

  els.query.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    viewer.clearSearchDebounce();
    resetPagination();
    viewer.clearDataCaches();
    await refresh();
  });

  els.sort.addEventListener("change", async () => {
    resetPagination();
    viewer.clearDataCaches();
    await refresh();
  });

  els.pageSize.addEventListener("change", async () => {
    resetPagination();
    viewer.clearDataCaches();
    await refresh();
  });

  for (const input of [els.dateFrom, els.dateTo]) {
    input.addEventListener("input", () => {
      updateDateResetButton();
      viewer.clearSearchDebounce();
      viewer.searchDebounceTimer = setTimeout(async () => {
        viewer.searchDebounceTimer = null;
        resetPagination();
        viewer.clearDataCaches();
        await refresh();
      }, 220);
    });
    input.addEventListener("change", async () => {
      updateDateResetButton();
      viewer.clearSearchDebounce();
      resetPagination();
      viewer.clearDataCaches();
      await refresh();
    });
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      viewer.clearSearchDebounce();
      resetPagination();
      viewer.clearDataCaches();
      await refresh();
    });
  }

  els.resetDateButton.addEventListener("click", async () => {
    await clearDateFilters();
  });

  els.topnav.addEventListener("click", (event) => {
    const chip = event.target.closest(".nav-chip");
    if (!chip) return;
    if (chip.classList.contains("source-menu-summary")) return;
    applySourceFilter(chip.dataset.source);
  });

  els.topnav.addEventListener("change", (event) => {
    const sourceGroupToggle = event.target.closest('[data-role="custom-sources-toggle"], [data-role="char-sources-toggle"]');
    if (sourceGroupToggle) {
      const group = sourceGroupToggle.getAttribute("data-role") === "char-sources-toggle" ? "chars" : "users";
      applySourceGroupToggle(group, sourceGroupToggle.checked);
      return;
    }
    const checkbox = event.target.closest(".source-menu-checkbox");
    if (!checkbox) return;
    if (checkbox.dataset.charGroup) {
      applyCharGroupFilter(checkbox.dataset.charGroup);
      return;
    }
    applySourceFilter(checkbox.dataset.source);
  });

  for (const checkbox of [els.localOnly, els.withText, els.withMedia]) {
    checkbox.addEventListener("change", async () => {
      resetPagination();
      viewer.clearDataCaches();
      await refresh();
    });
  }

  els.showCameo.addEventListener("change", async () => {
    syncFiltersFromForm();
    viewer.renderList();
    viewer.renderPagination();
    await viewer.renderDetail();
    viewer.persistViewState();
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
      viewer.clearDataCaches();
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

  viewer.syncFormFromState();
  updateDateResetButton();
  viewer.renderSourceNav();
  viewer.syncNavChips();
  void refresh();
}

void initViewerApp().catch((error) => {
  console.error("Failed to initialize viewer app", error);
});
})();
