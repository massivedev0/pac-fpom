/**
 * Creates controller for menu overlay, win panel, and start button state
 *
 * @param {object} options Controller dependencies
 * @param {HTMLElement} options.menuOverlay Main overlay element
 * @param {HTMLButtonElement} options.startButton Overlay start/play-again button
 * @param {HTMLElement | null} options.rewardPanel Reward claim panel
 * @param {HTMLElement | null} options.rewardSummary Reward summary text
 * @param {(visible: boolean) => void} options.setTopWalletButtonVisible Top wallet button visibility callback
 * @param {() => void} options.onRewardsShown Hook called when rewards panel becomes visible
 * @returns {{
 *   hideOverlay: () => void;
 *   showOverlay: (input: { mode: string; title: string; buttonLabel: string; score: number }) => void;
 * }}
 */
export function createOverlayUiController(options) {
  const {
    menuOverlay,
    startButton,
    rewardPanel,
    rewardSummary,
    setTopWalletButtonVisible,
    onRewardsShown,
  } = options;

  /**
   * Hides overlay and any wallet entry-point attached to it
   */
  function hideOverlay() {
    menuOverlay.style.display = "none";
    menuOverlay.dataset.overlayMode = "hidden";
    if (rewardPanel) {
      rewardPanel.hidden = true;
    }
    setTopWalletButtonVisible(false);
  }

  /**
   * Shows title/game-over/win overlay and updates reward-panel state
   *
   * @param {{ mode: string; title: string; buttonLabel: string; score: number }} input Overlay payload
   */
  function showOverlay(input) {
    const { mode, title, buttonLabel, score } = input;
    const showRewards = mode === "won";
    const titleNode = menuOverlay.querySelector("h1");
    const subtitleNode = menuOverlay.querySelector(".subtitle");
    const hintNode = menuOverlay.querySelector(".hint");
    const linksNode = menuOverlay.querySelector(".menu-links");

    menuOverlay.style.display = "grid";
    menuOverlay.dataset.overlayMode = mode;
    if (titleNode) {
      titleNode.textContent = title;
    }

    if (subtitleNode) {
      subtitleNode.textContent = showRewards
        ? "Delusion-fueled momentum complete. Press start for another run."
        : "FPOM got rugged by memes. Press start to run it back.";
      subtitleNode.hidden = showRewards;
    }

    if (hintNode) {
      hintNode.hidden = showRewards;
    }
    if (linksNode) {
      linksNode.hidden = showRewards;
    }

    startButton.textContent = buttonLabel;

    if (rewardPanel) {
      rewardPanel.hidden = !showRewards;
    }
    if (showRewards && rewardSummary) {
      rewardSummary.textContent = `Round reward: ${score.toLocaleString("en-US")} FPOM`;
    }

    setTopWalletButtonVisible(true);
    if (showRewards) {
      onRewardsShown();
    }
  }

  return {
    hideOverlay,
    showOverlay,
  };
}
