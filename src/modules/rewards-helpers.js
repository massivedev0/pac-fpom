const INSTALL_ID_STORAGE_KEY = "fpom_install_id";

/**
 * Validates FPOM claim X profile URL format
 *
 * @param {string} input Raw user input
 * @returns {string | null} Normalized profile URL or `null` if invalid
 */
export function normalizeXProfile(input) {
  const trimmed = input.trim();
  const match = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return `https://x.com/${match[1].toLowerCase()}`;
}

/**
 * Checks that address is a valid Massa address string
 *
 * @param {string} input Candidate wallet address
 * @returns {boolean} True when input looks like AU... or AS... Massa address
 */
export function isValidMassaAddress(input) {
  return /^A[US][1-9A-HJ-NP-Za-km-z]{20,120}$/.test(input.trim());
}

/**
 * Builds a simple client fingerprint used for risk checks on backend
 *
 * @returns {string} JSON payload with stable install id + browser hints
 */
export function getFingerprint() {
  const payload = {
    installId: getInstallId(),
    ua: navigator.userAgent || "",
    lang: navigator.language || "",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    platform: navigator.platform || "",
  };
  return JSON.stringify(payload);
}

/**
 * Persists a stable pseudo-install identifier in local storage
 *
 * @returns {string} Existing or newly generated install id
 */
function getInstallId() {
  const existing = window.localStorage.getItem(INSTALL_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const created = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  window.localStorage.setItem(INSTALL_ID_STORAGE_KEY, created);
  return created;
}
