import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { getConfig } from "../src/config.js";

type CliOptions = {
  claimId?: string;
  json: boolean;
};

type LinksPayload = {
  baseUrl: string;
  payoutListUrl: string;
  claim?: {
    claimId: string;
    approveUrl: string;
    rejectUrl: string;
    retryUrl: string;
  };
};

const SCRIPT_PATH = process.argv[1]
  ? path.resolve(process.argv[1])
  : path.join(process.cwd(), "scripts", "admin-links.ts");
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const BACKEND_DIR = path.resolve(SCRIPT_DIR, "..");
const ENV_FILE = path.join(BACKEND_DIR, ".env");

/**
 * Loads local `.env` file into process env without overriding existing variables
 *
 * @returns {Promise<void>}
 */
async function loadLocalEnvFile(): Promise<void> {
  try {
    const raw = await readFile(ENV_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Parses CLI flags for admin link printer
 *
 * @param {string[]} argv Raw CLI arguments
 * @returns {CliOptions} Parsed options
 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--claim" && next) {
      options.claimId = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

/**
 * Builds HMAC token for admin action scope
 *
 * @param {string} secret Shared admin secret
 * @param {string} scope Admin action scope
 * @returns {string} Hex-encoded token
 */
function buildScopeToken(secret: string, scope: string): string {
  return crypto.createHmac("sha256", secret).update(scope).digest("hex");
}

/**
 * Builds admin URLs from current backend config
 *
 * @param {CliOptions} options Parsed CLI options
 * @returns {LinksPayload} Admin URLs payload
 */
function buildLinksPayload(options: CliOptions): LinksPayload {
  const config = getConfig(process.env);
  const baseUrl = config.adminReviewBaseUrl;
  const secret = config.adminReviewSecret;

  if (!baseUrl) {
    throw new Error("ADMIN_REVIEW_BASE_URL is not configured");
  }
  if (!secret) {
    throw new Error("ADMIN_REVIEW_SECRET is not configured");
  }

  const payload: LinksPayload = {
    baseUrl,
    payoutListUrl: `${baseUrl}/admin/payouts?token=${buildScopeToken(secret, "payouts:list")}`,
  };

  if (options.claimId) {
    const claimId = options.claimId;
    payload.claim = {
      claimId,
      approveUrl: `${baseUrl}/admin/review/${encodeURIComponent(claimId)}?action=approve&token=${buildScopeToken(secret, `${claimId}:approve`)}`,
      rejectUrl: `${baseUrl}/admin/review/${encodeURIComponent(claimId)}?action=reject&token=${buildScopeToken(secret, `${claimId}:reject`)}`,
      retryUrl: `${baseUrl}/admin/payouts/${encodeURIComponent(claimId)}?action=retry&token=${buildScopeToken(secret, `payout:${claimId}:retry`)}`,
    };
  }

  return payload;
}

/**
 * Renders human-readable admin link output
 *
 * @param {LinksPayload} payload Admin URLs payload
 * @returns {string} Printable terminal output
 */
function renderText(payload: LinksPayload): string {
  const lines = [
    "FPOM admin links",
    `Base URL: ${payload.baseUrl}`,
    "",
    "Pending payouts:",
    payload.payoutListUrl,
  ];

  if (payload.claim) {
    lines.push(
      "",
      `Claim ${payload.claim.claimId}:`,
      `Approve: ${payload.claim.approveUrl}`,
      `Reject: ${payload.claim.rejectUrl}`,
      `Retry payout: ${payload.claim.retryUrl}`,
    );
  }

  return lines.join("\n");
}

/**
 * Loads env, builds URLs, and prints them to stdout
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  await loadLocalEnvFile();
  const options = parseArgs(process.argv.slice(2));
  const payload = buildLinksPayload(options);

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(renderText(payload));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
