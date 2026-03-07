import crypto from "node:crypto";

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, input: string): string {
  return crypto.createHmac("sha256", secret).update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

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

// Massa addresses can start with AU (user) or AS (smart contract).
export function isLikelyMassaAddress(address: string): boolean {
  return /^A[US][1-9A-HJ-NP-Za-km-z]{20,120}$/.test(address);
}
