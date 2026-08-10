(() => {
  "use strict";

  let contextAlive = true;
  let invalidationLogged = false;

  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const nativeSetInterval = globalThis.setInterval.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

  function isInvalidatedError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("extension context invalidated");
  }

  function markInvalidated() {
    contextAlive = false;
    if (invalidationLogged) return;
    invalidationLogged = true;
    console.info(
      "[ChatGPT Optimizer] Extension context was reloaded; stale content-script timers stopped. Refresh this ChatGPT tab to reconnect it."
    );
  }

  function hasLiveContext() {
    if (!contextAlive) return false;
    try {
      if (!globalThis.chrome?.runtime?.id) {
        markInvalidated();
        return false;
      }
      return true;
    } catch {
      markInvalidated();
      return false;
    }
  }

  function handleAsyncError(error) {
    if (isInvalidatedError(error)) {
      markInvalidated();
      return;
    }
    console.error("[ChatGPT Optimizer] asynchronous content-script error", error);
  }

  function runGuarded(callback, args, clearTimer, getTimerId) {
    if (!hasLiveContext()) {
      const timerId = getTimerId();
      if (timerId !== undefined) clearTimer(timerId);
      return;
    }

    try {
      const result = callback(...args);
      if (result && typeof result.then === "function") {
        result.catch(handleAsyncError);
      }
      return result;
    } catch (error) {
      if (isInvalidatedError(error)) {
        markInvalidated();
        const timerId = getTimerId();
        if (timerId !== undefined) clearTimer(timerId);
        return;
      }
      throw error;
    }
  }

  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") {
      return nativeSetTimeout(callback, delay, ...args);
    }

    let timerId;
    timerId = nativeSetTimeout(
      () => runGuarded(callback, args, nativeClearTimeout, () => timerId),
      delay
    );
    return timerId;
  };

  globalThis.setInterval = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") {
      return nativeSetInterval(callback, delay, ...args);
    }

    let timerId;
    timerId = nativeSetInterval(
      () => runGuarded(callback, args, nativeClearInterval, () => timerId),
      delay
    );
    return timerId;
  };

  globalThis.addEventListener?.("unhandledrejection", (event) => {
    if (!isInvalidatedError(event.reason)) return;
    markInvalidated();
    event.preventDefault();
  });
})();
