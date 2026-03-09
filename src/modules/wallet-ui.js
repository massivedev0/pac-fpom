import { WALLET_CONNECT_TIMEOUT_MS } from "./constants.js";

/**
 * Creates UI controller for wallet connect modal and claim-panel status
 *
 * @param {object} options Controller dependencies
 * @param {any} options.rewardsState Mutable rewards slice from runtime state
 * @param {object} options.dom Wallet-related DOM nodes
 * @param {HTMLButtonElement | null} options.dom.topWalletButton Top-right connect button
 * @param {HTMLElement | null} options.dom.walletModal Wallet modal root element
 * @param {HTMLButtonElement | null} options.dom.walletModalClose Wallet modal close button
 * @param {HTMLElement | null} options.dom.walletModalSubtitle Wallet modal subtitle element
 * @param {HTMLElement | null} options.dom.walletOptions Wallet modal options container
 * @param {(message: string) => void} options.setClaimStatus Claim-status updater callback
 * @param {(message: string) => void} options.setWalletStatus Wallet-status updater callback
 * @param {(address: string) => boolean} options.isValidMassaAddress Address validator callback
 * @param {() => Promise<Array<any>>} options.discoverWalletCandidates Wallet-provider discovery callback
 * @param {(candidate: any, options: { timeoutMs: number; isValidAddress: (address: string) => boolean }) => Promise<Array<{address: string; account: any}>>} options.getCandidateAccounts Account resolver callback
 * @param {(candidate: any) => Promise<void>} options.resetWalletCandidate Wallet reset callback
 * @returns {{
 *   updateWalletStatusForClaimPanel: () => void;
 *   updateTopWalletButton: () => void;
 *   setTopWalletButtonVisible: (visible: boolean) => void;
 *   closeWalletModal: () => void;
 *   openWalletModal: () => Promise<void>;
 *   connectWalletAddress: (preferredWalletId?: string) => Promise<{status: "connected" | "select_account" | "cancelled"; address?: string}>;
 * }}
 */
export function createWalletUiController(options) {
  const {
    rewardsState,
    dom,
    setClaimStatus,
    setWalletStatus,
    isValidMassaAddress,
    discoverWalletCandidates,
    getCandidateAccounts,
    resetWalletCandidate,
  } = options;

  const {
    topWalletButton,
    walletModal,
    walletModalClose,
    walletModalSubtitle,
    walletOptions,
  } = dom;
  let activeWalletFlowId = 0;

  /**
   * Shortens long wallet address with a centered ellipsis
   *
   * @param {string} address Full wallet address
   * @param {number} [leading=8] Number of visible leading characters
   * @param {number} [trailing=8] Number of visible trailing characters
   * @returns {string} Compact address label
   */
  function formatCompactAddress(address, leading = 8, trailing = 8) {
    const normalized = String(address || "").trim();
    if (!normalized) {
      return "";
    }
    const minLength = leading + trailing + 3;
    if (normalized.length <= minLength) {
      return normalized;
    }
    return `${normalized.slice(0, leading)}...${normalized.slice(-trailing)}`;
  }

  /**
   * Refreshes wallet status line based on connection state
   */
  function updateWalletStatusForClaimPanel() {
    const connectedAddress = rewardsState.connectedAddress || "";
    if (isValidMassaAddress(connectedAddress)) {
      const walletName = rewardsState.walletProviderName || "Wallet";
      setWalletStatus(`${walletName} connected: ${connectedAddress}`);
      return;
    }
    setWalletStatus("Use the Connect Wallet button in the top-right corner");
  }

  /**
   * Refreshes top wallet button label and connected style
   */
  function updateTopWalletButton() {
    if (!topWalletButton) {
      return;
    }

    const connectedAddress = rewardsState.connectedAddress;
    if (!connectedAddress) {
      topWalletButton.classList.remove("connected");
      topWalletButton.textContent = "Connect Wallet";
      topWalletButton.title = "Connect Wallet";
      return;
    }

    topWalletButton.classList.add("connected");
    topWalletButton.textContent = formatCompactAddress(connectedAddress);
    topWalletButton.title = `${rewardsState.walletProviderName || "Wallet"}: ${connectedAddress}`;
  }

  /**
   * Shows or hides the top-right wallet button
   *
   * @param {boolean} visible Whether the button should be visible
   */
  function setTopWalletButtonVisible(visible) {
    if (!topWalletButton) {
      return;
    }
    topWalletButton.hidden = !visible;
    if (!visible) {
      closeWalletModal();
    }
  }

  /**
   * Loads and stores current wallet candidates
   *
   * @returns {Promise<Array<any>>}
   */
  async function refreshWalletProviders() {
    const candidates = await discoverWalletCandidates();
    rewardsState.walletProviders = candidates;
    return candidates;
  }

  /**
   * Returns wallet candidates already shown in the modal, refreshing only when list is empty
   *
   * @returns {Promise<Array<any>>} Wallet candidates for the current connect flow
   */
  async function getConnectCandidates() {
    if (Array.isArray(rewardsState.walletProviders) && rewardsState.walletProviders.length > 0) {
      return rewardsState.walletProviders;
    }
    return refreshWalletProviders();
  }

  /**
   * Stores connected wallet identity and refreshes wallet UI
   *
   * @param {any} candidate Selected wallet candidate
   * @param {string} address Connected wallet address
   * @param {any} [walletAccount=null] Connected wallet account object
   */
  function applyConnectedWallet(candidate, address, walletAccount = null) {
    rewardsState.connectedAddress = address.trim();
    rewardsState.walletProvider = candidate.wallet || candidate.provider || null;
    rewardsState.walletAccount = walletAccount;
    rewardsState.walletProviderName = candidate.name;
    rewardsState.pendingWalletCandidate = null;
    updateWalletStatusForClaimPanel();
    updateTopWalletButton();
    closeWalletModal();
  }

  /**
   * Toggles pending state for wallet modal actions
   *
   * @param {boolean} pending Whether modal actions are disabled
   */
  function setWalletModalPending(pending) {
    rewardsState.walletModalInFlight = pending;
    if (topWalletButton) {
      topWalletButton.disabled = pending;
    }
    if (walletOptions) {
      const actionButtons = walletOptions.querySelectorAll("button, select");
      for (const button of actionButtons) {
        button.disabled = pending;
      }
    }
  }

  /**
   * Sets wallet modal subtitle text visibility and content
   *
   * @param {string} text Subtitle text
   */
  function setWalletModalSubtitle(text) {
    if (!walletModalSubtitle) {
      return;
    }
    const normalized = String(text || "").trim();
    walletModalSubtitle.textContent = normalized;
    walletModalSubtitle.hidden = normalized.length === 0;
  }

  /**
   * Converts wallet-connect errors into user-facing status text
   *
   * @param {unknown} error Connect flow error
   * @returns {string} Human-readable status text
   */
  function formatWalletConnectErrorMessage(error) {
    const message = error instanceof Error ? error.message : "wallet_connect_failed";
    if (message === "wallet_connect_cancelled") {
      return "Wallet connection cancelled. Choose a wallet to try again";
    }
    if (message === "massa_wallet_not_found") {
      return "No wallets found. Install/enable Massa Wallet or Bearby, then reload";
    }
    if (message === "wallet_provider_not_found") {
      return "Selected wallet is no longer available. Choose a wallet to try again";
    }
    return `Wallet connection failed: ${message}`;
  }

  /**
   * Renders account picker UI for multi-account wallet case
   *
   * @param {any} candidate Selected wallet candidate metadata
   * @param {Array<{address: string; account: any}>} accountOptions Available wallet accounts
   */
  function renderWalletAccountPicker(candidate, accountOptions) {
    if (!walletOptions) {
      return;
    }

    setWalletModalSubtitle("Choose Massa account");
    walletOptions.textContent = "";

    const select = document.createElement("select");
    select.className = "wallet-account-select";
    for (const option of accountOptions) {
      const item = document.createElement("option");
      item.value = option.address;
      item.textContent = formatCompactAddress(option.address, 10, 6);
      select.append(item);
    }

    const actions = document.createElement("div");
    actions.className = "wallet-picker-actions";

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "wallet-picker-back-btn";
    backButton.textContent = "Back";
    backButton.addEventListener("click", () => {
      openWalletModal().catch(() => {});
    });

    const connectButton = document.createElement("button");
    connectButton.type = "button";
    connectButton.className = "wallet-option-btn";
    connectButton.textContent = "Connect selected";
    connectButton.addEventListener("click", () => {
      const selectedAddress = select.value;
      const selectedAccount = accountOptions.find((item) => item.address === selectedAddress);
      if (!selectedAccount) {
        setClaimStatus("Select a valid wallet account");
        return;
      }

      applyConnectedWallet(candidate, selectedAccount.address, selectedAccount.account);
      setClaimStatus("Wallet connected. You can claim now");
    });

    actions.append(backButton, connectButton);
    walletOptions.append(select, actions);
    setWalletStatus(`${candidate.name}: choose account`);
    setClaimStatus("Choose account and confirm");
  }

  /**
   * Renders the provider selection list in the wallet modal
   *
   * @param {Array<any>} candidates Available wallet candidates
   */
  function renderWalletProviderList(candidates) {
    if (!walletOptions || !walletModal) {
      return;
    }

    rewardsState.pendingWalletCandidate = null;
    setWalletModalSubtitle("");
    walletOptions.textContent = "";

    if (candidates.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wallet-options-empty";
      empty.textContent = "No wallets found. Install/enable Massa Wallet or Bearby, then reload.";
      walletOptions.append(empty);
      updateWalletStatusForClaimPanel();
      setClaimStatus("No wallets found. Install/enable Massa Wallet or Bearby, then reload.");
      walletModal.hidden = false;
      return;
    }

    for (const candidate of candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wallet-option-btn";
      button.textContent = candidate.name;
      button.addEventListener("click", () => {
        setClaimStatus(`Connecting ${candidate.name}...`);
        connectWalletAddress(candidate.id)
          .then((result) => {
            if (result.status === "connected") {
              setClaimStatus("Wallet connected. You can claim now");
            }
          })
          .catch((error) => {
            setClaimStatus(formatWalletConnectErrorMessage(error));
          });
      });
      walletOptions.append(button);
    }

    updateWalletStatusForClaimPanel();
    walletModal.hidden = false;
  }

  /**
   * Closes wallet selection modal
   */
  function closeWalletModal() {
    const hadPendingConnect = rewardsState.walletModalInFlight && Boolean(rewardsState.pendingWalletCandidate);
    activeWalletFlowId += 1;
    setWalletModalPending(false);
    const pendingCandidate = rewardsState.pendingWalletCandidate || null;
    rewardsState.pendingWalletCandidate = null;
    if (walletModal) {
      walletModal.hidden = true;
    }
    if (hadPendingConnect) {
      setClaimStatus("Wallet connection cancelled. Choose a wallet to try again");
    }
    if (pendingCandidate) {
      resetWalletCandidate(pendingCandidate).catch(() => {});
    }
  }

  /**
   * Starts a new wallet-modal async flow and invalidates older ones
   *
   * @returns {number} Active wallet flow id
   */
  function beginWalletFlow() {
    activeWalletFlowId += 1;
    return activeWalletFlowId;
  }

  /**
   * Checks whether an async wallet flow is still current
   *
   * @param {number} flowId Wallet flow id
   * @returns {boolean} True when async result still belongs to current modal flow
   */
  function isWalletFlowCurrent(flowId) {
    return flowId === activeWalletFlowId;
  }

  /**
   * Opens wallet modal and renders detected providers
   *
   * @returns {Promise<void>}
   */
  async function openWalletModal() {
    if (!walletModal || !walletOptions) {
      return;
    }
    const flowId = beginWalletFlow();

    setWalletModalSubtitle("");
    walletOptions.textContent = "";
    rewardsState.pendingWalletCandidate = null;
    setWalletModalPending(true);
    walletModal.hidden = false;

    const loading = document.createElement("p");
    loading.className = "wallet-options-empty";
    loading.textContent = "Searching available wallets...";
    walletOptions.append(loading);

    let candidates = [];
    try {
      candidates = await refreshWalletProviders();
    } catch {
      candidates = [];
    }

    if (!isWalletFlowCurrent(flowId)) {
      return;
    }
    walletOptions.textContent = "";
    setWalletModalPending(false);
    renderWalletProviderList(candidates);
  }

  /**
   * Connects wallet provider and stores selected account in rewards state
   *
   * @param {string} [preferredWalletId] Candidate id selected in modal
 * @returns {Promise<{status: "connected" | "select_account" | "cancelled"; address?: string}>}
  */
  async function connectWalletAddress(preferredWalletId = "") {
    const flowId = beginWalletFlow();
    setWalletModalPending(true);
    try {
      const candidates = await getConnectCandidates();
      if (!isWalletFlowCurrent(flowId)) {
        return { status: "cancelled" };
      }
      if (candidates.length === 0) {
        throw new Error("massa_wallet_not_found");
      }

      const hasExplicitSelection = preferredWalletId.trim().length > 0;
      const prioritizedCandidates = hasExplicitSelection
        ? candidates.filter((candidate) => candidate.id === preferredWalletId)
        : candidates;
      if (hasExplicitSelection && prioritizedCandidates.length === 0) {
        throw new Error("wallet_provider_not_found");
      }

      let lastError = null;

      for (const candidate of prioritizedCandidates) {
        try {
          rewardsState.pendingWalletCandidate = candidate;
          const connectedAccounts = await getCandidateAccounts(candidate, {
            timeoutMs: WALLET_CONNECT_TIMEOUT_MS,
            isValidAddress: isValidMassaAddress,
          });
          if (!isWalletFlowCurrent(flowId)) {
            return { status: "cancelled" };
          }

          if (connectedAccounts.length > 1) {
            renderWalletAccountPicker(candidate, connectedAccounts);
            return { status: "select_account" };
          }

          if (connectedAccounts.length === 0) {
            lastError = new Error("wallet_connect_cancelled");
            if (hasExplicitSelection) {
              await resetWalletCandidate(candidate);
              rewardsState.pendingWalletCandidate = null;
              break;
            }
            continue;
          }

          const address = connectedAccounts[0].address;
          const walletAccount = connectedAccounts[0].account;
          applyConnectedWallet(candidate, address, walletAccount);
          return { status: "connected", address };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("wallet_connect_failed");
          if (hasExplicitSelection) {
            await resetWalletCandidate(candidate);
          }
          rewardsState.pendingWalletCandidate = null;
          if (!isWalletFlowCurrent(flowId)) {
            return { status: "cancelled" };
          }
          if (hasExplicitSelection) {
            break;
          }
        }
      }

      if (hasExplicitSelection) {
        if (prioritizedCandidates[0]) {
          await resetWalletCandidate(prioritizedCandidates[0]);
        }
        rewardsState.pendingWalletCandidate = null;
        if (!isWalletFlowCurrent(flowId)) {
          return { status: "cancelled" };
        }
        renderWalletProviderList(candidates);
      }
      throw lastError || new Error("wallet_connect_failed");
    } finally {
      if (isWalletFlowCurrent(flowId)) {
        setWalletModalPending(false);
      }
    }
  }

  return {
    updateWalletStatusForClaimPanel,
    updateTopWalletButton,
    setTopWalletButtonVisible,
    closeWalletModal,
    openWalletModal,
    connectWalletAddress,
  };
}
