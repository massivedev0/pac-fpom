import crypto from "node:crypto";

/**
 * Hashes arbitrary string with SHA-256
 *
 * @param {string} input Raw input string
 * @returns {string} Hex-encoded hash
 */
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Builds HMAC SHA-256 digest for signed values
 *
 * @param {string} secret Shared secret
 * @param {string} input Raw input string
 * @returns {string} Hex-encoded HMAC digest
 */
export function hmacSha256Hex(secret: string, input: string): string {
  return crypto.createHmac("sha256", secret).update(input).digest("hex");
}

/**
 * Compares strings in constant time when lengths match
 *
 * @param {string} a Left string
 * @param {string} b Right string
 * @returns {boolean} True when strings are equal
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Generates random URL-safe token
 *
 * @param {number} [bytes=24] Random byte length
 * @returns {string} URL-safe token
 */
export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Extracts best-effort client IP from request headers
 *
 * @param {Record<string, unknown>} headers Request headers
 * @param {string} [fallback="unknown"] Fallback IP label
 * @returns {string} Resolved client IP
 */
export function extractIpFromRequest(headers: Record<string, unknown>, fallback = "unknown"): string {
  const forwarded = String(headers["x-forwarded-for"] ?? "").trim();
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || fallback;
  }
  const realIp = String(headers["x-real-ip"] ?? "").trim();
  if (realIp) {
    return realIp;
  }
  return fallback;
}

/**
 * Validates Massa address prefix and base58-like body shape
 *
 * @param {string} address Candidate Massa address
 * @returns {boolean} True when string looks like Massa address
 */
export function isLikelyMassaAddress(address: string): boolean {
  return /^A[US][1-9A-HJ-NP-Za-km-z]{20,120}$/.test(address);
}
