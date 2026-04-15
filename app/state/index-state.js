function createIndexState({ initialIndex = null, buildIndex }) {
  const state = {
    current: initialIndex,
    buildPromise: null,
    lastError: null,
  };

  function getCurrent() {
    return state.current;
  }

  function getLastError() {
    return state.lastError;
  }

  function setCurrent(index) {
    state.current = index;
    state.lastError = null;
    return index;
  }

  function startBuild() {
    if (state.buildPromise) {
      return state.buildPromise;
    }

    state.buildPromise = Promise.resolve()
      .then(() => buildIndex())
      .then((index) => setCurrent(index))
      .catch((error) => {
        state.lastError = error;
        throw error;
      })
      .finally(() => {
        state.buildPromise = null;
      });

    return state.buildPromise;
  }

  async function ensureReady() {
    if (state.current) return state.current;
    return startBuild();
  }

  return {
    ensureReady,
    getCurrent,
    getLastError,
    setCurrent,
    startBuild,
  };
}

module.exports = {
  createIndexState,
};
