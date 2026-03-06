const WALLET_PROVIDER_MODULE_URL = "https://cdn.jsdelivr.net/npm/@massalabs/wallet-provider@3.3.0/+esm";
let walletProviderModulePromise = null;

/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   source: "wallet_provider" | "legacy";
 *   wallet?: any;
 *   provider?: any;
 * }} WalletCandidate
 */

/**
 * Discovers available wallet providers (Massa Station, Massa Wallet, Bearby, MetaMask-Snap if available)
 *
 * @returns {Promise<WalletCandidate[]>} Deduplicated candidate list
 */
export async function discoverWalletCandidates() {
  const candidates = [];

  try {
    const module = await loadWalletProviderModule();
    if (typeof module?.getWallets === "function") {
      const wallets = await module.getWallets();
      wallets.forEach((wallet, index) => {
        const rawName = typeof wallet?.name === "function" ? wallet.name() : "";
        const label = walletNameToLabel(rawName, wallet);
        const safeId = walletNameToId(label || rawName);
        candidates.push({
          id: `sdk:${safeId}:${index}`,
          name: label,
          source: "wallet_provider",
          wallet,
        });
      });
    }
  } catch {
    // Ignore SDK loader errors and keep legacy probing as fallback.
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

/**
 * Resolves claimable wallet accounts for a selected candidate
 *
 * @param {WalletCandidate} candidate Selected wallet candidate
 * @param {{ timeoutMs: number; isValidAddress: (address: string) => boolean }} options Validation and timeout settings
 * @returns {Promise<Array<{ address: string; account: any }>>} Valid account entries
 */
export async function getCandidateAccounts(candidate, options) {
  const timeoutMs = Number(options?.timeoutMs || 0) || 9000;
  const isValidAddress = options?.isValidAddress || (() => true);

  try {
    if (candidate.source === "wallet_provider") {
      return await withTimeout(
        requestWalletProviderAccounts(candidate.wallet, isValidAddress),
        timeoutMs,
        "wallet_connect_timeout",
      );
    }

    const legacyAccounts = await withTimeout(
      requestLegacyProviderAccounts(candidate.provider, isValidAddress),
      timeoutMs,
      "wallet_connect_timeout",
    );

    return legacyAccounts;
  } catch {
    return [];
  }
}

/**
 * Signs claim challenge using connected account or provider
 *
 * @param {{
 *   walletAccount: any;
 *   walletProvider: any;
 *   connectedAddress: string;
 *   challenge: string;
 * }} params Signing context
 * @returns {Promise<string>} Serialized signature
 */
export async function signChallenge(params) {
  const walletAccount = params?.walletAccount;
  if (walletAccount && typeof walletAccount.sign === "function") {
    try {
      const signatureResult = await walletAccount.sign(new TextEncoder().encode(params.challenge));
      const normalized = normalizeSignatureResult(signatureResult);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Fallback to provider-level methods below.
    }
  }

  const provider = params?.walletProvider;
  if (!provider) {
    throw new Error("wallet_not_connected");
  }

  const methods = [
    async () => provider?.request?.({ method: "massa_signMessage", params: [params.challenge] }),
    async () =>
      provider?.request?.({
        method: "personal_sign",
        params: [params.challenge, params.connectedAddress || ""],
      }),
    async () => provider?.signMessage?.(params.challenge),
    async () => provider?.sign?.(params.challenge),
  ];

  for (const method of methods) {
    try {
      const result = await method();
      const normalized = normalizeSignatureResult(result);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Keep trying known provider methods.
    }
  }

  throw new Error("wallet_sign_failed");
}

/**
 * Creates or reuses wallet-provider ESM module promise
 *
 * @returns {Promise<any>} Loaded module object
 */
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

/**
 * Discovers legacy injected wallet globals as fallback
 *
 * @returns {WalletCandidate[]} Legacy candidates
 */
function detectLegacyWalletProviders() {
  const candidates = [];

  const massaStationProvider = window.massaStation || window.massa || null;
  const massaWalletProvider = window.massaWallet || window.massaWalletProvider || null;

  if (massaStationProvider) {
    candidates.push({
      id: "legacy:massa_station",
      name: "Massa Station",
      source: "legacy",
      provider: massaStationProvider,
    });
  }

  if (massaWalletProvider && massaWalletProvider !== massaStationProvider) {
    candidates.push({
      id: "legacy:massa_wallet",
      name: "Massa Wallet",
      source: "legacy",
      provider: massaWalletProvider,
    });
  }

  const bearbyProvider = window.bearby || window.bearbyWallet || window.web3?.wallet || window.web3 || null;
  if (bearbyProvider) {
    candidates.push({
      id: "legacy:bearby",
      name: "Bearby",
      source: "legacy",
      provider: bearbyProvider,
    });
  }

  return candidates;
}

/**
 * Tries known method names to request address list from legacy injected provider
 *
 * @param {any} provider Legacy provider object
 * @param {(address: string) => boolean} isValidAddress Address validator callback
 * @returns {Promise<Array<{ address: string; account: null }>>} Valid and deduplicated legacy accounts
 */
async function requestLegacyProviderAccounts(provider, isValidAddress) {
  const attempts = [
    async () => provider?.getAccounts?.(),
    async () => provider?.getAccount?.(),
    async () => provider?.request?.({ method: "massa_requestAccounts" }),
    async () => provider?.request?.({ method: "wallet_requestAccounts" }),
    async () => provider?.request?.({ method: "eth_requestAccounts" }),
    async () => provider?.connect?.(),
    async () => provider?.enable?.(),
    async () => provider?.getAccounts?.(),
    async () => provider?.getAccount?.(),
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const addresses = normalizeAddressList(result)
        .map((entry) => entry.trim())
        .filter((entry) => isValidAddress(entry));

      if (addresses.length > 0) {
        const seen = new Set();
        return addresses
          .filter((address) => {
            if (seen.has(address)) return false;
            seen.add(address);
            return true;
          })
          .map((address) => ({ address, account: null }));
      }
    } catch {
      // Continue trying next known method.
    }
  }

  return [];
}

/**
 * Requests all connected accounts via wallet-provider SDK wallet object
 *
 * @param {any} wallet Wallet-provider SDK wallet object
 * @param {(address: string) => boolean} isValidAddress Address validation callback
 * @returns {Promise<Array<{ address: string; account: any }>>} Valid and deduplicated accounts
 */
async function requestWalletProviderAccounts(wallet, isValidAddress) {
  if (!wallet) {
    return [];
  }

  try {
    if (typeof wallet.connect === "function") {
      await wallet.connect();
    }
  } catch {
    // Continue and still try to read account list.
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
      if (!isValidAddress(address)) {
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

/**
 * Maps SDK wallet name to readable UI label
 *
 * @param {string} rawName Wallet name from SDK
 * @param {any} wallet Wallet instance (used to detect Massa Station class)
 * @returns {string} UI label
 */
function walletNameToLabel(rawName, wallet) {
  const ctorName = String(wallet?.constructor?.name || "").toLowerCase();
  if (ctorName.includes("massastation")) {
    return "Massa Station";
  }

  if (
    typeof wallet?.getConfig === "function" ||
    typeof wallet?.addSignRule === "function" ||
    typeof wallet?.editSignRule === "function" ||
    typeof wallet?.deleteSignRule === "function"
  ) {
    return "Massa Station";
  }

  const normalized = String(rawName || "").toLowerCase();
  if (normalized.includes("station")) {
    return "Massa Station";
  }
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

/**
 * Builds safe id fragment from wallet name
 *
 * @param {string} rawName Raw wallet name
 * @returns {string} Safe lowercase id
 */
function walletNameToId(rawName) {
  const normalized = String(rawName || "wallet")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "wallet";
}

/**
 * Normalizes address from different provider result shapes
 *
 * @param {any} value Provider response payload
 * @returns {string} Extracted address or empty string
 */
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

/**
 * Extracts a flat list of address-like strings from provider responses
 *
 * @param {any} value Provider response payload
 * @returns {string[]} Extracted address candidates
 */
function normalizeAddressList(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeAddressList(entry));
  }

  if (typeof value === "object") {
    const list = [];
    if (typeof value.address === "string") {
      list.push(value.address);
    }
    if (Array.isArray(value.accounts)) {
      list.push(...value.accounts.flatMap((entry) => normalizeAddressList(entry)));
    }
    if (Array.isArray(value.result)) {
      list.push(...value.result.flatMap((entry) => normalizeAddressList(entry)));
    }
    return list;
  }

  return [];
}

/**
 * Converts signature results to string form accepted by backend
 *
 * @param {any} value Signature return value from wallet/account
 * @returns {string} Signature payload or empty string
 */
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

/**
 * Applies timeout to arbitrary async operation
 *
 * @template T
 * @param {Promise<T>} promise Promise to guard
 * @param {number} timeoutMs Timeout in milliseconds
 * @param {string} timeoutCode Error code text for timeout error
 * @returns {Promise<T>} Promise result when operation finishes in time
 */
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
