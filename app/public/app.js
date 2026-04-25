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
    state.filters.remoteOnly = els.remoteOnly.checked;
    state.filters.manifestGapOnly = els.manifestGapOnly.checked;
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
    els.rebuildButton.textContent = isBusy ? "Rescanning…" : "Rescan";
    els.rebuildStatus.textContent = message;
    els.rebuildStatus.classList.toggle("busy", isBusy);
  }

  function setRenewOnStartState({ isBusy = false, scheduled = null } = {}) {
    if (!els.renewOnStartToggle) return;
    els.renewOnStartToggle.disabled = isBusy;
    if (typeof scheduled === "boolean") {
      els.renewOnStartToggle.checked = scheduled;
    }
  }

  async function loadRenewOnStartState() {
    if (!els.renewOnStartToggle) return;
    try {
      const response = await fetch("/api/renew-on-start");
      const payload = await response.json();
      if (!response.ok) {
        const message = payload?.details
          ? `${payload.error || "Failed to load renew-on-start state"}: ${payload.details}`
          : payload?.error || "Failed to load renew-on-start state";
        throw new Error(message);
      }
      setRenewOnStartState({ scheduled: Boolean(payload?.scheduled) });
    } catch {
      setRenewOnStartState({ scheduled: false });
    }
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

  function announceClipboardStatus(message) {
    if (!els.clipboardStatus) return;
    els.clipboardStatus.textContent = "";
    window.setTimeout(() => {
      els.clipboardStatus.textContent = String(message || "");
    }, 20);
  }

  async function copyTextToClipboard(text) {
    const normalizedText = String(text || "");
    if (!normalizedText.trim()) {
      throw new Error("Nothing to copy");
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(normalizedText);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = normalizedText;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (!ok) {
      throw new Error("Clipboard copy failed");
    }
  }

  function userSourceListText() {
    return viewer.customSources(viewer.normalizeSources(state.stats?.sources || []))
      .map((source) => viewer.sourceDisplayName(source))
      .join("\n");
  }

  function charSourceListText() {
    return viewer.charSourceGroups(viewer.normalizeSources(state.stats?.sources || []))
      .map((group) => group.label)
      .join("\n");
  }

  async function posterUserListText() {
    const queryString = viewer.buildQueryString();
    const params = new URLSearchParams(queryString);
    params.set("posterSort", els.copyPostersSort?.value || "name-asc");
    const response = await fetch(`/api/posters?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.details
        ? `${payload.error || "Failed to load poster usernames"}: ${payload.details}`
        : payload?.error || "Failed to load poster usernames";
      throw new Error(message);
    }
    return (payload?.items || [])
      .map((username) => `@${String(username || "").trim().replace(/^@+/, "")}`)
      .filter((value) => value !== "@")
      .join("\n");
  }

  async function identifierListText(field) {
    const queryString = viewer.buildQueryString();
    const params = new URLSearchParams(queryString);
    params.set("field", field);
    const response = await fetch(`/api/identifiers?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.details
        ? `${payload.error || "Failed to load identifiers"}: ${payload.details}`
        : payload?.error || "Failed to load identifiers";
      throw new Error(message);
    }
    return (payload?.items || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n");
  }

  async function handleSourceMenuCopy(button, kind) {
    const defaultLabel = button.dataset.defaultLabel || button.textContent || "Copy";
    button.dataset.defaultLabel = defaultLabel;
    const text = kind === "chars" ? charSourceListText() : userSourceListText();

    button.disabled = true;
    try {
      await copyTextToClipboard(text);
      button.textContent = "Copied";
      announceClipboardStatus(kind === "chars"
        ? "Copied visible character names to the clipboard."
        : "Copied visible user source names to the clipboard.");
    } catch (error) {
      button.textContent = "Failed";
      announceClipboardStatus(kind === "chars"
        ? "Could not copy character names. Try again."
        : "Could not copy user source names. Try again.");
    }

    window.setTimeout(() => {
      button.textContent = defaultLabel;
      button.disabled = false;
    }, 1200);
  }

  async function handlePosterCopy(button) {
    const defaultLabel = button.dataset.defaultLabel || button.textContent || "Copy posters";
    button.dataset.defaultLabel = defaultLabel;
    button.disabled = true;
    try {
      const text = await posterUserListText();
      await copyTextToClipboard(text);
      button.textContent = "Copied";
      announceClipboardStatus("Copied poster usernames to the clipboard.");
    } catch (error) {
      button.textContent = "Failed";
      announceClipboardStatus("Could not copy poster usernames. Try again or check clipboard permissions.");
    }

    window.setTimeout(() => {
      button.textContent = defaultLabel;
      button.disabled = false;
    }, 1200);
  }

  async function handleIdentifierCopy(button, field, label) {
    const defaultLabel = button.dataset.defaultLabel || button.textContent || `Copy ${label}`;
    button.dataset.defaultLabel = defaultLabel;
    button.disabled = true;
    try {
      const text = await identifierListText(field);
      await copyTextToClipboard(text);
      button.textContent = "Copied";
      announceClipboardStatus(`Copied ${label} values to the clipboard.`);
    } catch (error) {
      button.textContent = "Failed";
      announceClipboardStatus(`Could not copy ${label} values. Try again or check clipboard permissions.`);
    }

    window.setTimeout(() => {
      button.textContent = defaultLabel;
      button.disabled = false;
    }, 1200);
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

  els.copyPostersButton.addEventListener("click", () => {
    void handlePosterCopy(els.copyPostersButton);
  });
  els.copyPostIdsButton?.addEventListener("click", () => {
    void handleIdentifierCopy(els.copyPostIdsButton, "postId", "post_id");
  });
  els.copyGenIdsButton?.addEventListener("click", () => {
    void handleIdentifierCopy(els.copyGenIdsButton, "genId", "gen_id");
  });
  els.copyTaskIdsButton?.addEventListener("click", () => {
    void handleIdentifierCopy(els.copyTaskIdsButton, "taskId", "task_id");
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
    const copyButton = event.target.closest('[data-role="custom-sources-copy"], [data-role="char-sources-copy"]');
    if (copyButton) {
      event.preventDefault();
      event.stopPropagation();
      const kind = copyButton.getAttribute("data-role") === "char-sources-copy" ? "chars" : "users";
      void handleSourceMenuCopy(copyButton, kind);
      return;
    }
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

  els.detail.addEventListener("click", async (event) => {
    const avatarButton = event.target.closest("[data-avatar-description]");
    if (avatarButton) {
      event.preventDefault();
      const descriptionCard = avatarButton.closest("[data-avatar-description-card]");
      const descriptionPanel = descriptionCard?.querySelector("[data-avatar-description-panel]");
      if (!descriptionPanel) return;

      const expanded = avatarButton.getAttribute("aria-expanded") === "true";
      for (const button of els.detail.querySelectorAll("[data-avatar-description][aria-expanded='true']")) {
        if (button === avatarButton) continue;
        button.setAttribute("aria-expanded", "false");
      }
      for (const panel of els.detail.querySelectorAll("[data-avatar-description-panel]")) {
        if (panel === descriptionPanel) continue;
        panel.classList.add("hidden");
        panel.textContent = "";
      }

      if (expanded) {
        avatarButton.setAttribute("aria-expanded", "false");
        descriptionPanel.classList.add("hidden");
        descriptionPanel.textContent = "";
        return;
      }

      avatarButton.setAttribute("aria-expanded", "true");
      descriptionPanel.textContent = String(avatarButton.getAttribute("data-avatar-description") || "").trim();
      descriptionPanel.classList.remove("hidden");
      return;
    }

    const searchButton = event.target.closest("[data-search-query]");
    if (!searchButton) return;
    const query = String(searchButton.getAttribute("data-search-query") || "").trim();
    if (!query) return;
    viewer.clearSearchDebounce();
    els.query.value = query;
    resetPagination();
    viewer.clearDataCaches();
    await refresh();
    els.query.focus();
    els.query.select();
  });

  for (const checkbox of [els.localOnly, els.remoteOnly, els.manifestGapOnly, els.withText, els.withMedia]) {
    checkbox.addEventListener("change", async () => {
      if (checkbox === els.localOnly && els.localOnly.checked) {
        els.remoteOnly.checked = false;
      } else if (checkbox === els.remoteOnly && els.remoteOnly.checked) {
        els.localOnly.checked = false;
      }
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
    viewer.showPageLoadingModal({
      title: "Rescanning library…",
      message: "Rebuilding the SQLite cache from manifests and local files.",
    });
    void viewer.pollBuildProgress({
      title: "Rescanning library…",
      message: "Rebuilding the SQLite cache from manifests and local files.",
      showModalIfBuilding: true,
      onlyWhenNoCachedIndex: false,
    });
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
      viewer.hidePageLoadingModal();
      showRebuildModal("Rescan complete", "Manifest and local file scanning has finished.");
    } catch (error) {
      setRebuildState(false, "");
      viewer.hidePageLoadingModal();
      showRebuildModal("Rescan failed", error.message || "Manifest and local file scanning failed.");
    } finally {
      viewer.clearBuildProgressPoll();
      viewer.hidePageLoadingModal();
      if (els.rebuildButton.disabled) {
        setRebuildState(false, "");
      }
    }
  });

  els.renewOnStartToggle?.addEventListener("change", async () => {
    const scheduled = Boolean(els.renewOnStartToggle.checked);
    setRenewOnStartState({ isBusy: true, scheduled });
    try {
      const response = await fetch("/api/renew-on-start", {
        method: scheduled ? "POST" : "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) {
        const message = payload?.details
          ? `${payload.error || "Failed to update renew-on-start"}: ${payload.details}`
          : payload?.error || "Failed to update renew-on-start";
        throw new Error(message);
      }

      setRenewOnStartState({ scheduled: Boolean(payload?.scheduled) });
      showRebuildModal(
        scheduled ? "Renew scheduled" : "Renew canceled",
        scheduled
          ? "The next app launch will delete the cached SQLite database and rebuild it from manifests and local files."
          : "The next app launch will use the normal cached startup flow again.",
      );
    } catch (error) {
      setRenewOnStartState({ scheduled: !scheduled });
      showRebuildModal(
        "Renew update failed",
        error.message || "Could not update renew-on-start.",
      );
    } finally {
      setRenewOnStartState({ isBusy: false });
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
  void loadRenewOnStartState();
  void (async () => {
    void viewer.pollBuildProgress({
      title: "Building library…",
      message: "Scanning manifests and local files for the first load.",
      showModalIfBuilding: true,
      onlyWhenNoCachedIndex: true,
    });
    try {
      await refresh();
    } finally {
      viewer.clearBuildProgressPoll();
      viewer.hidePageLoadingModal();
    }
  })();
}

void initViewerApp().catch((error) => {
  console.error("Failed to initialize viewer app", error);
});
})();
