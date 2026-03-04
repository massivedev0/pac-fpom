const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");
const startButton = document.getElementById("start-btn");
const menuOverlay = document.getElementById("menu-overlay");
const topWalletButton = document.getElementById("top-wallet-btn");
const walletModal = document.getElementById("wallet-modal");
const walletModalClose = document.getElementById("wallet-modal-close");
const walletModalSubtitle = document.getElementById("wallet-modal-subtitle");
const walletOptions = document.getElementById("wallet-options");
const rewardPanel = document.getElementById("reward-panel");
const rewardSummary = document.getElementById("reward-summary");
const promoTweetLink = document.getElementById("promo-tweet-link");
const xProfileInput = document.getElementById("x-profile");
const walletStatus = document.getElementById("wallet-status");
const claimButton = document.getElementById("claim-btn");
const claimStatus = document.getElementById("claim-status");
const devWinButton = document.getElementById("dev-win-btn");

const BASE_WIDTH = 960;
const BASE_HEIGHT = 640;
const TILE = 32;
const FIXED_DT = 1 / 60;

const REWARDS_API_TIMEOUT_MS = 11_000;
const DEFAULT_LOCAL_API = "http://127.0.0.1:8787";
const DEFAULT_DEBUG_WIN_SCORE = 106_050;
const DEFAULT_X_PROMO_TWEET = "https://x.com/massalabs";
const SESSION_EVENTS_BATCH_SIZE = 64;
const SESSION_EVENTS_BUFFER_LIMIT = 1200;
const SESSION_RETRY_DELAY_MS = 2500;
const WALLET_CONNECT_TIMEOUT_MS = 9000;
const WALLET_PROVIDER_MODULE_URL = "https://cdn.jsdelivr.net/npm/@massalabs/wallet-provider@3.3.0/+esm";
const CLAIM_VERIFICATION_MODE = "wallet_signature";

const SCORE_VALUES = {
  // Tuned so a full clear gives ~100k points (without heavy enemy farming).
  PELLET: 350,
  POWER_PELLET: 1500,
  ENEMY_BASE: 2500,
  ENEMY_COMBO_STEP: 1000,
  ROUND_CLEAR_BONUS: 12000,
};

const DIRS = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

const MAZE_TEMPLATE = [
  "############################",
  "#............##............#",
  "#.####.#####....#####.####.#",
  "#*####.#####.##.#####.####*#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.#####.##.#####.######",
  "######.##..........##.######",
  "######.##..........##.######",
  "######.##..........##.######",
  "#..........#....#..........#",
  "#.####.#####.##.#####.####.#",
  "#*..##................##..*#",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#..........................#",
  "############################",
];

const MAZE_ROWS = MAZE_TEMPLATE.length;
const MAZE_COLS = MAZE_TEMPLATE[0].length;
const MAZE_WIDTH = MAZE_COLS * TILE;
const MAZE_HEIGHT = MAZE_ROWS * TILE;
const MAZE_OFFSET_X = Math.floor((BASE_WIDTH - MAZE_WIDTH) / 2);
const MAZE_OFFSET_Y = Math.floor((BASE_HEIGHT - MAZE_HEIGHT) / 2);

const STATE = {
  mode: "title",
  score: 0,
  lives: 3,
  combo: 0,
  elapsed: 0,
  paused: false,
  powerTimer: 0,
  pelletsLeft: 0,
  inputDir: "left",
  maze: MAZE_TEMPLATE.map((row) => row.split("")),
  pellets: [],
  player: null,
  enemies: [],
  effects: [],
  roundResetTimer: 0,
  runStats: {
    startedAtMs: 0,
    pelletsEaten: 0,
    powerPelletsEaten: 0,
    enemiesEaten: 0,
  },
  rewards: {
    apiBase: "",
    promoTweetUrl: "",
    promoOverrideLocked: false,
    promoConfigFetchTried: false,
    sessionId: null,
    sessionRetryAtMs: 0,
    nextEventSeq: 0,
    eventBuffer: [],
    eventOverflow: false,
    eventFlushInFlight: false,
    claimInFlight: false,
    claimStatusText: "",
    walletProviders: [],
    connectedAddress: "",
    walletProviderName: "",
    walletProvider: null,
    walletAccount: null,
    walletModalInFlight: false,
  },
};

const images = {
  fpom: loadImage("../assets/fpom/fpom-logo-transparent.png"),
  doge: loadImage("../assets/memes/doge.png"),
  shiba: loadImage("../assets/memes/shiba.png"),
  pepe: loadImage("../assets/memes/pepe.png"),
};

const enemyTypes = ["doge", "shiba", "pepe", "doge", "shiba", "pepe"];

const keysPressed = new Set();
let audioCtx = null;
let animationFrame = null;
let lastTs = 0;
let accumulator = 0;
let walletProviderModulePromise = null;

function loadImage(src) {
  const img = new Image();
  // Resolve URLs relative to this module file (works on GitHub Pages subpaths).
  img.src = new URL(src, import.meta.url).href;
  return img;
}

function getRewardsApiBase() {
  if (window.__FPOM_REWARDS_API__) {
    return String(window.__FPOM_REWARDS_API__).replace(/\/+$/, "");
  }

  const queryApi = new URLSearchParams(window.location.search).get("rewardsApi");
  if (queryApi) {
    return queryApi.replace(/\/+$/, "");
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return DEFAULT_LOCAL_API;
  }

  return "";
}

function getPromoTweetOverrideUrl() {
  if (window.__FPOM_X_PROMO_TWEET__) {
    return String(window.__FPOM_X_PROMO_TWEET__).trim();
  }

  const queryValue = new URLSearchParams(window.location.search).get("promoTweet");
  if (queryValue) {
    return queryValue.trim();
  }

  return "";
}

function applyPromoTweetUrl(url) {
  const normalized = (url || "").trim() || DEFAULT_X_PROMO_TWEET;
  STATE.rewards.promoTweetUrl = normalized;

  if (promoTweetLink) {
    promoTweetLink.href = normalized;
    promoTweetLink.textContent = normalized;
  }
}

function isDebugToolsEnabled() {
  const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const isDevParamEnabled = new URLSearchParams(window.location.search).get("dev") === "1";
  return isLocalHost && isDevParamEnabled;
}

function setClaimStatus(text) {
  STATE.rewards.claimStatusText = text;
  if (claimStatus) {
    claimStatus.textContent = text;
  }
}

function setClaimControlsDisabled(disabled) {
  if (claimButton) {
    claimButton.disabled = disabled;
  }
  if (xProfileInput) {
    xProfileInput.disabled = disabled;
  }
}

function setWalletStatus(text) {
  if (walletStatus) {
    walletStatus.textContent = text;
  }
}

function updateWalletStatusForClaimPanel() {
  const connectedAddress = STATE.rewards.connectedAddress || "";
  if (isValidMassaAddress(connectedAddress)) {
    const walletName = STATE.rewards.walletProviderName || "Wallet";
    setWalletStatus(`${walletName} connected: ${connectedAddress}`);
    return;
  }
  setWalletStatus("Use the Connect Wallet button in the top-right corner");
}

function updateTopWalletButton() {
  if (!topWalletButton) {
    return;
  }

  const connectedAddress = STATE.rewards.connectedAddress;
  if (!connectedAddress) {
    topWalletButton.classList.remove("connected");
    topWalletButton.textContent = "Connect Wallet";
    return;
  }

  const shortAddress =
    connectedAddress.length > 18
      ? `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-6)}`
      : connectedAddress;

  topWalletButton.classList.add("connected");
  topWalletButton.textContent = `${STATE.rewards.walletProviderName || "Wallet"}: ${shortAddress}`;
}

function normalizeXProfile(input) {
  const trimmed = input.trim();
  const match = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return `https://x.com/${match[1].toLowerCase()}`;
}

function isValidMassaAddress(input) {
  return /^A[US][1-9A-HJ-NP-Za-km-z]{20,120}$/.test(input.trim());
}

function getInstallId() {
  const key = "fpom_install_id";
  const existing = window.localStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const created = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  window.localStorage.setItem(key, created);
  return created;
}

function getFingerprint() {
  const payload = {
    installId: getInstallId(),
    ua: navigator.userAgent || "",
    lang: navigator.language || "",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    platform: navigator.platform || "",
  };
  return JSON.stringify(payload);
}

function normalizeAddressResult(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const firstString = value.find((entry) => typeof entry === "string");
    if (typeof firstString === "string") {
      return firstString;
    }
    const firstObj = value.find((entry) => entry && typeof entry === "object");
    if (firstObj && typeof firstObj.address === "string") {
      return firstObj.address;
    }
    return "";
  }
  if (typeof value === "object" && typeof value.address === "string") {
    return value.address;
  }
  return "";
}

function normalizeSignatureResult(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "object") {
    if (typeof value.signature === "string" && value.signature.trim()) {
      return value.signature.trim();
    }
    if (typeof value.result === "string" && value.result.trim()) {
      return value.result.trim();
    }
    if (typeof value.signedMessage === "string" && value.signedMessage.trim()) {
      return value.signedMessage.trim();
    }
    return JSON.stringify(value);
  }
  return "";
}

function walletNameToLabel(rawName) {
  const normalized = String(rawName || "").toLowerCase();
  if (normalized.includes("massa")) {
    return "Massa Wallet";
  }
  if (normalized.includes("bearby")) {
    return "Bearby";
  }
  if (normalized.includes("meta")) {
    return "MetaMask";
  }
  return String(rawName || "Wallet");
}

function walletNameToId(rawName) {
  const normalized = String(rawName || "wallet")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "wallet";
}

function withTimeout(promise, timeoutMs, timeoutCode = "operation_timeout") {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutCode));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

async function loadWalletProviderModule() {
  if (walletProviderModulePromise) {
    return walletProviderModulePromise;
  }

  walletProviderModulePromise = import(WALLET_PROVIDER_MODULE_URL).catch((error) => {
    walletProviderModulePromise = null;
    throw error;
  });

  return walletProviderModulePromise;
}

function detectLegacyWalletProviders() {
  return [
    {
      id: "legacy:massa_wallet",
      name: "Massa Wallet",
      source: "legacy",
      provider: window.massaWallet || window.massa || window.massaWalletProvider,
    },
    {
      id: "legacy:bearby",
      name: "Bearby",
      source: "legacy",
      provider: window.bearby || window.bearbyWallet || window.web3?.wallet || window.web3,
    },
  ].filter((item) => item.provider);
}

async function detectWalletProviders() {
  const candidates = [];

  try {
    const module = await loadWalletProviderModule();
    if (typeof module?.getWallets === "function") {
      const wallets = await module.getWallets();
      wallets.forEach((wallet, index) => {
        const rawName = typeof wallet?.name === "function" ? wallet.name() : "";
        const label = walletNameToLabel(rawName);
        const safeId = walletNameToId(rawName);
        candidates.push({
          id: `sdk:${safeId}:${index}`,
          name: label,
          source: "wallet_provider",
          wallet,
        });
      });
    }
  } catch {
    // Fallback to legacy window-based providers.
  }

  const seen = new Set(candidates.map((entry) => entry.name.toLowerCase()));
  for (const legacyProvider of detectLegacyWalletProviders()) {
    const dedupeKey = legacyProvider.name.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    candidates.push(legacyProvider);
  }

  return candidates;
}

async function requestLegacyProviderAddress(provider) {
  const attempts = [
    async () => provider?.request?.({ method: "massa_requestAccounts" }),
    async () => provider?.request?.({ method: "wallet_requestAccounts" }),
    async () => provider?.request?.({ method: "eth_requestAccounts" }),
    async () => provider?.connect?.(),
    async () => provider?.enable?.(),
    async () => provider?.getAccount?.(),
    async () => provider?.getAccounts?.(),
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const address = normalizeAddressResult(result);
      if (address) {
        return address;
      }
    } catch {
      // Continue trying known methods
    }
  }

  return "";
}

async function requestWalletProviderAccounts(wallet) {
  if (!wallet) {
    return [];
  }

  try {
    if (typeof wallet.connect === "function") {
      await wallet.connect();
    }
  } catch {
    // Keep going and still try to read accounts.
  }

  try {
    const accounts = await wallet.accounts();
    if (!Array.isArray(accounts)) {
      return [];
    }

    const seen = new Set();
    const accountOptions = [];
    for (const account of accounts) {
      const address = normalizeAddressResult(account).trim();
      if (!isValidMassaAddress(address)) {
        continue;
      }
      if (seen.has(address)) {
        continue;
      }
      seen.add(address);
      accountOptions.push({ address, account });
    }
    return accountOptions;
  } catch {
    return [];
  }
}

async function refreshWalletProviders() {
  const candidates = await detectWalletProviders();
  STATE.rewards.walletProviders = candidates;
  return candidates;
}

function applyConnectedWallet(candidate, address, walletAccount = null) {
  STATE.rewards.connectedAddress = address.trim();
  STATE.rewards.walletProvider = candidate.wallet || candidate.provider || null;
  STATE.rewards.walletAccount = walletAccount;
  STATE.rewards.walletProviderName = candidate.name;
  updateWalletStatusForClaimPanel();
  updateTopWalletButton();
  closeWalletModal();
}

function setWalletModalPending(pending) {
  STATE.rewards.walletModalInFlight = pending;
  if (topWalletButton) {
    topWalletButton.disabled = pending;
  }
  if (walletModalClose) {
    walletModalClose.disabled = pending;
  }
  if (walletOptions) {
    const actionButtons = walletOptions.querySelectorAll("button, select");
    for (const btn of actionButtons) {
      btn.disabled = pending;
    }
  }
}

function setWalletModalSubtitle(text) {
  if (!walletModalSubtitle) {
    return;
  }
  const normalized = String(text || "").trim();
  walletModalSubtitle.textContent = normalized;
  walletModalSubtitle.hidden = normalized.length === 0;
}

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
    item.textContent = option.address;
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
  setWalletStatus("Massa Wallet: choose account");
  setClaimStatus("Choose account and confirm");
}

function closeWalletModal() {
  if (walletModal) {
    walletModal.hidden = true;
  }
}

async function openWalletModal() {
  if (!walletModal || !walletOptions) {
    return;
  }

  setWalletModalSubtitle("");
  walletOptions.textContent = "";
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

  walletOptions.textContent = "";
  setWalletModalPending(false);

  if (candidates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wallet-options-empty";
    empty.textContent = "No wallets found. Install/enable Massa Wallet or Bearby, then reload.";
    walletOptions.append(empty);
    updateWalletStatusForClaimPanel();
    setClaimStatus("No wallets found. Install/enable Massa Wallet or Bearby, then reload.");
    return;
  }

  for (const candidate of candidates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wallet-option-btn";
    btn.textContent = candidate.name;
    btn.addEventListener("click", () => {
      setClaimStatus(`Connecting ${candidate.name}...`);
      connectWalletAddress(candidate.id)
        .then((result) => {
          if (result.status === "connected") {
            setClaimStatus("Wallet connected. You can claim now");
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "wallet_connect_failed";
          setClaimStatus(`Wallet connection failed: ${message}`);
        });
    });
    walletOptions.append(btn);
  }

  updateWalletStatusForClaimPanel();

  walletModal.hidden = false;
}

async function connectWalletAddress(preferredWalletId = "") {
  setWalletModalPending(true);
  try {
    const candidates = await refreshWalletProviders();
    if (candidates.length === 0) {
      throw new Error("massa_wallet_not_found");
    }

    const prioritizedCandidates = preferredWalletId
      ? [
          ...candidates.filter((candidate) => candidate.id === preferredWalletId),
          ...candidates.filter((candidate) => candidate.id !== preferredWalletId),
        ]
      : candidates;

    for (const candidate of prioritizedCandidates) {
      try {
        let address = "";
        let walletAccount = null;

        if (candidate.source === "wallet_provider") {
          const connectedAccounts = await withTimeout(
            requestWalletProviderAccounts(candidate.wallet),
            WALLET_CONNECT_TIMEOUT_MS,
            "wallet_connect_timeout",
          );

          if (candidate.name === "Massa Wallet" && connectedAccounts.length > 1) {
            renderWalletAccountPicker(candidate, connectedAccounts);
            return { status: "select_account" };
          }

          if (connectedAccounts.length > 0) {
            address = connectedAccounts[0].address;
            walletAccount = connectedAccounts[0].account;
          }
        } else {
          address = await withTimeout(
            requestLegacyProviderAddress(candidate.provider),
            WALLET_CONNECT_TIMEOUT_MS,
            "wallet_connect_timeout",
          );
        }

        if (!isValidMassaAddress(address)) {
          continue;
        }

        applyConnectedWallet(candidate, address, walletAccount);
        return { status: "connected", address };
      } catch {
        // Try next provider if this one is unavailable or timed out.
      }
    }

    throw new Error("wallet_connect_failed");
  } finally {
    setWalletModalPending(false);
  }
}

async function signWithWallet(challenge) {
  const account = STATE.rewards.walletAccount;
  if (account && typeof account.sign === "function") {
    try {
      const signatureResult = await account.sign(new TextEncoder().encode(challenge));
      const normalized = normalizeSignatureResult(signatureResult);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Fallback to provider-level methods below.
    }
  }

  const provider = STATE.rewards.walletProvider;
  if (!provider) {
    throw new Error("wallet_not_connected");
  }

  const methods = [
    async () => provider?.request?.({ method: "massa_signMessage", params: [challenge] }),
    async () => provider?.request?.({ method: "personal_sign", params: [challenge, STATE.rewards.connectedAddress] }),
    async () => provider?.signMessage?.(challenge),
    async () => provider?.sign?.(challenge),
  ];

  for (const method of methods) {
    try {
      const result = await method();
      const normalized = normalizeSignatureResult(result);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Keep trying known methods
    }
  }

  throw new Error("wallet_sign_failed");
}

async function apiPost(path, body) {
  const base = STATE.rewards.apiBase;
  if (!base) {
    throw new Error("Rewards API is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REWARDS_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorCode = json.error ? String(json.error) : `http_${response.status}`;
      throw new Error(errorCode);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(path) {
  const base = STATE.rewards.apiBase;
  if (!base) {
    throw new Error("Rewards API is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REWARDS_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: "GET",
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorCode = json.error ? String(json.error) : `http_${response.status}`;
      throw new Error(errorCode);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function syncPromoTweetFromBackend() {
  if (!STATE.rewards.apiBase) {
    return;
  }

  try {
    const payload = await apiGet("/public/config");
    if (payload && typeof payload.xPromoTweet === "string" && payload.xPromoTweet.trim()) {
      applyPromoTweetUrl(payload.xPromoTweet.trim());
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    console.warn(`Failed to load promo tweet from backend: ${reason}`);
  }
}

function maybeSyncPromoTweetFromBackend() {
  if (!STATE.rewards.apiBase) {
    return;
  }
  if (STATE.rewards.promoOverrideLocked) {
    return;
  }
  if (STATE.rewards.promoConfigFetchTried) {
    return;
  }

  STATE.rewards.promoConfigFetchTried = true;
  syncPromoTweetFromBackend().catch(() => {});
}

function getRunElapsedMs() {
  if (!STATE.runStats.startedAtMs) {
    return 0;
  }
  return Math.max(1, Math.floor(performance.now() - STATE.runStats.startedAtMs));
}

function queueSessionEvent(type, payload = {}) {
  if (!STATE.rewards.apiBase) {
    return;
  }

  if (STATE.rewards.eventBuffer.length >= SESSION_EVENTS_BUFFER_LIMIT) {
    STATE.rewards.eventOverflow = true;
    STATE.rewards.eventBuffer.shift();
  }

  STATE.rewards.eventBuffer.push({
    type,
    atMs: getRunElapsedMs(),
    score: STATE.score,
    payload,
  });
}

async function flushSessionEvents(force = false) {
  if (!STATE.rewards.apiBase) {
    return;
  }
  if (STATE.rewards.eventFlushInFlight) {
    return;
  }
  if (STATE.rewards.eventBuffer.length === 0) {
    return;
  }

  STATE.rewards.eventFlushInFlight = true;
  try {
    const sessionId = await ensureRewardsSession(force);
    if (!sessionId) {
      if (force) {
        throw new Error("session_unavailable");
      }
      return;
    }

    while (STATE.rewards.eventBuffer.length > 0) {
      const batch = STATE.rewards.eventBuffer.slice(0, SESSION_EVENTS_BATCH_SIZE);
      await apiPost("/session/event", {
        sessionId,
        startSeq: STATE.rewards.nextEventSeq,
        events: batch,
      });
      STATE.rewards.eventBuffer.splice(0, batch.length);
      STATE.rewards.nextEventSeq += batch.length;
    }
  } finally {
    STATE.rewards.eventFlushInFlight = false;
  }
}

async function ensureRewardsSession(force = false) {
  if (STATE.rewards.sessionId) {
    return STATE.rewards.sessionId;
  }
  if (!STATE.rewards.apiBase) {
    return null;
  }

  const now = performance.now();
  if (!force && STATE.rewards.sessionRetryAtMs > now) {
    return null;
  }

  try {
    const session = await apiPost("/session/start", { fingerprint: getFingerprint() });
    STATE.rewards.sessionId = session.sessionId;
    STATE.rewards.sessionRetryAtMs = 0;
    return STATE.rewards.sessionId;
  } catch (error) {
    STATE.rewards.sessionRetryAtMs = now + SESSION_RETRY_DELAY_MS;
    throw error;
  }
}

function getRunSummary() {
  const durationMs = getRunElapsedMs();
  return {
    won: STATE.mode === "won",
    durationMs,
    pelletsEaten: STATE.runStats.pelletsEaten,
    powerPelletsEaten: STATE.runStats.powerPelletsEaten,
    enemiesEaten: STATE.runStats.enemiesEaten,
    finalScoreClient: STATE.score,
    telemetryEventsTotal: STATE.rewards.nextEventSeq + STATE.rewards.eventBuffer.length,
    telemetryOverflow: STATE.rewards.eventOverflow,
  };
}

function triggerDebugVictory() {
  if (!isDebugToolsEnabled()) {
    return;
  }
  if (STATE.mode !== "playing") {
    return;
  }

  for (const pellet of STATE.pellets) {
    pellet.eaten = true;
  }
  STATE.pelletsLeft = 0;
  STATE.runStats.pelletsEaten = 233;
  STATE.runStats.powerPelletsEaten = 5;
  if (STATE.runStats.enemiesEaten < 2) {
    STATE.runStats.enemiesEaten = 2;
  }
  STATE.score = Math.max(STATE.score, DEFAULT_DEBUG_WIN_SCORE);
  STATE.mode = "won";
  queueSessionEvent("run_won", {
    source: "debug_button",
    finalScore: STATE.score,
    durationMs: getRunElapsedMs(),
  });
  setClaimStatus("Debug victory enabled: submit reward claim");
  showOverlay("FPOM Wins", "Play Again");
}

function initMaze() {
  STATE.pellets = [];
  STATE.pelletsLeft = 0;

  for (let row = 0; row < MAZE_ROWS; row += 1) {
    for (let col = 0; col < MAZE_COLS; col += 1) {
      const ch = STATE.maze[row][col];
      if (ch === "." || ch === "*") {
        const forcePower = row === 13 && col === 14;
        STATE.pellets.push({
          row,
          col,
          power: ch === "*" || forcePower,
          eaten: false,
        });
        STATE.pelletsLeft += 1;
      }
    }
  }
}

function tileCenter(col, row) {
  return {
    x: MAZE_OFFSET_X + col * TILE + TILE / 2,
    y: MAZE_OFFSET_Y + row * TILE + TILE / 2,
  };
}

function createPlayer() {
  const spawn = tileCenter(14, 13);
  return {
    x: spawn.x,
    y: spawn.y,
    r: 13,
    speed: 128,
    dir: "left",
    desiredDir: "left",
    mouthPhase: 0,
    alive: true,
  };
}

function createEnemy(type, idx) {
  const spawnPoints = [
    { col: 13, row: 8, dir: "left" },
    { col: 14, row: 8, dir: "right" },
    { col: 12, row: 9, dir: "up" },
    { col: 15, row: 9, dir: "down" },
    { col: 11, row: 10, dir: "right" },
    { col: 16, row: 10, dir: "left" },
  ];
  const point = spawnPoints[idx] ?? spawnPoints[0];
  const spawn = tileCenter(point.col, point.row);
  return {
    type,
    x: spawn.x,
    y: spawn.y,
    r: 12,
    speed: 98 + idx * 3,
    dir: point.dir,
    vulnerable: false,
    respawnTimer: 0,
    blink: 0,
  };
}

function resetEntities() {
  STATE.player = createPlayer();
  STATE.enemies = enemyTypes.map((type, i) => createEnemy(type, i));
  STATE.powerTimer = 0;
  STATE.combo = 0;
  STATE.roundResetTimer = 0;
}

function startNewGame() {
  STATE.mode = "playing";
  STATE.score = 0;
  STATE.lives = 3;
  STATE.elapsed = 0;
  STATE.paused = false;
  STATE.effects = [];
  STATE.runStats.startedAtMs = performance.now();
  STATE.runStats.pelletsEaten = 0;
  STATE.runStats.powerPelletsEaten = 0;
  STATE.runStats.enemiesEaten = 0;
  STATE.rewards.sessionId = null;
  STATE.rewards.sessionRetryAtMs = 0;
  STATE.rewards.nextEventSeq = 0;
  STATE.rewards.eventBuffer = [];
  STATE.rewards.eventOverflow = false;
  STATE.rewards.eventFlushInFlight = false;
  STATE.maze = MAZE_TEMPLATE.map((row) => row.split(""));
  initMaze();
  resetEntities();
  queueSessionEvent("run_started", {
    lives: STATE.lives,
    pelletsLeft: STATE.pelletsLeft,
  });
  setClaimStatus("");
  if (rewardPanel) {
    rewardPanel.hidden = true;
  }
  hideOverlay();
  ensureAudioContext();
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  playTone(460, 0.09, "triangle", 0.04);
}

function resetRound() {
  resetEntities();
}

function hideOverlay() {
  menuOverlay.style.display = "none";
}

function showOverlay(text, buttonLabel) {
  menuOverlay.style.display = "grid";
  const title = menuOverlay.querySelector("h1");
  const subtitle = menuOverlay.querySelector(".subtitle");
  const hint = menuOverlay.querySelector(".hint");
  const showRewards = STATE.mode === "won";
  title.textContent = text;
  subtitle.textContent =
    STATE.mode === "won"
      ? "Delusion-fueled momentum complete. Press start for another run."
      : "FPOM got rugged by memes. Press start to run it back.";
  subtitle.hidden = showRewards;
  if (hint) {
    hint.hidden = showRewards;
  }
  startButton.textContent = buttonLabel;

  if (rewardPanel) {
    rewardPanel.hidden = !showRewards;
    if (showRewards && rewardSummary) {
      rewardSummary.textContent = `Round reward: ${STATE.score.toLocaleString("en-US")} FPOM`;
    }
  }

  if (showRewards) {
    maybeSyncPromoTweetFromBackend();
  }
}

function ensureAudioContext() {
  if (audioCtx) {
    return;
  }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    return;
  }
  audioCtx = new AudioContext();
}

function playTone(freq, duration = 0.08, type = "square", volume = 0.05) {
  if (!audioCtx || audioCtx.state === "suspended") {
    return;
  }
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function worldToTile(x, y) {
  return {
    col: Math.floor((x - MAZE_OFFSET_X) / TILE),
    row: Math.floor((y - MAZE_OFFSET_Y) / TILE),
  };
}

function tileIsWall(col, row) {
  if (col < 0 || row < 0 || col >= MAZE_COLS || row >= MAZE_ROWS) {
    return true;
  }
  return STATE.maze[row][col] === "#";
}

function isNearCenter(entity, tolerance = 2.1) {
  const tile = worldToTile(entity.x, entity.y);
  const center = tileCenter(tile.col, tile.row);
  return (
    Math.abs(center.x - entity.x) <= tolerance &&
    Math.abs(center.y - entity.y) <= tolerance
  );
}

function canMove(entity, dir) {
  const vec = DIRS[dir];
  const step = 4;
  const nx = entity.x + vec.x * step;
  const ny = entity.y + vec.y * step;
  const r = Math.max(5, entity.r - 4);

  const checks = [
    worldToTile(nx - r, ny - r),
    worldToTile(nx + r, ny - r),
    worldToTile(nx - r, ny + r),
    worldToTile(nx + r, ny + r),
  ];

  return checks.every((tile) => !tileIsWall(tile.col, tile.row));
}

function snapToGrid(entity) {
  const tile = worldToTile(entity.x, entity.y);
  const center = tileCenter(tile.col, tile.row);
  entity.x = center.x;
  entity.y = center.y;
}

function tryApplyDesiredDirection(forceSnap = false) {
  const player = STATE.player;
  if (!forceSnap && player.desiredDir === player.dir) {
    return false;
  }
  if (!canMove(player, player.desiredDir)) {
    return false;
  }
  if (forceSnap || isNearCenter(player, 3.2)) {
    snapToGrid(player);
    player.dir = player.desiredDir;
    return true;
  }
  return false;
}

function updatePlayer(dt) {
  const player = STATE.player;
  if (!player.alive) return;
  if (player.desiredDir === oppositeDirection(player.dir) && canMove(player, player.desiredDir)) {
    player.dir = player.desiredDir;
  } else {
    tryApplyDesiredDirection(false);
  }

  if (!canMove(player, player.dir)) {
    snapToGrid(player);
    const changed = tryApplyDesiredDirection(true);
    if (!changed && !canMove(player, player.dir)) return;
  }

  const vec = DIRS[player.dir];
  player.x += vec.x * player.speed * dt;
  player.y += vec.y * player.speed * dt;
  player.mouthPhase += dt * 12;
}

function oppositeDirection(dir) {
  if (dir === "left") return "right";
  if (dir === "right") return "left";
  if (dir === "up") return "down";
  return "up";
}

function updateEnemy(enemy, dt) {
  if (enemy.respawnTimer > 0) {
    enemy.respawnTimer -= dt;
    return;
  }

  const chooseDirection = () => {
    const dirs = Object.keys(DIRS).filter((dir) => canMove(enemy, dir));
    const noBacktrack = dirs.filter((dir) => dir !== oppositeDirection(enemy.dir));
    const options = noBacktrack.length > 0 ? noBacktrack : dirs;
    if (options.length === 0) return;

    if (STATE.powerTimer > 0) {
      enemy.dir = options[Math.floor(Math.random() * options.length)];
    } else {
      if (Math.random() < 0.28) {
        enemy.dir = options[Math.floor(Math.random() * options.length)];
        return;
      }
      const player = STATE.player;
      let bestDir = options[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const dir of options) {
        const vec = DIRS[dir];
        const tx = enemy.x + vec.x * TILE * 1.2;
        const ty = enemy.y + vec.y * TILE * 1.2;
        const dist = (player.x - tx) ** 2 + (player.y - ty) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          bestDir = dir;
        }
      }
      enemy.dir = bestDir;
    }
  };

  if (isNearCenter(enemy, 0.45)) {
    snapToGrid(enemy);
    chooseDirection();
  } else if (!canMove(enemy, enemy.dir)) {
    snapToGrid(enemy);
    chooseDirection();
  }

  const speed = STATE.powerTimer > 0 ? enemy.speed * 0.72 : enemy.speed;
  if (canMove(enemy, enemy.dir)) {
    const vec = DIRS[enemy.dir];
    enemy.x += vec.x * speed * dt;
    enemy.y += vec.y * speed * dt;
  }
  enemy.blink += dt;
}

function spawnShatterEffect(x, y, radius, spriteKey, amount = 18) {
  const image = images[spriteKey];
  const imgW = image?.naturalWidth || 64;
  const imgH = image?.naturalHeight || 64;

  for (let i = 0; i < amount; i += 1) {
    const angle = (Math.PI * 2 * i) / amount + Math.random() * 0.5;
    const speed = 90 + Math.random() * 170;
    const size = 4 + Math.random() * 8;
    const srcSize = Math.max(6, Math.floor((Math.random() * 0.12 + 0.04) * Math.min(imgW, imgH)));
    const life = 0.82 + Math.random() * 0.38;
    STATE.effects.push({
      kind: "shard",
      spriteKey,
      x: x + Math.cos(angle) * (radius * 0.18),
      y: y + Math.sin(angle) * (radius * 0.18),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 30,
      size,
      life,
      maxLife: life,
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 9,
      srcX: Math.floor(Math.random() * Math.max(1, imgW - srcSize)),
      srcY: Math.floor(Math.random() * Math.max(1, imgH - srcSize)),
      srcSize,
    });
  }
}

function updateEffects(dt) {
  for (const e of STATE.effects) {
    e.life -= dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.vy += 260 * dt;
    e.rotation += e.spin * dt;
  }
  STATE.effects = STATE.effects.filter((e) => e.life > 0);
}

function eatPellets() {
  const player = STATE.player;
  let pelletsEatenThisTick = 0;
  let powerPelletsEatenThisTick = 0;

  for (const pellet of STATE.pellets) {
    if (pellet.eaten) continue;
    const center = tileCenter(pellet.col, pellet.row);
    const hitDist = pellet.power ? 19 : 16;
    if (Math.hypot(player.x - center.x, player.y - center.y) <= hitDist) {
      pellet.eaten = true;
      STATE.pelletsLeft -= 1;
      if (pellet.power) {
        powerPelletsEatenThisTick += 1;
        STATE.runStats.powerPelletsEaten += 1;
        STATE.score += SCORE_VALUES.POWER_PELLET;
        STATE.powerTimer = 8;
        STATE.combo = 0;
        playTone(620, 0.08, "triangle", 0.05);
        playTone(860, 0.11, "triangle", 0.045);
      } else {
        pelletsEatenThisTick += 1;
        STATE.runStats.pelletsEaten += 1;
        STATE.score += SCORE_VALUES.PELLET;
        playTone(250, 0.04, "square", 0.02);
      }
    }
  }

  if (pelletsEatenThisTick > 0 || powerPelletsEatenThisTick > 0) {
    queueSessionEvent("pellet_eaten", {
      pellets: pelletsEatenThisTick,
      powerPellets: powerPelletsEatenThisTick,
      pelletsLeft: STATE.pelletsLeft,
    });
  }

  if (STATE.pelletsLeft <= 0) {
    STATE.score += SCORE_VALUES.ROUND_CLEAR_BONUS;
    STATE.mode = "won";
    queueSessionEvent("run_won", {
      finalScore: STATE.score,
      durationMs: getRunElapsedMs(),
      pelletsEaten: STATE.runStats.pelletsEaten,
      powerPelletsEaten: STATE.runStats.powerPelletsEaten,
      enemiesEaten: STATE.runStats.enemiesEaten,
      telemetryOverflow: STATE.rewards.eventOverflow,
    });
    if (!STATE.rewards.apiBase) {
      setClaimStatus("Rewards API is not configured for this host");
    } else {
      setClaimStatus("Enter your address and claim your FPOM");
    }
    showOverlay("FPOM Wins", "Play Again");
    playTone(840, 0.1, "sawtooth", 0.06);
    playTone(1040, 0.15, "triangle", 0.05);
  }
}

function handleEnemyCollisions() {
  const player = STATE.player;
  if (!player.alive) return;

  for (const enemy of STATE.enemies) {
    if (enemy.respawnTimer > 0) continue;
    const hit = Math.hypot(player.x - enemy.x, player.y - enemy.y) <= player.r + enemy.r - 2;
    if (!hit) continue;

    if (STATE.powerTimer > 0) {
      spawnShatterEffect(enemy.x, enemy.y, enemy.r * 2.2, enemy.type, 14);
      enemy.respawnTimer = 2.8;
      const spawn = tileCenter(14, 9);
      enemy.x = spawn.x;
      enemy.y = spawn.y;
      STATE.runStats.enemiesEaten += 1;
      STATE.combo += 1;
      STATE.score += SCORE_VALUES.ENEMY_BASE + STATE.combo * SCORE_VALUES.ENEMY_COMBO_STEP;
      queueSessionEvent("enemy_eaten", {
        enemyType: enemy.type,
        combo: STATE.combo,
      });
      playTone(700, 0.06, "square", 0.04);
      playTone(920, 0.08, "triangle", 0.035);
    } else {
      spawnShatterEffect(player.x, player.y, player.r * 2.4, "fpom", 24);
      player.alive = false;
      STATE.lives -= 1;
      queueSessionEvent("life_lost", {
        livesLeft: STATE.lives,
      });
      playTone(180, 0.22, "sawtooth", 0.05);
      if (STATE.lives <= 0) {
        STATE.mode = "gameover";
        queueSessionEvent("run_lost", {
          finalScore: STATE.score,
          durationMs: getRunElapsedMs(),
        });
        showOverlay("Game Over", "Try Again");
      } else {
        STATE.roundResetTimer = 0.95;
      }
      return;
    }
  }
}

function update(dt) {
  if (STATE.mode !== "playing" || STATE.paused) {
    updateEffects(dt);
    return;
  }

  STATE.elapsed += dt;
  updateEffects(dt);

  if (STATE.roundResetTimer > 0) {
    STATE.roundResetTimer -= dt;
    if (STATE.roundResetTimer <= 0 && STATE.lives > 0) {
      resetRound();
    }
    return;
  }

  if (STATE.powerTimer > 0) {
    STATE.powerTimer = Math.max(0, STATE.powerTimer - dt);
  }

  updatePlayer(dt);
  for (const enemy of STATE.enemies) {
    updateEnemy(enemy, dt);
  }

  eatPellets();
  handleEnemyCollisions();
}

function drawMazeBackground() {
  const gradient = ctx.createLinearGradient(0, MAZE_OFFSET_Y, 0, MAZE_OFFSET_Y + MAZE_HEIGHT);
  gradient.addColorStop(0, "#170f29");
  gradient.addColorStop(1, "#29173b");
  ctx.fillStyle = gradient;
  ctx.fillRect(MAZE_OFFSET_X, MAZE_OFFSET_Y, MAZE_WIDTH, MAZE_HEIGHT);

  ctx.save();
  ctx.globalAlpha = 0.1;
  for (let row = 0; row < MAZE_ROWS; row += 1) {
    const y = MAZE_OFFSET_Y + row * TILE;
    ctx.fillStyle = row % 2 === 0 ? "#ffd7a0" : "#ffffff";
    ctx.fillRect(MAZE_OFFSET_X, y, MAZE_WIDTH, 2);
  }
  ctx.restore();
}

function drawWalls() {
  for (let row = 0; row < MAZE_ROWS; row += 1) {
    for (let col = 0; col < MAZE_COLS; col += 1) {
      if (STATE.maze[row][col] !== "#") continue;
      const x = MAZE_OFFSET_X + col * TILE;
      const y = MAZE_OFFSET_Y + row * TILE;

      const wallGradient = ctx.createLinearGradient(x, y, x + TILE, y + TILE);
      wallGradient.addColorStop(0, "#2e6df7");
      wallGradient.addColorStop(1, "#51e8ff");
      ctx.fillStyle = wallGradient;
      ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
    }
  }
}

function drawPellets() {
  for (const pellet of STATE.pellets) {
    if (pellet.eaten) continue;
    const c = tileCenter(pellet.col, pellet.row);
    const pulse = 0.75 + Math.sin(STATE.elapsed * 5 + pellet.col) * 0.2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, pellet.power ? 7 * pulse : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = pellet.power ? "#ff6f6f" : "#ffd773";
    ctx.fill();
  }
}

function applyDirectionalTransform(dir) {
  if (dir === "left") {
    ctx.scale(-1, 1);
    return;
  }
  if (dir === "down") {
    ctx.rotate(Math.PI / 2);
    return;
  }
  if (dir === "up") {
    ctx.rotate(Math.PI / 2);
    ctx.scale(-1, 1);
  }
}

function drawPlayer() {
  const p = STATE.player;
  const facing = p.dir === "left" ? Math.PI : p.dir === "up" ? -Math.PI / 2 : p.dir === "down" ? Math.PI / 2 : 0;
  const mouth = 0.24 + Math.abs(Math.sin(p.mouthPhase)) * 0.2;

  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, p.r + 2, facing + mouth, facing - mouth, false);
  ctx.closePath();
  ctx.clip();

  const glow = STATE.powerTimer > 0 ? 8 : 3;
  ctx.shadowColor = STATE.powerTimer > 0 ? "#ff4444" : "#fff3b0";
  ctx.shadowBlur = glow;
  applyDirectionalTransform(p.dir);
  ctx.drawImage(images.fpom, -(p.r + 4), -(p.r + 4), (p.r + 4) * 2, (p.r + 4) * 2);

  ctx.restore();

  if (STATE.powerTimer > 0) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 5 + Math.sin(STATE.elapsed * 10) * 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 70, 70, 0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawEnemy(enemy) {
  if (enemy.respawnTimer > 0) {
    return;
  }

  const size = enemy.r * 2.3;
  ctx.save();
  ctx.translate(enemy.x, enemy.y);

  if (STATE.powerTimer > 0) {
    const blink = Math.sin(enemy.blink * 16) > 0 ? 0.55 : 0.25;
    ctx.fillStyle = `rgba(20, 120, 255, ${blink})`;
    ctx.beginPath();
    ctx.arc(0, 0, enemy.r + 6, 0, Math.PI * 2);
    ctx.fill();
  }

  const img = images[enemy.type];
  if (img.complete) {
    applyDirectionalTransform(enemy.dir);
    if (enemy.type === "pepe") {
      ctx.beginPath();
      ctx.arc(0, 0, enemy.r + 0.5, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(0, 0, enemy.r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawEffects() {
  for (const e of STATE.effects) {
    const alpha = Math.max(0, Math.min(1, e.life / e.maxLife));
    const img = images[e.spriteKey];
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.rotation);
    ctx.globalAlpha = alpha;
    if (img?.complete) {
      ctx.drawImage(
        img,
        e.srcX,
        e.srcY,
        e.srcSize,
        e.srcSize,
        -e.size / 2,
        -e.size / 2,
        e.size,
        e.size,
      );
    } else {
      ctx.fillStyle = "rgba(255, 120, 120, 0.85)";
      ctx.fillRect(-e.size / 2, -e.size / 2, e.size, e.size);
    }
    ctx.restore();
  }
}

function drawHud() {
  ctx.fillStyle = "#fff7e0";
  ctx.font = '16px "Press Start 2P", monospace';
  ctx.fillText(`Score ${STATE.score}`, 22, 28);
  ctx.fillText(`Lives ${STATE.lives}`, 22, 54);

  if (STATE.powerTimer > 0) {
    ctx.fillStyle = "#ff9d9d";
    ctx.fillText(`HUNT ${STATE.powerTimer.toFixed(1)}s`, BASE_WIDTH - 290, 28);
  }

  if (STATE.paused && STATE.mode === "playing") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
    ctx.fillStyle = "#fff";
    ctx.font = '22px "Bungee", sans-serif';
    ctx.fillText("PAUSED", BASE_WIDTH / 2 - 78, BASE_HEIGHT / 2);
  }
}

function drawModeBanner() {
  if (STATE.mode === "playing") {
    return;
  }

  const cardW = 760;
  const cardH = 280;
  const x = (BASE_WIDTH - cardW) / 2;
  const y = (BASE_HEIGHT - cardH) / 2;

  ctx.fillStyle = "rgba(9, 6, 25, 0.7)";
  ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

  ctx.fillStyle = "rgba(255, 245, 225, 0.95)";
  ctx.fillRect(x, y, cardW, cardH);
  ctx.strokeStyle = "#ff4f34";
  ctx.lineWidth = 4;
  ctx.strokeRect(x + 2, y + 2, cardW - 4, cardH - 4);

  let title = "FPOM Meme Hunt";
  if (STATE.mode === "gameover") title = "Game Over";
  if (STATE.mode === "won") title = "FPOM Wins";

  ctx.fillStyle = "#5a1208";
  ctx.font = '44px "Bungee", sans-serif';
  ctx.fillText(title, x + 72, y + 74);

  ctx.fillStyle = "#2f1a15";
  ctx.font = '12px "Press Start 2P", monospace';
  ctx.fillText("No more scams. Gimme a serious fake.", x + 70, y + 112);
  ctx.fillText("Move: WASD / Arrows  |  F: fullscreen  |  P: pause", x + 70, y + 148);
  ctx.fillText("Collect memes. Eat red orb to hunt Doge, Shiba, Pepe.", x + 70, y + 176);
  ctx.fillText("Press Enter / Space or click Start Hunt", x + 70, y + 218);
}

function render() {
  ctx.clearRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

  const bg = ctx.createLinearGradient(0, 0, BASE_WIDTH, BASE_HEIGHT);
  bg.addColorStop(0, "#260f31");
  bg.addColorStop(1, "#3d1731");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

  drawMazeBackground();
  drawWalls();
  drawPellets();

  for (const enemy of STATE.enemies) {
    drawEnemy(enemy);
  }

  if (STATE.player) {
    drawPlayer();
  }
  drawEffects();

  drawHud();
  drawModeBanner();
}

function gameLoop(ts) {
  if (!lastTs) {
    lastTs = ts;
  }
  let delta = (ts - lastTs) / 1000;
  delta = Math.min(delta, 0.05);
  lastTs = ts;
  accumulator += delta;

  while (accumulator >= FIXED_DT) {
    update(FIXED_DT);
    accumulator -= FIXED_DT;
  }

  render();
  animationFrame = requestAnimationFrame(gameLoop);
}

function advanceTime(ms) {
  const steps = Math.max(1, Math.round(ms / (FIXED_DT * 1000)));
  for (let i = 0; i < steps; i += 1) {
    update(FIXED_DT);
  }
  render();
}

function renderGameToText() {
  const player = STATE.player
    ? {
        x: Number(STATE.player.x.toFixed(1)),
        y: Number(STATE.player.y.toFixed(1)),
        r: STATE.player.r,
        dir: STATE.player.dir,
        desiredDir: STATE.player.desiredDir,
      }
    : null;

  const activePellets = STATE.pellets
    .filter((p) => !p.eaten)
    .slice(0, 20)
    .map((p) => ({ row: p.row, col: p.col, power: p.power }));

  const enemies = STATE.enemies.map((e) => ({
    type: e.type,
    x: Number(e.x.toFixed(1)),
    y: Number(e.y.toFixed(1)),
    dir: e.dir,
    active: e.respawnTimer <= 0,
  }));

  return JSON.stringify({
    coordinate_system: "origin top-left; x right; y down; maze tile size 32px",
    mode: STATE.mode,
    paused: STATE.paused,
    score: STATE.score,
    lives: STATE.lives,
    power_timer: Number(STATE.powerTimer.toFixed(2)),
    pellets_left: STATE.pelletsLeft,
    player,
    enemies,
    effects_count: STATE.effects.length,
    round_reset_timer: Number(STATE.roundResetTimer.toFixed(2)),
    sample_active_pellets: activePellets,
  });
}

function handleDirectionInput(dir) {
  if (!STATE.player) return;
  if (STATE.player.desiredDir !== dir) {
    queueSessionEvent("input_direction", {
      dir,
    });
  }
  STATE.player.desiredDir = dir;
}

function togglePause() {
  if (STATE.mode !== "playing") return;
  STATE.paused = !STATE.paused;
  queueSessionEvent("pause_toggled", {
    paused: STATE.paused,
  });
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
}

function readClaimForm() {
  const xProfile = xProfileInput ? xProfileInput.value.trim() : "";
  return { xProfile };
}

async function submitRewardClaim() {
  if (STATE.mode !== "won" || STATE.rewards.claimInFlight) {
    return;
  }

  if (!STATE.rewards.apiBase) {
    setClaimStatus("Rewards API is not configured");
    return;
  }

  const { xProfile } = readClaimForm();
  const normalizedXProfile = normalizeXProfile(xProfile);
  if (!normalizedXProfile) {
    setClaimStatus("Enter X profile as https://x.com/account");
    return;
  }

  const verificationMode = CLAIM_VERIFICATION_MODE;
  const claimAddress = STATE.rewards.connectedAddress || "";
  let signature;
  if (!isValidMassaAddress(claimAddress)) {
    setClaimStatus("Connect wallet first to get a valid Massa address");
    return;
  }

  STATE.rewards.claimInFlight = true;
  setClaimControlsDisabled(true);
  setClaimStatus("Preparing claim...");

  try {
    queueSessionEvent("claim_submit", {
      verificationMode,
      xProfile: normalizedXProfile,
      telemetryOverflow: STATE.rewards.eventOverflow,
    });

    setClaimStatus("Uploading run telemetry...");
    await flushSessionEvents(true);

    const sessionId = await ensureRewardsSession(true);
    if (!sessionId) {
      throw new Error("session_unavailable");
    }

    setClaimStatus("Preparing claim...");
    const prepared = await apiPost("/claim/prepare", {
      sessionId,
      address: claimAddress,
      xProfile: normalizedXProfile,
      verificationMode,
      fingerprint: getFingerprint(),
      run: getRunSummary(),
    });

    const needsSignature = Boolean(prepared.requiresSignature);
    if (needsSignature) {
      setClaimStatus("Requesting wallet signature...");
      signature = await signWithWallet(prepared.challenge);
    }

    setClaimStatus("Confirming claim...");
    const confirmed = await apiPost("/claim/confirm", {
      claimId: prepared.claimId,
      signature: signature || undefined,
    });

    if (confirmed.status === "PAID") {
      const txHash = confirmed.txHash ? ` tx=${confirmed.txHash}` : "";
      setClaimStatus(`Claim paid successfully.${txHash}`);
      return;
    }

    if (confirmed.status === "MANUAL_REVIEW") {
      setClaimStatus("Claim was flagged for manual review");
      return;
    }

    setClaimStatus(`Claim status: ${String(confirmed.status || "unknown")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "claim_failed";
    setClaimStatus(`Claim failed: ${message}`);
  } finally {
    STATE.rewards.claimInFlight = false;
    setClaimControlsDisabled(false);
  }
}

function isTextInputElement(element) {
  if (!element) {
    return false;
  }
  const tagName = element.tagName ? element.tagName.toUpperCase() : "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return Boolean(element.isContentEditable);
}

function onKeyDown(event) {
  const { code } = event;
  keysPressed.add(code);
  const isTypingTarget = isTextInputElement(event.target);
  const isWalletModalOpen = Boolean(walletModal && !walletModal.hidden);

  if (isWalletModalOpen) {
    if (code === "Escape") {
      closeWalletModal();
    }
    return;
  }

  if (code === "Enter" || code === "Space") {
    if (STATE.mode === "title" || STATE.mode === "gameover" || STATE.mode === "won") {
      startNewGame();
      return;
    }
  }

  if (code === "KeyP") {
    togglePause();
    return;
  }

  if (code === "KeyF") {
    if (isTypingTarget) {
      return;
    }
    toggleFullscreen().catch(() => {});
    return;
  }

  if (code === "ArrowLeft" || code === "KeyA") handleDirectionInput("left");
  if (code === "ArrowRight" || code === "KeyD") handleDirectionInput("right");
  if (code === "ArrowUp" || code === "KeyW") handleDirectionInput("up");
  if (code === "ArrowDown" || code === "KeyS") handleDirectionInput("down");
}

function onKeyUp(event) {
  keysPressed.delete(event.code);
}

function setupEvents() {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  startButton.addEventListener("click", () => startNewGame());
  if (claimButton) {
    claimButton.addEventListener("click", () => {
      submitRewardClaim().catch(() => {});
    });
  }
  if (topWalletButton) {
    topWalletButton.addEventListener("click", () => {
      openWalletModal().catch(() => {
        setClaimStatus("Failed to open wallet selector");
      });
    });
  }
  if (walletModalClose) {
    walletModalClose.addEventListener("click", () => {
      closeWalletModal();
    });
  }
  if (walletModal) {
    walletModal.addEventListener("click", (event) => {
      if (event.target === walletModal) {
        closeWalletModal();
      }
    });
  }
  if (devWinButton) {
    devWinButton.addEventListener("click", () => {
      triggerDebugVictory();
    });
  }

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      canvas.style.width = "min(96vw, 960px)";
    }
  });

  menuOverlay.addEventListener("click", () => {
    ensureAudioContext();
    if (audioCtx?.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  });
}

function init() {
  STATE.rewards.apiBase = getRewardsApiBase();
  const promoTweetOverride = getPromoTweetOverrideUrl();
  STATE.rewards.promoOverrideLocked = Boolean(promoTweetOverride);
  STATE.rewards.promoConfigFetchTried = false;
  applyPromoTweetUrl(promoTweetOverride || DEFAULT_X_PROMO_TWEET);
  initMaze();
  resetEntities();
  setupEvents();
  if (devWinButton) {
    devWinButton.hidden = !isDebugToolsEnabled();
  }
  if (rewardPanel) {
    rewardPanel.hidden = true;
  }
  updateTopWalletButton();
  updateWalletStatusForClaimPanel();
  setClaimControlsDisabled(false);
  if (STATE.rewards.apiBase) {
    setClaimStatus(`Rewards API: ${STATE.rewards.apiBase}`);
  } else {
    setClaimStatus("Rewards API is not configured");
  }
  window.render_game_to_text = renderGameToText;
  window.advanceTime = advanceTime;
  window.__fpom_game = { state: STATE };
  render();

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
  }
  animationFrame = requestAnimationFrame(gameLoop);
}

init();
