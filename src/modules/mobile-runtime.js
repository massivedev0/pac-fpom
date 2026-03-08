const MOBILE_VIEWPORT_MAX = 1024;
const MOBILE_TOUCH_SWIPE_THRESHOLD = 24;

/**
 * Detects whether current runtime should use mobile controls/layout
 *
 * @returns {boolean} True for coarse-pointer touch devices with mobile-sized viewport
 */
function detectMobileRuntime() {
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const hasTouchPoints = Number(window.navigator?.maxTouchPoints || 0) > 0;
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(window.navigator?.userAgent || "");
  const maxViewportSide = Math.max(window.innerWidth, window.innerHeight);
  return (coarsePointer || hasTouchPoints || mobileUserAgent) && maxViewportSide <= MOBILE_VIEWPORT_MAX;
}

/**
 * Checks whether the current viewport is landscape-oriented
 *
 * @returns {boolean} True when viewport width is greater than or equal to height
 */
function isLandscapeViewport() {
  return window.innerWidth >= window.innerHeight;
}

/**
 * Calculates the maximum visible shell width that fits current viewport
 *
 * @param {number} baseWidth Game base width in pixels
 * @param {number} baseHeight Game base height in pixels
 * @param {boolean} isMobile True when mobile layout spacing should be used
 * @returns {number} Visible shell width in CSS pixels
 */
function computeShellWidth(baseWidth, baseHeight, isMobile) {
  const aspect = baseWidth / baseHeight;
  const viewportPadding = isMobile ? 8 : 32;
  const borderAllowance = 12;
  const availableWidth = Math.max(280, window.innerWidth - viewportPadding - borderAllowance);
  const availableHeight = Math.max(220, window.innerHeight - viewportPadding - borderAllowance);
  return Math.max(280, Math.floor(Math.min(baseWidth, availableWidth, availableHeight * aspect)));
}

/**
 * Builds menu hint copy for current runtime
 *
 * @param {boolean} isMobile True when mobile hints should be shown
 * @param {boolean} isLandscape True when viewport is already landscape-oriented
 * @returns {{ html: string; primaryLine: string; secondaryLine: string; startLine: string }}
 */
function buildControlsCopy(isMobile, isLandscape) {
  if (isMobile) {
    return {
      html: isLandscape
        ? "Swipe or tap to move · Eat red orbs to hunt<br />Tap Pause to stop the run"
        : "Swipe or tap to move · Eat red orbs to hunt<br />Rotate to landscape for full view",
      primaryLine: "Swipe or tap to move  |  Eat red orbs to hunt",
      secondaryLine: isLandscape ? "Tap Pause to stop the run" : "Rotate to landscape for full view",
      startLine: "Tap Start Hunt",
    };
  }

  return {
    html: "Move: WASD / Arrows · Power hunt: eat red orbs<br />F: fullscreen · P: pause",
    primaryLine: "Move: WASD / Arrows  |  Power hunt: eat red orbs",
    secondaryLine: "F: fullscreen  |  P: pause",
    startLine: "Press Enter / Space or click Start Hunt",
  };
}

/**
 * Creates mobile runtime controller for layout, orientation, and swipe input
 *
 * @param {object} options Controller dependencies
 * @param {HTMLElement} options.body Document body
 * @param {HTMLElement | null} options.gameShell Main game shell element
 * @param {HTMLCanvasElement} options.canvas Game canvas
 * @param {HTMLElement | null} options.rotateOverlay Portrait rotate notice
 * @param {object} options.runtimeState Mutable runtime state object
 * @param {number} options.baseWidth Base game width
 * @param {number} options.baseHeight Base game height
 * @param {() => boolean} options.shouldAcceptSwipe Swipe gate callback
 * @param {(dir: "left" | "right" | "up" | "down") => void} options.onDirectionInput Direction input callback
 * @param {() => { x: number; y: number } | null} options.getTapReferencePoint Point used to resolve tap direction
 * @param {() => void} options.onRuntimeStateChange UI sync callback after layout/runtime updates
 * @returns {{
 *   applyLayout: () => void;
 *   installEventListeners: () => void;
 *   isMobileRuntime: () => boolean;
 *   requestLandscapeLock: () => Promise<boolean>;
 * }}
 */
export function createMobileRuntimeController(options) {
  const {
    body,
    gameShell,
    canvas,
    rotateOverlay,
    runtimeState,
    baseWidth,
    baseHeight,
    shouldAcceptSwipe,
    onDirectionInput,
    getTapReferencePoint,
    onRuntimeStateChange,
  } = options;

  let touchStartX = 0;
  let touchStartY = 0;
  let touchActive = false;

  /**
   * Updates runtime state flags and controls copy
   */
  function updateRuntimeState() {
    runtimeState.isMobile = detectMobileRuntime();
    runtimeState.isLandscape = isLandscapeViewport();
    runtimeState.rotateNoticeVisible = runtimeState.isMobile && !runtimeState.isLandscape;

    const controlsCopy = buildControlsCopy(runtimeState.isMobile, runtimeState.isLandscape);
    runtimeState.controlsHintHtml = controlsCopy.html;
    runtimeState.controlsBannerPrimary = controlsCopy.primaryLine;
    runtimeState.controlsBannerSecondary = controlsCopy.secondaryLine;
    runtimeState.controlsBannerStart = controlsCopy.startLine;

    body.classList.toggle("mobile-ui", runtimeState.isMobile);
    body.classList.toggle("mobile-portrait", runtimeState.rotateNoticeVisible);
    if (rotateOverlay) {
      rotateOverlay.hidden = !runtimeState.rotateNoticeVisible;
    }
  }

  /**
   * Applies responsive shell width so the full game fits visible viewport
   */
  function applyLayout() {
    updateRuntimeState();

    if (gameShell) {
      gameShell.style.width = `${computeShellWidth(baseWidth, baseHeight, runtimeState.isMobile)}px`;
    }

    onRuntimeStateChange();
  }

  /**
   * Requests mobile landscape lock when supported by the browser
   *
   * @returns {Promise<boolean>} True when lock call succeeded
   */
  async function requestLandscapeLock() {
    if (!runtimeState.isMobile) {
      return false;
    }

    const orientation = window.screen?.orientation;
    if (!orientation || typeof orientation.lock !== "function") {
      return false;
    }

    try {
      await orientation.lock("landscape");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts swipe tracking for touch movement controls
   *
   * @param {TouchEvent} event Browser touchstart event
   */
  function onTouchStart(event) {
    if (!runtimeState.isMobile || !shouldAcceptSwipe() || event.touches.length !== 1) {
      touchActive = false;
      return;
    }

    const touch = event.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchActive = true;
  }

  /**
   * Prevents browser panning while an active swipe gesture is in progress
   *
   * @param {TouchEvent} event Browser touchmove event
   */
  function onTouchMove(event) {
    if (!touchActive || !runtimeState.isMobile || !shouldAcceptSwipe()) {
      return;
    }
    event.preventDefault();
  }

  /**
   * Resolves swipe direction and forwards it as game input
   *
   * @param {TouchEvent} event Browser touchend event
   */
  function onTouchEnd(event) {
    if (!touchActive || !runtimeState.isMobile || !shouldAcceptSwipe() || event.changedTouches.length < 1) {
      touchActive = false;
      return;
    }

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    touchActive = false;
    if (Math.max(absX, absY) < MOBILE_TOUCH_SWIPE_THRESHOLD) {
      const referencePoint = getTapReferencePoint?.();
      if (!referencePoint) {
        return;
      }

      const tapDeltaX = touch.clientX - referencePoint.x;
      const tapDeltaY = touch.clientY - referencePoint.y;
      const tapAbsX = Math.abs(tapDeltaX);
      const tapAbsY = Math.abs(tapDeltaY);

      if (Math.max(tapAbsX, tapAbsY) < 10) {
        return;
      }

      event.preventDefault();
      if (tapAbsX > tapAbsY) {
        onDirectionInput(tapDeltaX > 0 ? "right" : "left");
        return;
      }

      onDirectionInput(tapDeltaY > 0 ? "down" : "up");
      return;
    }

    event.preventDefault();
    if (absX > absY) {
      onDirectionInput(deltaX > 0 ? "right" : "left");
      return;
    }
    onDirectionInput(deltaY > 0 ? "down" : "up");
  }

  /**
   * Clears active swipe state when touch sequence is interrupted
   */
  function onTouchCancel() {
    touchActive = false;
  }

  /**
   * Installs resize/orientation and touch listeners
   */
  function installEventListeners() {
    window.addEventListener("resize", applyLayout);
    window.addEventListener("orientationchange", () => {
      window.setTimeout(applyLayout, 80);
    });
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd, { passive: false });
    canvas.addEventListener("touchcancel", onTouchCancel, { passive: true });
    if (rotateOverlay) {
      rotateOverlay.addEventListener("click", () => {
        requestLandscapeLock().catch(() => {});
      });
    }
  }

  return {
    applyLayout,
    installEventListeners,
    isMobileRuntime: () => runtimeState.isMobile,
    requestLandscapeLock,
  };
}
