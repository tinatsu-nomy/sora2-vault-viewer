function createIndexState({ initialIndex = null, buildIndex }) {
  const state = {
    current: initialIndex,
    buildPromise: null,
    buildProgress: {
      active: false,
      phase: "idle",
      message: "",
      detail: "",
      current: null,
      total: null,
      unit: null,
      startedAt: null,
      updatedAt: null,
      error: null,
    },
    lastError: null,
  };

  function cloneBuildProgress() {
    return { ...state.buildProgress };
  }

  function getCurrent() {
    return state.current;
  }

  function getBuildProgress() {
    return cloneBuildProgress();
  }

  function getLastError() {
    return state.lastError;
  }

  function isBuilding() {
    return Boolean(state.buildPromise);
  }

  function setCurrent(index) {
    state.current = index;
    state.lastError = null;
    return index;
  }

  function updateBuildProgress(patch = {}) {
    const nextUpdatedAt = patch.updatedAt || new Date().toISOString();
    state.buildProgress = {
      ...state.buildProgress,
      ...patch,
      updatedAt: nextUpdatedAt,
    };
    return cloneBuildProgress();
  }

  function startBuild() {
    if (state.buildPromise) {
      return state.buildPromise;
    }

    const startedAt = new Date().toISOString();
    updateBuildProgress({
      active: true,
      phase: "starting",
      message: "Preparing index rebuild...",
      detail: "",
      current: null,
      total: null,
      unit: null,
      startedAt,
      error: null,
    });

    state.buildPromise = Promise.resolve()
      .then(() => buildIndex({
        reportProgress(progress) {
          updateBuildProgress({
            ...progress,
            active: true,
            startedAt: state.buildProgress.startedAt || startedAt,
            error: null,
          });
        },
      }))
      .then((index) => {
        updateBuildProgress({
          active: false,
          phase: "done",
          message: "Index rebuild finished.",
          detail: "",
          error: null,
        });
        return setCurrent(index);
      })
      .catch((error) => {
        state.lastError = error;
        updateBuildProgress({
          active: false,
          phase: "error",
          message: "Index rebuild failed.",
          detail: "",
          error: error?.message || "Unknown error",
        });
        throw error;
      })
      .finally(() => {
        state.buildPromise = null;
      });

    return state.buildPromise;
  }

  async function ensureReady() {
    if (state.current) return state.current;
    if (state.buildPromise) return state.buildPromise;
    return startBuild();
  }

  return {
    ensureReady,
    getBuildProgress,
    getCurrent,
    getLastError,
    isBuilding,
    setCurrent,
    startBuild,
  };
}

module.exports = {
  createIndexState,
};
