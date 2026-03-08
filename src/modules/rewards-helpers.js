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
 * Collects browser, OS, and device hints for backend risk logs and Slack notifications
 *
 * @returns {Record<string, unknown>} Structured client device snapshot
 */
export function getClientDeviceInfo() {
  const uaData = navigator.userAgentData
    ? {
        brands: Array.isArray(navigator.userAgentData.brands)
          ? navigator.userAgentData.brands.map((brand) => ({
              brand: String(brand.brand || ""),
              version: String(brand.version || ""),
            }))
          : [],
        mobile: Boolean(navigator.userAgentData.mobile),
        platform: navigator.userAgentData.platform || "",
      }
    : null;

  return {
    userAgent: navigator.userAgent || "",
    language: navigator.language || "",
    languages: Array.isArray(navigator.languages)
      ? navigator.languages.filter((value) => typeof value === "string" && value.trim())
      : [],
    platform: navigator.platform || "",
    vendor: navigator.vendor || "",
    product: navigator.product || "",
    cookieEnabled: Boolean(navigator.cookieEnabled),
    onLine: Boolean(navigator.onLine),
    maxTouchPoints: Number(navigator.maxTouchPoints || 0),
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    deviceMemoryGb: Number(navigator.deviceMemory || 0),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    screen: window.screen
      ? {
          width: Number(window.screen.width || 0),
          height: Number(window.screen.height || 0),
          availWidth: Number(window.screen.availWidth || 0),
          availHeight: Number(window.screen.availHeight || 0),
          colorDepth: Number(window.screen.colorDepth || 0),
          pixelDepth: Number(window.screen.pixelDepth || 0),
          devicePixelRatio: Number(window.devicePixelRatio || 1),
        }
      : null,
    userAgentData: uaData,
  };
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
