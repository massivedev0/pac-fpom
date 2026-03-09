import {
  CLAIM_VERIFICATION_MODE,
  DEFAULT_LOCAL_API,
  DEFAULT_PRODUCTION_API,
  DEFAULT_X_PROMO_TWEET,
  REWARDS_API_TIMEOUT_MS,
  SESSION_EVENTS_BATCH_SIZE,
  SESSION_EVENTS_BUFFER_LIMIT,
  SESSION_RETRY_DELAY_MS,
} from "./constants.js";
import { apiGetJson, apiPostJson } from "./http-client.js";
import {
  getClientDeviceInfo,
  getFingerprint,
  isValidMassaAddress,
  normalizeXProfile,
} from "./rewards-helpers.js";

const CLAIM_STATUS_POLL_INTERVAL_MS = 5000;

function isLocalDevelopmentHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Creates rewards/session controller for telemetry, backend sync, and claim flow
 *
 * @param {object} options Controller dependencies
 * @param {any} options.rewardsState Mutable rewards state slice
 * @param {any} options.runStats Mutable run statistics slice
 * @param {(text: string) => void} options.setClaimStatus Claim status UI updater
 * @param {(input: { text: string; txExplorerUrl?: string; txHash?: string }) => void} options.setClaimStatusView Rich claim status UI updater
 * @param {(disabled: boolean) => void} options.setClaimControlsDisabled Claim control state updater
 * @param {(locked: boolean) => void} options.setClaimSubmissionLocked Claim button lock updater
 * @param {(url: string) => void} options.applyPromoTweetUrl Promo tweet link updater
 * @param {() => number} options.getScore Current score getter
 * @param {() => string} options.getMode Current mode getter
 * @returns {{
 *   applyRuntimeConfig: () => void;
 *   maybeSyncPromoTweetFromBackend: () => void;
 *   resetRunState: () => void;
 *   queueSessionEvent: (type: string, payload?: Record<string, unknown>) => void;
 *   getRunElapsedMs: () => number;
 *   getRunSummary: () => {
 *     won: boolean;
 *     durationMs: number;
 *     pelletsEaten: number;
 *     powerPelletsEaten: number;
 *     enemiesEaten: number;
 *     finalScoreClient: number;
 *     telemetryEventsTotal: number;
 *     telemetryOverflow: boolean;
 *   };
 *   submitRewardClaim: (claimInput: { xProfile: string }) => Promise<void>;
 *   stopClaimStatusPolling: () => void;
 * }}
 */
export function createRewardsController(options) {
  const {
    rewardsState,
    runStats,
    setClaimStatus,
    setClaimStatusView,
    setClaimControlsDisabled,
    setClaimSubmissionLocked,
    applyPromoTweetUrl,
    getScore,
    getMode,
  } = options;

  let claimStatusPollTimerId = 0;
  let claimStatusPollInFlight = false;

  /**
   * Resolves rewards API base URL from runtime config
   *
   * @returns {string} Normalized API base URL
   */
  function getRewardsApiBase() {
    if (window.__FPOM_REWARDS_API__) {
      return String(window.__FPOM_REWARDS_API__).replace(/\/+$/, "");
    }

    const queryApi = new URLSearchParams(window.location.search).get("rewardsApi");
    if (queryApi) {
      return queryApi.replace(/\/+$/, "");
    }

    if (isLocalDevelopmentHost(window.location.hostname)) {
      return DEFAULT_LOCAL_API;
    }

    return DEFAULT_PRODUCTION_API;
  }

  /**
   * Resolves promo tweet override URL from runtime config
   *
   * @returns {string} Override URL or empty string
   */
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

  /**
   * Rewards backend POST helper bound to configured API base URL
   *
   * @param {string} path API path
   * @param {Record<string, unknown>} body JSON request body
   * @returns {Promise<any>} Parsed JSON response
   */
  async function apiPost(path, body) {
    const base = rewardsState.apiBase;
    if (!base) {
      throw new Error("Rewards API is not configured");
    }

    return apiPostJson(base, path, body, REWARDS_API_TIMEOUT_MS);
  }

  /**
   * Rewards backend GET helper bound to configured API base URL
   *
   * @param {string} path API path
   * @returns {Promise<any>} Parsed JSON response
   */
  async function apiGet(path) {
    const base = rewardsState.apiBase;
    if (!base) {
      throw new Error("Rewards API is not configured");
    }

    return apiGetJson(base, path, REWARDS_API_TIMEOUT_MS);
  }

  /**
   * Applies runtime API/tweet config into mutable rewards state
   */
  function applyRuntimeConfig() {
    rewardsState.apiBase = getRewardsApiBase();
    rewardsState.txExplorerUrlTemplate = "";
    const promoTweetOverride = getPromoTweetOverrideUrl();
    rewardsState.promoOverrideLocked = Boolean(promoTweetOverride);
    rewardsState.promoConfigFetchTried = false;
    applyPromoTweetUrl(promoTweetOverride || DEFAULT_X_PROMO_TWEET);
  }

  /**
   * Fetches public rewards config from backend
   *
   * @returns {Promise<void>}
   */
  async function syncPublicConfigFromBackend() {
    if (!rewardsState.apiBase) {
      return;
    }

    try {
      const payload = await apiGet("/public/config");
      if (payload && typeof payload.xPromoTweet === "string" && payload.xPromoTweet.trim()) {
        applyPromoTweetUrl(payload.xPromoTweet.trim());
      }
      rewardsState.txExplorerUrlTemplate =
        payload && typeof payload.txExplorerUrlTemplate === "string"
          ? payload.txExplorerUrlTemplate.trim()
          : "";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      console.warn(`Failed to load public config from backend: ${reason}`);
    }
  }

  /**
   * Runs promo tweet sync once when allowed
   */
  function maybeSyncPromoTweetFromBackend() {
    if (!rewardsState.apiBase) {
      return;
    }
    if (rewardsState.promoOverrideLocked) {
      return;
    }
    if (rewardsState.promoConfigFetchTried) {
      return;
    }

    rewardsState.promoConfigFetchTried = true;
    syncPublicConfigFromBackend().catch(() => {});
  }

  /**
   * Builds explorer URL for a transaction hash using configured template
   *
   * @param {string} txHash Operation hash
   * @returns {string} Explorer URL or empty string
   */
  function buildTxExplorerUrl(txHash) {
    const normalizedTxHash = String(txHash || "").trim();
    const template = String(rewardsState.txExplorerUrlTemplate || "").trim();
    if (!normalizedTxHash || !template) {
      return "";
    }

    if (template.includes("{txHash}")) {
      return template.replaceAll("{txHash}", encodeURIComponent(normalizedTxHash));
    }

    const separator = template.endsWith("/") ? "" : "/";
    return `${template}${separator}${encodeURIComponent(normalizedTxHash)}`;
  }

  /**
   * Stores latest known tx hash so polling messages keep it visible across transitions
   *
   * @param {any} claim Backend claim payload
   * @returns {string} Latest known tx hash
   */
  function rememberClaimTxHash(claim) {
    const currentTxHash =
      claim && typeof claim.txHash === "string" ? claim.txHash.trim() : "";
    if (currentTxHash) {
      rewardsState.lastClaimTxHash = currentTxHash;
      return currentTxHash;
    }
    return String(rewardsState.lastClaimTxHash || "").trim();
  }

  /**
   * Returns elapsed run time in milliseconds
   *
   * @returns {number} Elapsed time since run start
   */
  function getRunElapsedMs() {
    if (!runStats.startedAtMs) {
      return 0;
    }
    return Math.max(1, Math.floor(performance.now() - runStats.startedAtMs));
  }

  /**
   * Queues gameplay telemetry event for batched backend upload
   *
   * @param {string} type Event name
   * @param {Record<string, unknown>} [payload={}] Event payload
   */
  function queueSessionEvent(type, payload = {}) {
    if (!rewardsState.apiBase) {
      return;
    }

    if (rewardsState.eventBuffer.length >= SESSION_EVENTS_BUFFER_LIMIT) {
      rewardsState.eventOverflow = true;
      rewardsState.eventBuffer.shift();
    }

    rewardsState.eventBuffer.push({
      type,
      atMs: getRunElapsedMs(),
      score: getScore(),
      payload,
    });
  }

  /**
   * Flushes buffered telemetry events to backend in batches
   *
   * @param {boolean} [force=false] When true, flushes all pending events
   * @returns {Promise<void>}
   */
  async function flushSessionEvents(force = false) {
    if (!rewardsState.apiBase) {
      return;
    }
    if (rewardsState.eventFlushInFlight) {
      return;
    }
    if (rewardsState.eventBuffer.length === 0) {
      return;
    }

    rewardsState.eventFlushInFlight = true;
    try {
      const sessionId = await ensureRewardsSession(force);
      if (!sessionId) {
        if (force) {
          throw new Error("session_unavailable");
        }
        return;
      }

      while (rewardsState.eventBuffer.length > 0) {
        const batch = rewardsState.eventBuffer.slice(0, SESSION_EVENTS_BATCH_SIZE);
        await apiPost("/session/event", {
          sessionId,
          startSeq: rewardsState.nextEventSeq,
          events: batch,
        });
        rewardsState.eventBuffer.splice(0, batch.length);
        rewardsState.nextEventSeq += batch.length;
      }
    } finally {
      rewardsState.eventFlushInFlight = false;
    }
  }

  /**
   * Ensures rewards session exists and is synced with backend
   *
   * @param {boolean} [force=false] Skip retry cooldown
   * @returns {Promise<string | null>} Active session id
   */
  async function ensureRewardsSession(force = false) {
    if (rewardsState.sessionId) {
      return rewardsState.sessionId;
    }
    if (!rewardsState.apiBase) {
      return null;
    }

    const now = performance.now();
    if (!force && rewardsState.sessionRetryAtMs > now) {
      return null;
    }

    try {
      const session = await apiPost("/session/start", { fingerprint: getFingerprint() });
      rewardsState.sessionId = session.sessionId;
      rewardsState.sessionRetryAtMs = 0;
      return rewardsState.sessionId;
    } catch (error) {
      rewardsState.sessionRetryAtMs = now + SESSION_RETRY_DELAY_MS;
      throw error;
    }
  }

  /**
   * Builds compact run summary used for claim verification
   *
   * @returns {{
   *   won: boolean;
   *   durationMs: number;
   *   pelletsEaten: number;
   *   powerPelletsEaten: number;
   *   enemiesEaten: number;
   *   finalScoreClient: number;
   *   telemetryEventsTotal: number;
   *   telemetryOverflow: boolean;
   * }}
   */
  function getRunSummary() {
    const durationMs = getRunElapsedMs();
    return {
      won: getMode() === "won",
      durationMs,
      pelletsEaten: runStats.pelletsEaten,
      powerPelletsEaten: runStats.powerPelletsEaten,
      enemiesEaten: runStats.enemiesEaten,
      finalScoreClient: getScore(),
      telemetryEventsTotal: rewardsState.nextEventSeq + rewardsState.eventBuffer.length,
      telemetryOverflow: rewardsState.eventOverflow,
    };
  }

  /**
   * Stops periodic polling of the current claim status
   */
  function stopClaimStatusPolling() {
    if (claimStatusPollTimerId) {
      window.clearInterval(claimStatusPollTimerId);
      claimStatusPollTimerId = 0;
    }
    rewardsState.activeClaimId = null;
  }

  /**
   * Maps backend claim object to user-facing status presentation
   *
   * @param {any} claim Backend claim payload
   * @returns {{ text: string; txHash?: string; txExplorerUrl?: string }} User-facing status presentation
   */
  function formatClaimStatusMessage(claim) {
    if (!claim || typeof claim.status !== "string") {
      return { text: "Claim status is unavailable" };
    }

    const txHash = rememberClaimTxHash(claim);
    const txExplorerUrl = buildTxExplorerUrl(txHash);

    if (claim.status === "PAID") {
      return {
        text: `Claim approved and paid.${txHash ? ` tx=${txHash}` : ""}`,
        txHash,
        txExplorerUrl,
      };
    }
    if (claim.status === "REJECTED") {
      return { text: "Claim was rejected" };
    }
    if (claim.status === "CONFIRMED") {
      return {
        text: `Claim approved. Payout is being finalized...${txHash ? ` tx=${txHash}` : ""}`,
        txHash,
        txExplorerUrl,
      };
    }
    if (claim.status === "MANUAL_REVIEW") {
      return { text: "Claim is in manual review. Waiting for admin decision..." };
    }
    if (claim.status === "PREPARED") {
      return { text: "Claim is prepared. Waiting for backend processing..." };
    }
    return { text: `Claim status: ${String(claim.status)}` };
  }

  /**
   * Refreshes latest claim status from backend and updates UI
   *
   * @param {string} claimId Claim id to refresh
   * @returns {Promise<void>}
   */
  async function refreshClaimStatus(claimId) {
    if (!rewardsState.apiBase || !claimId || claimStatusPollInFlight) {
      return;
    }

    claimStatusPollInFlight = true;
    try {
      const claim = await apiGet(`/claim/${encodeURIComponent(claimId)}`);
      setClaimStatusView(formatClaimStatusMessage(claim));

      if (claim?.status === "PAID" || claim?.status === "REJECTED") {
        stopClaimStatusPolling();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      console.warn(`Failed to refresh claim status: ${reason}`);
    } finally {
      claimStatusPollInFlight = false;
    }
  }

  /**
   * Starts periodic polling of current claim status until terminal state
   *
   * @param {string} claimId Claim id to observe
   */
  function startClaimStatusPolling(claimId) {
    stopClaimStatusPolling();
    rewardsState.activeClaimId = claimId;
    refreshClaimStatus(claimId).catch(() => {});
    claimStatusPollTimerId = window.setInterval(() => {
      refreshClaimStatus(claimId).catch(() => {});
    }, CLAIM_STATUS_POLL_INTERVAL_MS);
  }

  /**
   * Resets rewards-session state between game runs
   */
  function resetRunState() {
    stopClaimStatusPolling();
    rewardsState.sessionId = null;
    rewardsState.sessionRetryAtMs = 0;
    rewardsState.nextEventSeq = 0;
    rewardsState.eventBuffer = [];
    rewardsState.eventOverflow = false;
    rewardsState.eventFlushInFlight = false;
    rewardsState.claimInFlight = false;
    rewardsState.lastClaimTxHash = "";
    setClaimSubmissionLocked(false);
  }

  /**
   * Submits reward claim prepare and confirm flow
   *
   * @param {{ xProfile: string }} claimInput Current claim form values
   * @returns {Promise<void>}
   */
  async function submitRewardClaim(claimInput) {
    if (getMode() !== "won" || rewardsState.claimInFlight) {
      return;
    }

    if (!rewardsState.apiBase) {
      setClaimStatus("Rewards API is not configured");
      return;
    }

    const normalizedXProfile = normalizeXProfile(claimInput?.xProfile || "");
    if (!normalizedXProfile) {
      setClaimStatus("Enter X profile as https://x.com/account");
      return;
    }

    const claimAddress = rewardsState.connectedAddress || "";
    if (!isValidMassaAddress(claimAddress)) {
      setClaimStatus("Connect wallet first to get a valid Massa address");
      return;
    }

    rewardsState.claimInFlight = true;
    setClaimControlsDisabled(true);
    setClaimStatus("Preparing claim...");

    try {
      queueSessionEvent("claim_submit", {
        verificationMode: CLAIM_VERIFICATION_MODE,
        xProfile: normalizedXProfile,
        telemetryOverflow: rewardsState.eventOverflow,
      });

      if (!rewardsState.txExplorerUrlTemplate) {
        await syncPublicConfigFromBackend();
      }

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
        verificationMode: CLAIM_VERIFICATION_MODE,
        fingerprint: getFingerprint(),
        clientWallet: String(rewardsState.walletProviderName || "").trim(),
        clientDevice: getClientDeviceInfo(),
        run: getRunSummary(),
      });

      setClaimStatus("Confirming claim...");
      const confirmed = await apiPost("/claim/confirm", {
        claimId: prepared.claimId,
      });

      if (confirmed.status === "PAID") {
        setClaimSubmissionLocked(true);
        setClaimStatusView(formatClaimStatusMessage(confirmed));
        stopClaimStatusPolling();
        return;
      }

      if (confirmed.status === "MANUAL_REVIEW") {
        setClaimSubmissionLocked(true);
        setClaimStatus("Claim is in manual review. Waiting for admin decision...");
        startClaimStatusPolling(prepared.claimId);
        return;
      }

      if (confirmed.status === "CONFIRMED") {
        setClaimSubmissionLocked(true);
        setClaimStatusView(formatClaimStatusMessage(confirmed));
        startClaimStatusPolling(prepared.claimId);
        return;
      }

      if (prepared?.claimId) {
        setClaimSubmissionLocked(true);
        rewardsState.activeClaimId = prepared.claimId;
      }
      setClaimStatus(`Claim status: ${String(confirmed.status || "unknown")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "claim_failed";
      setClaimSubmissionLocked(false);
      setClaimStatus(`Claim failed: ${message}`);
    } finally {
      rewardsState.claimInFlight = false;
      setClaimControlsDisabled(false);
    }
  }

  return {
    applyRuntimeConfig,
    maybeSyncPromoTweetFromBackend,
    resetRunState,
    queueSessionEvent,
    getRunElapsedMs,
    getRunSummary,
    submitRewardClaim,
    stopClaimStatusPolling,
  };
}
