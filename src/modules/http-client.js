/**
 * Executes JSON POST request against rewards backend.
 *
 * @param {string} baseUrl - API base URL without trailing slash.
 * @param {string} path - Endpoint path starting with '/'.
 * @param {unknown} body - JSON-serializable payload.
 * @param {number} timeoutMs - Request timeout in milliseconds.
 * @returns {Promise<any>} Parsed JSON payload.
 */
export async function apiPostJson(baseUrl, path, body, timeoutMs) {
  return requestJson(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
}

/**
 * Executes JSON GET request against rewards backend.
 *
 * @param {string} baseUrl - API base URL without trailing slash.
 * @param {string} path - Endpoint path starting with '/'.
 * @param {number} timeoutMs - Request timeout in milliseconds.
 * @returns {Promise<any>} Parsed JSON payload.
 */
export async function apiGetJson(baseUrl, path, timeoutMs) {
  return requestJson(baseUrl, path, { method: "GET" }, timeoutMs);
}

/**
 * Shared fetch helper that applies timeout and unified backend error handling.
 *
 * @param {string} baseUrl - API base URL without trailing slash.
 * @param {string} path - Endpoint path starting with '/'.
 * @param {RequestInit} init - Fetch init object.
 * @param {number} timeoutMs - Request timeout in milliseconds.
 * @returns {Promise<any>} Parsed JSON payload.
 */
async function requestJson(baseUrl, path, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
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
