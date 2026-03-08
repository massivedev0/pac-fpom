import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { type AppConfig, getConfig } from "./config.js";
import {
  createMassaPayoutSender,
  type PayoutBalanceSnapshot,
  type PayoutSender,
} from "./massa-payout.js";
import {
  computeServerScore,
  computeTelemetryScore,
  normalizeRunSummary,
  type ScoringSessionEvent,
} from "./scoring.js";
import {
  extractIpFromRequest,
  hmacSha256Hex,
  isLikelyMassaAddress,
  randomToken,
  safeEqual,
  sha256Hex,
} from "./utils.js";

const BALANCE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BALANCE_MONITOR_INTERVAL_MS = 60 * 60 * 1000;
const RECONCILIATION_RETRY_DELAY_MS = 30 * 1000;

const VERIFICATION_MODES = {
  wallet_signature: "wallet_signature",
  address_only: "address_only",
} as const;
const DEFAULT_VERIFICATION_MODE = VERIFICATION_MODES.address_only;

const CLAIM_STATUSES = {
  PREPARED: "PREPARED",
  CONFIRMED: "CONFIRMED",
  PAID: "PAID",
  REJECTED: "REJECTED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
} as const;

const PAYOUT_STATUSES = {
  QUEUED: "QUEUED",
  PAID: "PAID",
  FAILED: "FAILED",
} as const;

const sessionStartSchema = z.object({
  fingerprint: z.string().trim().min(8).max(500).optional(),
});

const sessionEventSchema = z.object({
  sessionId: z.string().trim().min(8),
  events: z.array(z.any()).max(1000),
  startSeq: z.number().int().min(0).optional(),
});

const runSummarySchema = z.object({
  won: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  pelletsEaten: z.number().int().nonnegative(),
  powerPelletsEaten: z.number().int().nonnegative(),
  enemiesEaten: z.number().int().nonnegative(),
  finalScoreClient: z.number().int().nonnegative(),
});

const clientDeviceSchema = z.record(z.unknown());

const claimPrepareSchema = z.object({
  sessionId: z.string().trim().min(8),
  address: z.string().trim().min(10),
  xProfile: z.string().trim().min(10).max(200),
  clientWallet: z.string().trim().min(2).max(120).optional(),
  clientDevice: clientDeviceSchema.optional(),
  verificationMode: z
    .enum([VERIFICATION_MODES.wallet_signature, VERIFICATION_MODES.address_only])
    .default(DEFAULT_VERIFICATION_MODE),
  run: runSummarySchema,
  fingerprint: z.string().trim().min(8).max(500).optional(),
});

const claimConfirmSchema = z.object({
  claimId: z.string().trim().min(8),
  signature: z.string().trim().min(10).max(5000).optional(),
});

type AuditLogInput = {
  level?: "INFO" | "WARN" | "ERROR";
  event: string;
  message?: string;
  claimId?: string | null;
  sessionId?: string | null;
  address?: string | null;
  payload?: Record<string, unknown> | null;
};

type CreateAppOptions = {
  config?: AppConfig;
  prisma?: PrismaClient;
  payoutSender?: PayoutSender | null;
  enableBackgroundWorkers?: boolean;
};

type PayoutContext = {
  claimId: string;
  sessionId: string;
  address: string;
  xProfile: string;
  clientWallet?: string | null;
  clientDevice?: string | null;
  details?: string[] | null;
  amount: number;
  verificationMode: string;
  riskScore?: number | null;
  txHash?: string;
  dryRun?: boolean;
  reason?: string;
  balanceSnapshot?: PayoutBalanceSnapshot | null;
  projectedFpomBalanceRaw?: string;
};

type ManualReviewAction = "approve" | "reject";
type AdminPayoutAction = "retry";

type PayoutOptions = {
  bypassManualReviewGuards?: boolean;
};

const X_PROFILE_REGEX = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/?$/;

/**
 * Normalizes X profile URL into canonical lowercase form
 *
 * @param {string} input Raw X profile URL
 * @returns {string | null} Canonical profile URL or null when invalid
 */
function normalizeXProfileUrl(input: string): string | null {
  const trimmed = input.trim();
  const match = X_PROFILE_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }
  const username = match[1].toLowerCase();
  return `https://x.com/${username}`;
}

/**
 * Returns safe X profile fallback for logs and messages
 *
 * @param {string | null | undefined} value Stored X profile value
 * @returns {string} Existing profile or placeholder URL
 */
function safeXProfile(value: string | null | undefined): string {
  return value ?? "https://x.com/unknown";
}

/**
 * Returns safe wallet-provider label for logs and Slack notifications
 *
 * @param {string | null | undefined} value Stored wallet label
 * @returns {string} Existing wallet label or placeholder
 */
function safeClientWallet(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  return normalized || "unknown";
}

/**
 * Serializes client device metadata into JSON for persistence
 *
 * @param {Record<string, unknown> | undefined} value Parsed device payload
 * @returns {string | null} Serialized JSON or null when unavailable
 */
function serializeClientDevice(value: Record<string, unknown> | undefined): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Formats persisted client device metadata for Slack notifications
 *
 * @param {string | null | undefined} value Stored client device JSON
 * @returns {string} Compact device description
 */
function formatSlackClientDevice(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "unknown";
  }

  try {
    return JSON.stringify(JSON.parse(normalized));
  } catch {
    return normalized;
  }
}

/**
 * Parses persisted session-event payload into scoring-friendly shape
 *
 * @param {string} payload Stored session-event JSON string
 * @returns {ScoringSessionEvent | null} Parsed event envelope or `null`
 */
function parseSessionEventPayload(payload: string): ScoringSessionEvent | null {
  try {
    const parsed = JSON.parse(payload) as ScoringSessionEvent;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Escapes HTML entities for admin review page rendering
 *
 * @param {string | number | null | undefined} value Raw value
 * @returns {string} Escaped HTML string
 */
function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Builds signed admin review token for approve/reject links
 *
 * @param {string} secret Shared review secret
 * @param {string} claimId Claim id
 * @param {ManualReviewAction} action Review action
 * @returns {string} HMAC token
 */
function buildManualReviewToken(secret: string, claimId: string, action: ManualReviewAction): string {
  return hmacSha256Hex(secret, `${claimId}:${action}`);
}

/**
 * Builds signed admin token for payout-list and retry actions
 *
 * @param {string} secret Shared review secret
 * @param {string} scope Admin action scope
 * @returns {string} HMAC token
 */
function buildAdminScopeToken(secret: string, scope: string): string {
  return hmacSha256Hex(secret, scope);
}

/**
 * Validates signed admin review token
 *
 * @param {string} secret Shared review secret
 * @param {string} claimId Claim id
 * @param {ManualReviewAction} action Review action
 * @param {string} token Provided token
 * @returns {boolean} True when token matches expected signature
 */
function isValidManualReviewToken(
  secret: string,
  claimId: string,
  action: ManualReviewAction,
  token: string,
): boolean {
  if (!secret || !token) {
    return false;
  }
  const expected = buildManualReviewToken(secret, claimId, action);
  return safeEqual(expected, token);
}

/**
 * Builds one-click admin review link for Slack notification
 *
 * @param {AppConfig} config Backend config
 * @param {string} claimId Claim id
 * @param {ManualReviewAction} action Review action
 * @returns {string | null} Fully qualified review URL or null when review links are disabled
 */
function buildManualReviewLink(
  config: AppConfig,
  claimId: string,
  action: ManualReviewAction,
): string | null {
  if (!config.adminReviewBaseUrl || !config.adminReviewSecret) {
    return null;
  }
  const token = buildManualReviewToken(config.adminReviewSecret, claimId, action);
  return `${config.adminReviewBaseUrl}/admin/review/${encodeURIComponent(claimId)}?action=${action}&token=${token}`;
}

/**
 * Builds token-protected admin payout list link
 *
 * @param {AppConfig} config Backend config
 * @returns {string | null} Payout list URL or null when admin links are disabled
 */
function buildAdminPayoutListLink(config: AppConfig): string | null {
  if (!config.adminReviewBaseUrl || !config.adminReviewSecret) {
    return null;
  }
  const token = buildAdminScopeToken(config.adminReviewSecret, "payouts:list");
  return `${config.adminReviewBaseUrl}/admin/payouts?token=${token}`;
}

/**
 * Builds token-protected admin payout retry link
 *
 * @param {AppConfig} config Backend config
 * @param {string} claimId Claim id
 * @returns {string | null} Retry URL or null when admin links are disabled
 */
function buildAdminPayoutRetryLink(config: AppConfig, claimId: string): string | null {
  if (!config.adminReviewBaseUrl || !config.adminReviewSecret) {
    return null;
  }
  const token = buildAdminScopeToken(config.adminReviewSecret, `payout:${claimId}:retry`);
  return `${config.adminReviewBaseUrl}/admin/payouts/${encodeURIComponent(claimId)}?action=retry&token=${token}`;
}

/**
 * Renders admin review result page for approve/reject links
 *
 * @param {{
 *   title: string;
 *   summary: string;
 *   claim?: {
 *     id: string;
 *     sessionId: string;
 *     status: string;
 *     address: string;
 *     xProfile: string | null;
 *     amount: number;
 *     verificationMode: string;
 *     txHash: string | null;
 *     createdAt: Date;
 *     updatedAt: Date;
 *   } | null;
 * }} input Page content
 * @returns {string} Rendered HTML page
 */
function renderAdminReviewPage(input: {
  title: string;
  summary: string;
  claim?: {
    id: string;
    sessionId: string;
    status: string;
    address: string;
    xProfile: string | null;
    amount: number;
    verificationMode: string;
    txHash: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}): string {
  const claim = input.claim;
  const rows = claim
    ? [
        ["Claim ID", claim.id],
        ["Session ID", claim.sessionId],
        ["Status", claim.status],
        ["Address", claim.address],
        ["X profile", safeXProfile(claim.xProfile)],
        ["Amount", `${claim.amount.toLocaleString("en-US")} FPOM`],
        ["Verification", claim.verificationMode],
        ["Tx hash", claim.txHash || "-"],
        ["Created", claim.createdAt.toISOString()],
        ["Updated", claim.updatedAt.toISOString()],
      ]
    : [];

  const detailsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)}</title>
    <style>
      body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0f172a; color: #e2e8f0; }
      main { max-width: 840px; margin: 0 auto; padding: 32px 20px 48px; }
      h1 { margin: 0 0 12px; font-size: 32px; color: #f8fafc; }
      p { margin: 0 0 20px; line-height: 1.6; color: #cbd5e1; }
      .panel { border: 1px solid #334155; border-radius: 16px; background: #111827; overflow: hidden; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #1f2937; vertical-align: top; }
      th { width: 180px; color: #93c5fd; }
      td { color: #f8fafc; word-break: break-word; }
      tr:last-child th, tr:last-child td { border-bottom: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.summary)}</p>
      <section class="panel">
        <table>${detailsHtml}</table>
      </section>
    </main>
  </body>
</html>`;
}

/**
 * Renders admin payout list page
 *
 * @param {{
 *   title: string;
 *   summary: string;
 *   rows: Array<{
 *     claimId: string;
 *     status: string;
 *     payoutStatus: string;
 *     amount: number;
 *     address: string;
 *     txHash: string | null;
 *     updatedAt: Date;
 *     retryLink: string | null;
 *   }>;
 * }} input Page content
 * @returns {string} Rendered HTML page
 */
function renderAdminPayoutListPage(input: {
  title: string;
  summary: string;
  rows: Array<{
    claimId: string;
    status: string;
    payoutStatus: string;
    amount: number;
    address: string;
    txHash: string | null;
    updatedAt: Date;
    retryLink: string | null;
  }>;
}): string {
  const rowsHtml = input.rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.claimId)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.payoutStatus)}</td>
        <td>${escapeHtml(row.amount.toLocaleString("en-US"))}</td>
        <td>${escapeHtml(row.address)}</td>
        <td>${escapeHtml(row.txHash || "-")}</td>
        <td>${escapeHtml(row.updatedAt.toISOString())}</td>
        <td>${row.retryLink ? `<a href="${escapeHtml(row.retryLink)}">Retry</a>` : "-"}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)}</title>
    <style>
      body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0f172a; color: #e2e8f0; }
      main { max-width: 1200px; margin: 0 auto; padding: 32px 20px 48px; }
      h1 { margin: 0 0 12px; font-size: 32px; color: #f8fafc; }
      p { margin: 0 0 20px; line-height: 1.6; color: #cbd5e1; }
      .panel { border: 1px solid #334155; border-radius: 16px; background: #111827; overflow: hidden; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #1f2937; vertical-align: top; }
      th { color: #93c5fd; }
      td { color: #f8fafc; word-break: break-word; }
      tr:last-child th, tr:last-child td { border-bottom: 0; }
      a { color: #fca5a5; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.summary)}</p>
      <section class="panel">
        <table>
          <thead>
            <tr>
              <th>Claim ID</th>
              <th>Claim status</th>
              <th>Payout job</th>
              <th>Amount</th>
              <th>Address</th>
              <th>Tx hash</th>
              <th>Updated</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}

/**
 * Builds Fastify logger config with optional pretty transport
 *
 * @param {AppConfig} config Backend config
 * @returns {object} Fastify logger options
 */
function createLoggerOptions(config: AppConfig) {
  if (config.prettyLogs) {
    return {
      level: config.logLevel,
      transport: {
        target: "pino-pretty",
        options: {
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          singleLine: true,
        },
      },
    };
  }
  return { level: config.logLevel };
}

/**
 * Creates audit log writer that mirrors entries to Fastify logger and Prisma
 *
 * @param {PrismaClient} prisma Prisma client
 * @param {FastifyBaseLogger} logger Fastify logger
 * @returns {(input: AuditLogInput) => Promise<void>} Audit writer function
 */
function createAuditWriter(prisma: PrismaClient, logger: FastifyBaseLogger) {
  return async function writeAuditLog(input: AuditLogInput): Promise<void> {
    const level = input.level ?? "INFO";
    const payload = input.payload ?? undefined;

    if (level === "ERROR") {
      logger.error(
        {
          auditEvent: input.event,
          claimId: input.claimId,
          sessionId: input.sessionId,
          address: input.address,
          payload,
        },
        input.message ?? input.event,
      );
    } else if (level === "WARN") {
      logger.warn(
        {
          auditEvent: input.event,
          claimId: input.claimId,
          sessionId: input.sessionId,
          address: input.address,
          payload,
        },
        input.message ?? input.event,
      );
    } else {
      logger.info(
        {
          auditEvent: input.event,
          claimId: input.claimId,
          sessionId: input.sessionId,
          address: input.address,
          payload,
        },
        input.message ?? input.event,
      );
    }

    try {
      await prisma.auditLog.create({
        data: {
          level,
          event: input.event,
          message: input.message,
          claimId: input.claimId ?? null,
          sessionId: input.sessionId ?? null,
          address: input.address ?? null,
          payload: payload ? JSON.stringify(payload) : null,
        },
      });
    } catch (error) {
      logger.error({ err: error, auditEvent: input.event }, "Failed to persist audit log");
    }
  };
}

/**
 * Formats human-readable Slack message for successful payout events
 *
 * @param {AppConfig} config Backend config
 * @param {PayoutContext} context Payout context
 * @returns {string} Slack message text
 */
function formatSlackPayoutMessage(config: AppConfig, context: PayoutContext): string {
  const payoutMode = context.dryRun ? "DRY RUN" : "REAL";
  return [
    "FPOM payout event",
    `Mode: ${payoutMode}`,
    `Claim ID: ${context.claimId}`,
    `Session ID: ${context.sessionId}`,
    `Address: ${context.address}`,
    `X profile: ${context.xProfile}`,
    `Client wallet: ${safeClientWallet(context.clientWallet)}`,
    `Client device: ${formatSlackClientDevice(context.clientDevice)}`,
    `Amount: ${context.amount.toLocaleString("en-US")} FPOM`,
    `Verification: ${context.verificationMode}`,
    context.riskScore === undefined ? undefined : `Risk score: ${context.riskScore}`,
    context.txHash ? `Tx hash: ${context.txHash}` : undefined,
    context.txHash ? formatExplorerSlackLine(context.txHash, config.massaExplorerTxUrlTemplate) : undefined,
    context.balanceSnapshot ? `Payout wallet MAS: ${context.balanceSnapshot.masBalanceMas}` : undefined,
    context.balanceSnapshot
      ? `Payout wallet FPOM: ${context.balanceSnapshot.fpomBalanceTokens}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Converts technical payout/manual-review reason into human-readable text
 *
 * @param {string | undefined} reason Machine-friendly reason
 * @returns {string} Human-readable reason
 */
function describeReason(reason: string | undefined): string {
  const value = String(reason || "unknown").trim();
  const lower = value.toLowerCase();

  if (lower.startsWith("rpc_unreachable:")) {
    return `RPC node is unreachable: ${value.slice("rpc_unreachable:".length)}`;
  }
  if (lower.startsWith("rpc_timeout:")) {
    return `RPC node timed out: ${value.slice("rpc_timeout:".length)}`;
  }
  if (lower.startsWith("insufficient_mas_balance:")) {
    return `Not enough MAS for gas: ${value.slice("insufficient_mas_balance:".length)}`;
  }
  if (lower.startsWith("insufficient_fpom_balance:")) {
    return `Not enough FPOM in payout wallet: ${value.slice("insufficient_fpom_balance:".length)}`;
  }
  if (lower.startsWith("onchain_payout_failed:")) {
    return `On-chain payout failed: ${describeReason(value.slice("onchain_payout_failed:".length))}`;
  }
  if (lower.startsWith("operation_failed:")) {
    return `Operation failed: ${value.slice("operation_failed:".length)}`;
  }
  if (lower.startsWith("single_payout_limit_exceeded:")) {
    return `Single payout exceeds limit ${value.slice("single_payout_limit_exceeded:".length)} FPOM`;
  }
  if (lower.startsWith("daily_payout_limit_exceeded:")) {
    return `Daily payout limit reached: ${value.slice("daily_payout_limit_exceeded:".length)}`;
  }
  if (lower === "real_payout_not_configured") {
    return "Real payout sender is not configured";
  }
  if (lower === "risk_threshold_exceeded") {
    return "Claim exceeded automatic risk threshold";
  }
  if (lower === "missing_x_profile") {
    return "Claim is missing X profile";
  }

  return value;
}

/**
 * Formats human-readable Slack message for manual review requests
 *
 * @param {AppConfig} config Backend config
 * @param {PayoutContext} context Payout context
 * @returns {string} Slack message text
 */
function formatSlackManualReviewMessage(config: AppConfig, context: PayoutContext): string {
  const approveLink = buildManualReviewLink(config, context.claimId, "approve");
  const rejectLink = buildManualReviewLink(config, context.claimId, "reject");

  return [
    "FPOM manual review requested",
    `Reason: ${describeReason(context.reason)}`,
    context.details && context.details.length > 0 ? `Details: ${context.details.join("; ")}` : undefined,
    `Claim ID: ${context.claimId}`,
    `Session ID: ${context.sessionId}`,
    `Address: ${context.address}`,
    `X profile: ${context.xProfile}`,
    `Client wallet: ${safeClientWallet(context.clientWallet)}`,
    `Client device: ${formatSlackClientDevice(context.clientDevice)}`,
    `Amount: ${context.amount.toLocaleString("en-US")} FPOM`,
    `Verification: ${context.verificationMode}`,
    context.riskScore === undefined ? undefined : `Risk score: ${context.riskScore}`,
    context.txHash ? `Tx hash: ${context.txHash}` : undefined,
    context.txHash ? formatExplorerSlackLine(context.txHash, config.massaExplorerTxUrlTemplate) : undefined,
    context.balanceSnapshot ? `Payout wallet MAS: ${context.balanceSnapshot.masBalanceMas}` : undefined,
    context.balanceSnapshot
      ? `Payout wallet FPOM: ${context.balanceSnapshot.fpomBalanceTokens}`
      : undefined,
    approveLink ? `Approve: ${approveLink}` : undefined,
    rejectLink ? `Reject: ${rejectLink}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

type RiskAssessmentInput = {
  verificationMode: string;
  ipClaims24h: number;
  fpClaims24h: number;
  sessionEventsCount: number;
  runDurationMs: number;
  minRunDurationMs: number;
  maxRunDurationMs: number;
  finalScoreClient: number;
  finalScoreServer: number;
  ipClaimsPerDayLimit: number;
};

type RiskAssessment = {
  risk: number;
  details: string[];
  scoreDiff: number;
  scoreDiffThreshold: number;
};

/**
 * Computes risk score and human-readable factors for a claim verification attempt
 *
 * @param {RiskAssessmentInput} input Verification counters and run metrics
 * @returns {RiskAssessment} Risk score with detailed contributing factors
 */
function computeRiskAssessment(input: RiskAssessmentInput): RiskAssessment {
  let risk = 0;
  const details: string[] = [];

  if (input.verificationMode === VERIFICATION_MODES.address_only) {
    risk += 2;
    details.push("address-only verification (+2)");
  }
  if (input.ipClaims24h >= input.ipClaimsPerDayLimit) {
    risk += 5;
    details.push(
      `IP seen in ${input.ipClaims24h} claims during last 24h (limit ${input.ipClaimsPerDayLimit}) (+5)`,
    );
  }
  if (input.fpClaims24h >= 3) {
    risk += 3;
    details.push(`fingerprint seen in ${input.fpClaims24h} claims during last 24h (+3)`);
  }
  if (input.sessionEventsCount === 0) {
    risk += 2;
    details.push("no gameplay telemetry events received (+2)");
  } else if (input.sessionEventsCount < 5) {
    risk += 1;
    details.push(`very low gameplay telemetry count: ${input.sessionEventsCount} (+1)`);
  }
  if (input.sessionEventsCount > 5000) {
    risk += 2;
    details.push(`excessive gameplay telemetry count: ${input.sessionEventsCount} (+2)`);
  }
  if (
    input.runDurationMs < input.minRunDurationMs ||
    input.runDurationMs > input.maxRunDurationMs
  ) {
    risk += 3;
    details.push(
      `run duration ${input.runDurationMs}ms outside ${input.minRunDurationMs}-${input.maxRunDurationMs}ms (+3)`,
    );
  }

  const scoreDiff = Math.abs(input.finalScoreClient - input.finalScoreServer);
  const scoreDiffThreshold = Math.max(500, Math.floor(input.finalScoreServer * 0.2));
  if (scoreDiff > scoreDiffThreshold) {
    risk += 2;
    details.push(
      `client/server score diff ${scoreDiff} exceeds threshold ${scoreDiffThreshold} (+2)`,
    );
  }

  return {
    risk,
    details,
    scoreDiff,
    scoreDiffThreshold,
  };
}

/**
 * Formats Slack message for low-balance alerts
 *
 * @param {{
 *   source: string;
 *   thresholdTokens: number;
 *   balanceSnapshot: PayoutBalanceSnapshot;
 *   currentFpomTokens: string;
 * }} input Low-balance alert context
 * @returns {string} Slack message text
 */
function formatSlackLowBalanceMessage(input: {
  source: string;
  thresholdTokens: number;
  balanceSnapshot: PayoutBalanceSnapshot;
  currentFpomTokens: string;
}): string {
  return [
    "FPOM payout wallet balance is low",
    `Source: ${input.source}`,
    `Threshold: ${input.thresholdTokens.toLocaleString("en-US")} FPOM`,
    `Current FPOM balance: ${input.currentFpomTokens}`,
    `Current MAS balance: ${input.balanceSnapshot.masBalanceMas}`,
    `Payout wallet: ${input.balanceSnapshot.payoutAddress}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds explorer URL from configured template and transaction hash
 *
 * @param {string} txHash Operation hash
 * @param {string} template Explorer URL template or base URL
 * @returns {string} Explorer URL or empty string
 */
function buildExplorerTxUrl(txHash: string, template: string): string {
  const normalizedTxHash = String(txHash || "").trim();
  const normalizedTemplate = String(template || "").trim();
  if (!normalizedTxHash || !normalizedTemplate) {
    return "";
  }

  if (normalizedTemplate.includes("{txHash}")) {
    return normalizedTemplate.replaceAll("{txHash}", encodeURIComponent(normalizedTxHash));
  }

  const separator = normalizedTemplate.endsWith("/") ? "" : "/";
  return `${normalizedTemplate}${separator}${encodeURIComponent(normalizedTxHash)}`;
}

/**
 * Formats optional explorer line for Slack messages
 *
 * @param {string} txHash Operation hash
 * @param {string} template Explorer URL template or base URL
 * @returns {string | undefined} Explorer line when URL can be built
 */
function formatExplorerSlackLine(txHash: string, template: string): string | undefined {
  const url = buildExplorerTxUrl(txHash, template);
  if (!url) {
    return undefined;
  }
  return `Explorer: ${url}`;
}

/**
 * Posts message to configured Slack webhook
 *
 * @param {FastifyInstance} app Fastify app for logging
 * @param {AppConfig} config Backend config
 * @param {string} text Slack message text
 * @returns {Promise<void>}
 */
async function sendSlackNotification(app: FastifyInstance, config: AppConfig, text: string): Promise<void> {
  if (!config.slackWebhookUrl) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);

  try {
    const response = await fetch(config.slackWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      app.log.warn(
        { statusCode: response.status, responseBody: body.slice(0, 300) },
        "Slack webhook returned non-2xx status",
      );
    }
  } catch (error) {
    app.log.warn({ err: error }, "Failed to send Slack notification");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates fully configured Fastify app with rewards, claim, and admin endpoints
 *
 * @param {CreateAppOptions} [options={}] Optional config, Prisma, and payout overrides
 * @returns {FastifyInstance} Ready Fastify app instance
 */
export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const config = options.config ?? getConfig();
  const prisma = options.prisma ?? new PrismaClient();
  const app = Fastify({ logger: createLoggerOptions(config) });
  const payoutSender = options.payoutSender ?? createMassaPayoutSender(config, app.log);
  const enableBackgroundWorkers = options.enableBackgroundWorkers ?? true;
  const writeAuditLog = createAuditWriter(prisma, app.log);
  const allowedOrigins = new Set(config.corsAllowedOrigins);
  const corsMethods = "GET,POST,OPTIONS";
  const corsHeaders = "content-type";
  let balanceMonitorTimer: NodeJS.Timeout | null = null;
  const payoutReconciliationTimers = new Map<string, NodeJS.Timeout>();

  app.addHook("onRequest", async (req, reply) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: "cors_not_allowed" });
    }

    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", corsMethods);
      reply.header("access-control-allow-headers", corsHeaders);
      reply.header("access-control-max-age", "86400");
    }

    if (req.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.addHook("onClose", async () => {
    if (balanceMonitorTimer) {
      clearInterval(balanceMonitorTimer);
      balanceMonitorTimer = null;
    }
    for (const timer of payoutReconciliationTimers.values()) {
      clearTimeout(timer);
    }
    payoutReconciliationTimers.clear();
    await prisma.$disconnect();
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/public/config", async () => ({
    xPromoTweet: config.xPromoTweet,
    txExplorerUrlTemplate: config.massaExplorerTxUrlTemplate,
  }));

  app.post("/session/start", async (req, reply) => {
    const parsed = sessionStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    }

    const ipRaw = extractIpFromRequest(req.headers as Record<string, unknown>, req.ip || "unknown");
    const ipHash = sha256Hex(ipRaw);
    const fpHash = parsed.data.fingerprint ? sha256Hex(parsed.data.fingerprint) : null;
    const nonce = randomToken(24);

    const session = await prisma.session.create({
      data: {
        nonce,
        ipHash,
        fpHash,
      },
    });

    await writeAuditLog({
      event: "SESSION_STARTED",
      sessionId: session.id,
      payload: {
        hasFingerprint: Boolean(parsed.data.fingerprint),
      },
    });

    return {
      sessionId: session.id,
      nonce,
    };
  });

  app.post("/session/event", async (req, reply) => {
    const parsed = sessionEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    }

    const session = await prisma.session.findUnique({ where: { id: parsed.data.sessionId } });
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    const existingCount = await prisma.sessionEvent.count({ where: { sessionId: session.id } });
    const startSeq = parsed.data.startSeq ?? existingCount;
    const eventSeqs = parsed.data.events.map((_, idx) => startSeq + idx);
    const existingEvents = await prisma.sessionEvent.findMany({
      where: {
        sessionId: session.id,
        seq: { in: eventSeqs },
      },
      select: { seq: true },
    });
    const existingSeqSet = new Set(existingEvents.map((event) => event.seq));

    const eventsToInsert = parsed.data.events
      .map((payload, idx) => ({
        sessionId: session.id,
        seq: startSeq + idx,
        payload: JSON.stringify(payload),
      }))
      .filter((event) => !existingSeqSet.has(event.seq));

    if (eventsToInsert.length > 0) {
      await prisma.sessionEvent.createMany({ data: eventsToInsert });
    }

    return {
      sessionId: session.id,
      accepted: eventsToInsert.length,
    };
  });

  app.post("/claim/prepare", async (req, reply) => {
    const parsed = claimPrepareSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    }

    const { sessionId, address, verificationMode } = parsed.data;
    const normalizedXProfile = normalizeXProfileUrl(parsed.data.xProfile);

    if (!isLikelyMassaAddress(address)) {
      return reply.code(400).send({ error: "invalid_address" });
    }
    if (!normalizedXProfile) {
      return reply.code(400).send({ error: "invalid_x_profile" });
    }

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    const existingClaim = await prisma.claim.findUnique({ where: { sessionId } });
    if (existingClaim) {
      await writeAuditLog({
        event: "CLAIM_PREPARE_IDEMPOTENT",
        claimId: existingClaim.id,
        sessionId,
        address: existingClaim.address,
        payload: {
          status: existingClaim.status,
          xProfile: existingClaim.xProfile,
        },
      });

      return {
        claimId: existingClaim.id,
        amount: existingClaim.amount,
        status: existingClaim.status,
        challenge: existingClaim.challenge,
        requiresSignature: existingClaim.verificationMode === VERIFICATION_MODES.wallet_signature,
        alreadyExists: true,
      };
    }

    const paidCount = await prisma.claim.count({
      where: {
        address,
        status: CLAIM_STATUSES.PAID,
      },
    });
    if (paidCount >= config.maxClaimsPerAddress) {
      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_REJECTED_LIMIT_REACHED",
        sessionId,
        address,
        payload: {
          maxClaimsPerAddress: config.maxClaimsPerAddress,
        },
      });

      return reply.code(409).send({
        error: "limit_reached",
        limitType: "address",
        maxClaimsPerAddress: config.maxClaimsPerAddress,
      });
    }

    const paidCountByXProfile = await prisma.claim.count({
      where: {
        xProfile: normalizedXProfile,
        status: CLAIM_STATUSES.PAID,
      },
    });
    if (paidCountByXProfile >= config.maxClaimsPerXProfile) {
      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_REJECTED_X_PROFILE_LIMIT_REACHED",
        sessionId,
        address,
        payload: {
          xProfile: normalizedXProfile,
          maxClaimsPerXProfile: config.maxClaimsPerXProfile,
        },
      });

      return reply.code(409).send({
        error: "limit_reached",
        limitType: "x_profile",
        maxClaimsPerXProfile: config.maxClaimsPerXProfile,
      });
    }

    const run = normalizeRunSummary(parsed.data.run);
    if (!run.won) {
      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_REJECTED_ROUND_NOT_WON",
        sessionId,
        address,
      });

      return reply.code(400).send({ error: "round_not_won" });
    }

    const sessionEvents = await prisma.sessionEvent.findMany({
      where: { sessionId },
      orderBy: [{ seq: "asc" }],
      select: { payload: true },
    });
    const parsedSessionEvents = sessionEvents
      .map((event) => parseSessionEventPayload(event.payload))
      .filter((event): event is ScoringSessionEvent => Boolean(event));
    const telemetryScore = computeTelemetryScore(run, parsedSessionEvents);
    const scoreServer = telemetryScore ?? computeServerScore(run);
    const scoringSource = telemetryScore === null ? "summary_fallback" : "telemetry";
    const challenge = randomToken(32);
    const fpHash = parsed.data.fingerprint ? sha256Hex(parsed.data.fingerprint) : session.fpHash;

    await prisma.run.upsert({
      where: { sessionId },
      update: {
        won: run.won,
        durationMs: run.durationMs,
        pelletsEaten: run.pelletsEaten,
        powerPelletsEaten: run.powerPelletsEaten,
        enemiesEaten: run.enemiesEaten,
        finalScoreClient: run.finalScoreClient,
        finalScoreServer: scoreServer,
      },
      create: {
        sessionId,
        won: run.won,
        durationMs: run.durationMs,
        pelletsEaten: run.pelletsEaten,
        powerPelletsEaten: run.powerPelletsEaten,
        enemiesEaten: run.enemiesEaten,
        finalScoreClient: run.finalScoreClient,
        finalScoreServer: scoreServer,
      },
    });

    const claim = await prisma.claim.create({
      data: {
        sessionId,
        address,
        xProfile: normalizedXProfile,
        clientWallet: parsed.data.clientWallet?.trim() || null,
        clientDevice: serializeClientDevice(parsed.data.clientDevice),
        verificationMode,
        amount: scoreServer,
        challenge,
        ipHash: session.ipHash,
        fpHash,
        status: CLAIM_STATUSES.PREPARED,
      },
    });

    await writeAuditLog({
      event: "CLAIM_PREPARED",
      claimId: claim.id,
      sessionId,
      address,
      payload: {
        verificationMode,
        amount: scoreServer,
        xProfile: normalizedXProfile,
        clientWallet: parsed.data.clientWallet?.trim() || null,
        scoringSource,
        sessionEventsCount: sessionEvents.length,
      },
    });

    return {
      claimId: claim.id,
      amount: claim.amount,
      challenge,
      requiresSignature: verificationMode === VERIFICATION_MODES.wallet_signature,
      verificationMode,
    };
  });

  type ReviewInput = {
    claimId: string;
    signature?: string;
    txHash?: string;
    balanceSnapshot?: PayoutBalanceSnapshot | null;
    projectedFpomBalanceRaw?: string;
    details?: string[];
  };

  /**
   * Loads current payout wallet balance snapshot when sender supports it
   *
   * @returns {Promise<PayoutBalanceSnapshot | null>} Current balance snapshot or null
   */
  async function getCurrentBalanceSnapshot(): Promise<PayoutBalanceSnapshot | null> {
    if (!payoutSender?.getBalanceSnapshot) {
      return null;
    }

    try {
      return await payoutSender.getBalanceSnapshot();
    } catch (error) {
      app.log.warn({ err: error }, "Failed to load payout wallet balances");
      return null;
    }
  }

  /**
   * Sends low-balance alert at most once per 24 hours
   *
   * @param {string} source Alert source label
   * @param {PayoutBalanceSnapshot | null} [balanceSnapshot] Optional preloaded balance snapshot
   * @param {string} [projectedFpomBalanceRaw] Optional projected FPOM balance after queued payout
   * @returns {Promise<void>}
   */
  async function notifyLowBalanceIfNeeded(
    source: string,
    balanceSnapshot?: PayoutBalanceSnapshot | null,
    projectedFpomBalanceRaw?: string,
  ): Promise<void> {
    if (config.notifyBalanceBelow <= 0 || !config.slackWebhookUrl || !payoutSender?.getBalanceSnapshot) {
      return;
    }

    const snapshot = balanceSnapshot ?? (await getCurrentBalanceSnapshot());
    if (!snapshot) {
      return;
    }

    const thresholdTokens = Math.max(0, Math.floor(config.notifyBalanceBelow));
    const tokenDecimals = snapshot.tokenDecimals;
    const thresholdRaw = BigInt(thresholdTokens) * 10n ** BigInt(tokenDecimals);
    const currentRaw = BigInt(projectedFpomBalanceRaw ?? snapshot.fpomBalanceRaw);
    if (currentRaw >= thresholdRaw) {
      return;
    }

    const recentAlert = await prisma.auditLog.findFirst({
      where: {
        event: "BALANCE_LOW_ALERT_SENT",
        createdAt: { gte: new Date(Date.now() - BALANCE_ALERT_COOLDOWN_MS) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (recentAlert) {
      return;
    }

    const currentFpomTokens = (() => {
      const value = currentRaw.toString().padStart(tokenDecimals + 1, "0");
      const whole = value.slice(0, -tokenDecimals) || "0";
      const fraction = value.slice(-tokenDecimals).replace(/0+$/, "");
      return fraction ? `${whole}.${fraction}` : whole;
    })();

    await sendSlackNotification(
      app,
      config,
      formatSlackLowBalanceMessage({
        source,
        thresholdTokens,
        balanceSnapshot: snapshot,
        currentFpomTokens,
      }),
    );

    await writeAuditLog({
      level: "WARN",
      event: "BALANCE_LOW_ALERT_SENT",
      payload: {
        source,
        thresholdTokens,
        payoutAddress: snapshot.payoutAddress,
        masBalanceMas: snapshot.masBalanceMas,
        fpomBalanceTokens: currentFpomTokens,
        projected: Boolean(projectedFpomBalanceRaw),
      },
    });
  }

  /**
   * Clears scheduled reconciliation retry for claim
   *
   * @param {string} claimId Claim id
   */
  function clearPayoutReconciliationTimer(claimId: string): void {
    const timer = payoutReconciliationTimers.get(claimId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    payoutReconciliationTimers.delete(claimId);
  }

  /**
   * Schedules reconciliation retry for still-pending payout
   *
   * @param {string} claimId Claim id
   * @param {string} txHash Submitted transaction hash
   */
  function queuePayoutReconciliationRetry(claimId: string, txHash: string): void {
    clearPayoutReconciliationTimer(claimId);
    const timer = setTimeout(() => {
      payoutReconciliationTimers.delete(claimId);
      schedulePayoutFinalization(claimId, txHash);
    }, RECONCILIATION_RETRY_DELAY_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    payoutReconciliationTimers.set(claimId, timer);
  }

  /**
   * Moves claim into manual review and sends admin notification
   *
   * @param {ReviewInput} input Claim identifiers and optional signature data
   * @param {string} reason Manual review reason
   * @returns {Promise<{ status: string; reason: string; txHash?: string | null }>} Manual review response payload
   */
  async function markAsManualReview(input: ReviewInput, reason: string) {
    const balanceSnapshot = input.balanceSnapshot ?? (await getCurrentBalanceSnapshot());
    const claim = await prisma.claim.update({
      where: { id: input.claimId },
      data: {
        status: CLAIM_STATUSES.MANUAL_REVIEW,
        signature: input.signature,
        txHash: input.txHash,
      },
    });

    await writeAuditLog({
      level: "WARN",
      event: "CLAIM_MANUAL_REVIEW",
      claimId: claim.id,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        reason,
        details: input.details ?? null,
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        xProfile: claim.xProfile,
        balanceSnapshot,
      },
    });

    const run = await prisma.run.findUnique({ where: { sessionId: claim.sessionId } });
    await sendSlackNotification(
      app,
      config,
      formatSlackManualReviewMessage(config, {
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
        xProfile: safeXProfile(claim.xProfile),
        clientWallet: claim.clientWallet,
        clientDevice: claim.clientDevice,
        details: input.details ?? null,
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        riskScore: run?.riskScore ?? null,
        reason,
        txHash: claim.txHash ?? input.txHash,
        balanceSnapshot,
        projectedFpomBalanceRaw: input.projectedFpomBalanceRaw,
      }),
    );

    return {
      status: CLAIM_STATUSES.MANUAL_REVIEW,
      reason,
      details: input.details ?? [],
      txHash: claim.txHash,
    };
  }

  /**
   * Marks payout as fully paid and writes audit trail
   *
   * @param {string} claimId Claim id
   * @param {string} txHash On-chain transaction hash
   * @param {Record<string, unknown>} extraPayload Additional audit payload
   * @param {string} auditEvent Audit event name
   * @returns {Promise<Awaited<ReturnType<typeof prisma.claim.findUnique>>>} Original claim row
   */
  async function markPayoutPaid(
    claimId: string,
    txHash: string,
    extraPayload: Record<string, unknown>,
    auditEvent: string,
  ) {
    const claim = await prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new Error("claim_not_found");
    }
    if (claim.status === CLAIM_STATUSES.PAID && claim.txHash === txHash) {
      return claim;
    }

    await prisma.$transaction([
      prisma.payoutJob.update({
        where: { claimId },
        data: {
          status: PAYOUT_STATUSES.PAID,
          attempts: { increment: 1 },
          lastError: null,
        },
      }),
      prisma.claim.update({
        where: { id: claimId },
        data: {
          status: CLAIM_STATUSES.PAID,
          txHash,
        },
      }),
    ]);

    await writeAuditLog({
      event: auditEvent,
      claimId,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        txHash,
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        xProfile: claim.xProfile,
        ...extraPayload,
      },
    });

    return claim;
  }

  /**
   * Marks payout as submitted but not yet final
   *
   * @param {string} claimId Claim id
   * @param {string} txHash Submitted on-chain transaction hash
   * @param {Record<string, unknown>} extraPayload Additional audit payload
   * @returns {Promise<Awaited<ReturnType<typeof prisma.claim.findUnique>>>} Original claim row
   */
  async function markPayoutSubmitted(
    claimId: string,
    txHash: string,
    extraPayload: Record<string, unknown>,
  ) {
    const claim = await prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new Error("claim_not_found");
    }
    if (claim.status === CLAIM_STATUSES.CONFIRMED && claim.txHash === txHash) {
      return claim;
    }

    await prisma.$transaction([
      prisma.payoutJob.update({
        where: { claimId },
        data: {
          attempts: { increment: 1 },
          lastError: null,
        },
      }),
      prisma.claim.update({
        where: { id: claimId },
        data: {
          status: CLAIM_STATUSES.CONFIRMED,
          txHash,
        },
      }),
    ]);

    await writeAuditLog({
      event: "PAYOUT_SUBMITTED_ONCHAIN",
      claimId,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        txHash,
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        xProfile: claim.xProfile,
        ...extraPayload,
      },
    });

    return claim;
  }

  /**
   * Records payout failure and escalates claim to manual review
   *
   * @param {string} claimId Claim id
   * @param {string} errorMessage Failure reason
   * @param {string} [txHash] Related transaction hash
   * @param {Record<string, unknown>} [extraPayload] Additional audit payload
   * @returns {Promise<{ status: string; reason: string; txHash?: string | null }>} Manual review response payload
   */
  async function markPayoutFailed(
    claimId: string,
    errorMessage: string,
    txHash?: string,
    extraPayload?: Record<string, unknown>,
  ) {
    const claim = await prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new Error("claim_not_found");
    }

    await prisma.$transaction([
      prisma.payoutJob.update({
        where: { claimId },
        data: {
          status: PAYOUT_STATUSES.FAILED,
          attempts: { increment: 1 },
          lastError: errorMessage,
        },
      }),
      prisma.claim.update({
        where: { id: claimId },
        data: {
          txHash,
        },
      }),
    ]);

    await writeAuditLog({
      level: "ERROR",
      event: "PAYOUT_FAILED_ONCHAIN",
      claimId,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        reason: errorMessage,
        txHash,
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        xProfile: claim.xProfile,
        ...(extraPayload ?? {}),
      },
    });

    const balanceSnapshot = (extraPayload?.balanceSnapshot as PayoutBalanceSnapshot | undefined) ?? null;
    await notifyLowBalanceIfNeeded(
      "payout_failed",
      balanceSnapshot,
      typeof extraPayload?.projectedFpomBalanceRaw === "string"
        ? extraPayload.projectedFpomBalanceRaw
        : undefined,
    );

    return markAsManualReview(
      {
        claimId,
        txHash,
        balanceSnapshot,
        projectedFpomBalanceRaw:
          typeof extraPayload?.projectedFpomBalanceRaw === "string"
            ? extraPayload.projectedFpomBalanceRaw
            : undefined,
      },
      `onchain_payout_failed:${errorMessage}`,
    );
  }

  /**
   * Sends Slack notification for already paid claim
   *
   * @param {string} claimId Claim id
   * @param {string} txHash On-chain transaction hash
   * @param {boolean} dryRun Whether payout was simulated
   * @returns {Promise<void>}
   */
  async function notifyPayoutPaid(claimId: string, txHash: string, dryRun: boolean) {
    const [claim, run] = await Promise.all([
      prisma.claim.findUnique({ where: { id: claimId } }),
      prisma.claim
        .findUnique({ where: { id: claimId } })
        .then((currentClaim) =>
          currentClaim ? prisma.run.findUnique({ where: { sessionId: currentClaim.sessionId } }) : null,
        ),
    ]);
    if (!claim) {
      return;
    }

    await sendSlackNotification(
      app,
      config,
      formatSlackPayoutMessage(config, {
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
        xProfile: safeXProfile(claim.xProfile),
        clientWallet: claim.clientWallet,
        clientDevice: claim.clientDevice,
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        riskScore: run?.riskScore ?? null,
        txHash,
        dryRun,
        balanceSnapshot: await getCurrentBalanceSnapshot(),
      }),
    );
  }

  /**
   * Starts background reconciliation for non-final payout
   *
   * @param {string} claimId Claim id
   * @param {string} txHash Submitted on-chain transaction hash
   */
  function schedulePayoutFinalization(claimId: string, txHash: string) {
    if (!payoutSender || config.payoutDryRun) {
      return;
    }
    clearPayoutReconciliationTimer(claimId);

    void payoutSender
      .reconcilePayout(txHash)
      .then(async (reconciliation) => {
        if (reconciliation.outcome === "paid") {
          clearPayoutReconciliationTimer(claimId);
          await markPayoutPaid(
            claimId,
            reconciliation.txHash,
            {
              observedStatus: reconciliation.observedStatus,
            },
            "PAYOUT_PAID_ONCHAIN_RECONCILED",
          );
          await notifyPayoutPaid(claimId, reconciliation.txHash, false);
          return;
        }

        if (reconciliation.outcome === "failed") {
          clearPayoutReconciliationTimer(claimId);
          await markPayoutFailed(
            claimId,
            reconciliation.error,
            reconciliation.txHash,
            {
              observedStatus: reconciliation.observedStatus,
            },
          );
          return;
        }

        queuePayoutReconciliationRetry(claimId, txHash);
      })
      .catch(async (error) => {
        clearPayoutReconciliationTimer(claimId);
        const reason = error instanceof Error ? error.message : "reconcile_failed";
        app.log.warn({ err: error, claimId, txHash }, "Background payout reconciliation failed");
        await markPayoutFailed(claimId, reason, txHash, {
          observedStatus: "RECONCILE_EXCEPTION",
        }).catch(() => {});
      });
  }

  /**
   * Rechecks payout status for claims stuck in confirmed state
   *
   * @param {string} claimId Claim id
   * @returns {Promise<void>}
   */
  async function reconcilePendingPayout(claimId: string) {
    if (!payoutSender || config.payoutDryRun) {
      return;
    }

    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      include: { payoutJob: true },
    });
    if (!claim || claim.status !== CLAIM_STATUSES.CONFIRMED || !claim.txHash) {
      return;
    }

    const reconciliation = await payoutSender.reconcilePayout(claim.txHash);
    if (reconciliation.outcome === "paid") {
      await markPayoutPaid(
        claim.id,
        reconciliation.txHash,
        {
          observedStatus: reconciliation.observedStatus,
        },
        "PAYOUT_PAID_ONCHAIN_RECONCILED",
      );
      return;
    }

    if (reconciliation.outcome === "failed") {
      await markPayoutFailed(
        claim.id,
        reconciliation.error,
        reconciliation.txHash,
        {
          observedStatus: reconciliation.observedStatus,
        },
      );
    }
  }

  /**
   * Queues payout job and executes payout path
   *
   * @param {string} claimId Claim id
   * @param {PayoutOptions} [options={}] Payout execution options
   * @returns {Promise<Record<string, unknown>>} Claim status payload
   */
  async function enqueueAndProcessPayout(claimId: string, options: PayoutOptions = {}) {
    const claim = await prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      await writeAuditLog({
        level: "ERROR",
        event: "PAYOUT_FAILED_CLAIM_NOT_FOUND",
        claimId,
      });
      return {
        status: CLAIM_STATUSES.MANUAL_REVIEW,
        reason: "claim_not_found",
      };
    }

    if (!options.bypassManualReviewGuards && claim.amount > config.maxSinglePayoutAmount) {
      return markAsManualReview(
        { claimId: claim.id },
        `single_payout_limit_exceeded:${config.maxSinglePayoutAmount}`,
      );
    }

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const paidLast24h = await prisma.claim.count({
      where: {
        status: CLAIM_STATUSES.PAID,
        updatedAt: { gte: last24h },
      },
    });
    if (!options.bypassManualReviewGuards && paidLast24h >= config.maxPayoutsPerDay) {
      return markAsManualReview(
        { claimId: claim.id },
        `daily_payout_limit_exceeded:${config.maxPayoutsPerDay}`,
      );
    }

    const run = await prisma.run.findUnique({ where: { sessionId: claim.sessionId } });
    const existing = await prisma.payoutJob.findUnique({ where: { claimId } });
    if (!existing) {
      await prisma.payoutJob.create({
        data: {
          claimId,
          status: PAYOUT_STATUSES.QUEUED,
        },
      });

      await writeAuditLog({
        event: "PAYOUT_QUEUED",
        claimId,
        sessionId: claim.sessionId,
        address: claim.address,
      });
    }

    if (config.payoutDryRun) {
      const txHash = `dryrun_${Date.now().toString(36)}_${claimId.slice(-6)}`;
      await markPayoutPaid(claimId, txHash, {}, "PAYOUT_PAID_DRY_RUN");

      await sendSlackNotification(
        app,
        config,
        formatSlackPayoutMessage(config, {
          claimId: claim.id,
          sessionId: claim.sessionId,
          address: claim.address,
          xProfile: safeXProfile(claim.xProfile),
          clientWallet: claim.clientWallet,
          clientDevice: claim.clientDevice,
          amount: claim.amount,
          verificationMode: claim.verificationMode,
          riskScore: run?.riskScore ?? null,
          txHash,
          dryRun: true,
        }),
      );

      return {
        status: CLAIM_STATUSES.PAID,
        txHash,
        dryRun: true,
      };
    }

    if (!payoutSender?.isConfigured()) {
      await writeAuditLog({
        level: "ERROR",
        event: "PAYOUT_FAILED_NOT_CONFIGURED",
        claimId,
        sessionId: claim.sessionId,
        address: claim.address,
        payload: {
          reason: "real_payout_not_configured",
        },
      });
      return markAsManualReview(
        { claimId: claim.id },
        "real_payout_not_configured",
      );
    }

    try {
      const payoutResult = await payoutSender.sendTokenPayout({
        claimId,
        recipientAddress: claim.address,
        amountTokens: claim.amount,
      });

      if (payoutResult.outcome === "paid") {
        await markPayoutPaid(
          claimId,
          payoutResult.txHash,
          {
            observedStatus: payoutResult.observedStatus,
            rawAmount: payoutResult.rawAmount,
            tokenDecimals: payoutResult.tokenDecimals,
            balanceSnapshot: payoutResult.balanceSnapshot,
            projectedFpomBalanceRaw: payoutResult.projectedFpomBalanceRaw,
          },
          "PAYOUT_PAID_ONCHAIN",
        );
        await notifyLowBalanceIfNeeded(
          "payout_paid",
          payoutResult.balanceSnapshot ?? null,
          payoutResult.projectedFpomBalanceRaw,
        );
        await notifyPayoutPaid(claimId, payoutResult.txHash, false);

        return {
          status: CLAIM_STATUSES.PAID,
          txHash: payoutResult.txHash,
          dryRun: false,
        };
      }

      if (payoutResult.outcome === "pending") {
        await markPayoutSubmitted(claimId, payoutResult.txHash, {
          observedStatus: payoutResult.observedStatus,
          rawAmount: payoutResult.rawAmount,
          tokenDecimals: payoutResult.tokenDecimals,
          balanceSnapshot: payoutResult.balanceSnapshot,
          projectedFpomBalanceRaw: payoutResult.projectedFpomBalanceRaw,
        });
        await notifyLowBalanceIfNeeded(
          "payout_submitted",
          payoutResult.balanceSnapshot ?? null,
          payoutResult.projectedFpomBalanceRaw,
        );
        schedulePayoutFinalization(claimId, payoutResult.txHash);

        return {
          status: CLAIM_STATUSES.CONFIRMED,
          txHash: payoutResult.txHash,
          dryRun: false,
        };
      }

      return markPayoutFailed(
        claimId,
        payoutResult.error,
        payoutResult.txHash,
        {
          observedStatus: payoutResult.observedStatus,
          rawAmount: payoutResult.rawAmount,
          tokenDecimals: payoutResult.tokenDecimals,
          balanceSnapshot: payoutResult.balanceSnapshot,
          projectedFpomBalanceRaw: payoutResult.projectedFpomBalanceRaw,
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown_payout_error";
      return markPayoutFailed(claimId, reason);
    }
  }

  /**
   * Resumes queued or confirmed payouts after backend restart
   *
   * @returns {Promise<void>}
   */
  async function recoverPersistedPayoutState(): Promise<void> {
    if (!payoutSender || config.payoutDryRun) {
      return;
    }

    const recoverableClaims = await prisma.claim.findMany({
      where: {
        OR: [
          { status: CLAIM_STATUSES.CONFIRMED },
          { payoutJob: { is: { status: PAYOUT_STATUSES.QUEUED } } },
        ],
      },
      include: { payoutJob: true },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    });

    for (const claim of recoverableClaims) {
      if (claim.txHash) {
        await writeAuditLog({
          event: "PAYOUT_RECOVERY_RECONCILE_SCHEDULED",
          claimId: claim.id,
          sessionId: claim.sessionId,
          address: claim.address,
          payload: {
            status: claim.status,
            txHash: claim.txHash,
            payoutJobStatus: claim.payoutJob?.status ?? null,
          },
        });
        schedulePayoutFinalization(claim.id, claim.txHash);
        continue;
      }

      await writeAuditLog({
        event: "PAYOUT_RECOVERY_RETRY_ENQUEUED",
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
        payload: {
          status: claim.status,
          payoutJobStatus: claim.payoutJob?.status ?? null,
        },
      });

      void enqueueAndProcessPayout(claim.id).catch((error) => {
        app.log.error({ err: error, claimId: claim.id }, "Failed to recover payout after restart");
      });
    }
  }

  /**
   * Checks whether claim can be retried through admin payout tooling
   *
   * @param {{
   *   status: string;
   *   txHash: string | null;
   *   payoutJob: { status: string } | null;
   * }} claim Claim snapshot
   * @returns {boolean} True when retry action is allowed
   */
  function isRetryablePayoutClaim(claim: {
    status: string;
    txHash: string | null;
    payoutJob: { status: string } | null;
  }): boolean {
    if (claim.status === CLAIM_STATUSES.PAID || claim.status === CLAIM_STATUSES.REJECTED) {
      return false;
    }

    if (claim.status === CLAIM_STATUSES.CONFIRMED) {
      return true;
    }

    return claim.payoutJob?.status === PAYOUT_STATUSES.QUEUED;
  }

  if (enableBackgroundWorkers) {
    app.addHook("onReady", async () => {
      await recoverPersistedPayoutState().catch((error) => {
        app.log.error({ err: error }, "Failed to recover persisted payout state");
      });
      await notifyLowBalanceIfNeeded("startup").catch((error) => {
        app.log.warn({ err: error }, "Failed to check low payout balance on startup");
      });

      balanceMonitorTimer = setInterval(() => {
        notifyLowBalanceIfNeeded("interval").catch((error) => {
          app.log.warn({ err: error }, "Failed to check low payout balance on interval");
        });
      }, BALANCE_MONITOR_INTERVAL_MS);

      if (typeof balanceMonitorTimer.unref === "function") {
        balanceMonitorTimer.unref();
      }
    });
  }

  app.post("/claim/confirm", async (req, reply) => {
    const parsed = claimConfirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
    }

    const claim = await prisma.claim.findUnique({
      where: { id: parsed.data.claimId },
      include: { session: true },
    });
    if (!claim) {
      return reply.code(404).send({ error: "claim_not_found" });
    }

    if (claim.status === CLAIM_STATUSES.PAID) {
      await writeAuditLog({
        event: "CLAIM_CONFIRM_IDEMPOTENT_PAID",
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
      });

      return {
        status: claim.status,
        amount: claim.amount,
        txHash: claim.txHash,
        idempotent: true,
      };
    }

    if (claim.status === CLAIM_STATUSES.REJECTED) {
      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_CONFIRM_REJECTED",
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
      });

      return reply.code(409).send({ error: "claim_rejected" });
    }

    if (claim.verificationMode === VERIFICATION_MODES.wallet_signature && !parsed.data.signature) {
      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_VERIFY_SIGNATURE_REQUIRED",
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
      });

      return reply.code(400).send({ error: "signature_required" });
    }

    const run = await prisma.run.findUnique({ where: { sessionId: claim.sessionId } });
    if (!run || !run.won) {
      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_REJECTED_RUN_NOT_ELIGIBLE",
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
      });

      return reply.code(400).send({ error: "run_not_eligible" });
    }
    if (!claim.xProfile) {
      return markAsManualReview(parsed.data, "missing_x_profile");
    }

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [paidCountForAddress, paidCountForXProfile, ipClaims24h, fpClaims24h, sessionEventsCount] = await Promise.all([
      prisma.claim.count({
        where: {
          address: claim.address,
          status: CLAIM_STATUSES.PAID,
        },
      }),
      prisma.claim.count({
        where: {
          xProfile: claim.xProfile,
          status: CLAIM_STATUSES.PAID,
        },
      }),
      claim.ipHash
        ? prisma.claim.count({
            where: {
              ipHash: claim.ipHash,
              createdAt: { gte: last24h },
              status: {
                in: [CLAIM_STATUSES.CONFIRMED, CLAIM_STATUSES.PAID, CLAIM_STATUSES.MANUAL_REVIEW],
              },
            },
          })
        : Promise.resolve(0),
      claim.fpHash
        ? prisma.claim.count({
            where: {
              fpHash: claim.fpHash,
              createdAt: { gte: last24h },
              status: {
                in: [CLAIM_STATUSES.CONFIRMED, CLAIM_STATUSES.PAID, CLAIM_STATUSES.MANUAL_REVIEW],
              },
            },
          })
        : Promise.resolve(0),
      prisma.sessionEvent.count({
        where: {
          sessionId: claim.sessionId,
        },
      }),
    ]);

    if (paidCountForAddress >= config.maxClaimsPerAddress) {
      await prisma.claim.update({ where: { id: claim.id }, data: { status: CLAIM_STATUSES.REJECTED } });

      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_REJECTED_LIMIT_REACHED",
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
        payload: {
          maxClaimsPerAddress: config.maxClaimsPerAddress,
        },
      });

      return reply.code(409).send({
        error: "limit_reached",
        limitType: "address",
        maxClaimsPerAddress: config.maxClaimsPerAddress,
      });
    }

    if (paidCountForXProfile >= config.maxClaimsPerXProfile) {
      await prisma.claim.update({ where: { id: claim.id }, data: { status: CLAIM_STATUSES.REJECTED } });

      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_REJECTED_X_PROFILE_LIMIT_REACHED",
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
        payload: {
          xProfile: claim.xProfile,
          maxClaimsPerXProfile: config.maxClaimsPerXProfile,
        },
      });

      return reply.code(409).send({
        error: "limit_reached",
        limitType: "x_profile",
        maxClaimsPerXProfile: config.maxClaimsPerXProfile,
      });
    }

    const riskAssessment = computeRiskAssessment({
      verificationMode: claim.verificationMode,
      ipClaims24h,
      fpClaims24h,
      sessionEventsCount,
      runDurationMs: run.durationMs,
      minRunDurationMs: config.minRunDurationMs,
      maxRunDurationMs: config.maxRunDurationMs,
      finalScoreClient: run.finalScoreClient,
      finalScoreServer: run.finalScoreServer,
      ipClaimsPerDayLimit: config.ipClaimsPerDayLimit,
    });
    const risk = riskAssessment.risk;

    await prisma.run.update({ where: { sessionId: claim.sessionId }, data: { riskScore: risk } });

    await writeAuditLog({
      event: "CLAIM_VERIFICATION_CHECKED",
      claimId: claim.id,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        verificationMode: claim.verificationMode,
        risk,
        riskDetails: riskAssessment.details,
        xProfile: claim.xProfile,
        ipClaims24h,
        fpClaims24h,
        sessionEventsCount,
        scoreDiff: riskAssessment.scoreDiff,
        scoreDiffThreshold: riskAssessment.scoreDiffThreshold,
      },
    });

    if (risk >= 5) {
      return markAsManualReview(
        {
          ...parsed.data,
          details: riskAssessment.details,
        },
        "risk_threshold_exceeded",
      );
    }

    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        status: CLAIM_STATUSES.CONFIRMED,
        signature: parsed.data.signature,
      },
    });

    await writeAuditLog({
      event: "CLAIM_CONFIRMED",
      claimId: claim.id,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        verificationMode: claim.verificationMode,
        xProfile: safeXProfile(claim.xProfile),
      },
    });

    return enqueueAndProcessPayout(claim.id);
  });

  app.get("/admin/review/:claimId", async (req, reply) => {
    const claimId = String((req.params as { claimId?: string })?.claimId || "").trim();
    const actionRaw = String((req.query as { action?: string })?.action || "").trim().toLowerCase();
    const token = String((req.query as { token?: string })?.token || "").trim();

    if (!claimId) {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Invalid review request",
            summary: "Missing claim id",
          }),
        );
    }

    if (actionRaw !== "approve" && actionRaw !== "reject") {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Invalid review request",
            summary: "Unknown action. Use approve or reject",
          }),
        );
    }

    const action = actionRaw as ManualReviewAction;
    if (!isValidManualReviewToken(config.adminReviewSecret, claimId, action, token)) {
      return reply
        .code(403)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Review link rejected",
            summary: "The manual review token is invalid or expired",
          }),
        );
    }

    const existingClaim = await prisma.claim.findUnique({ where: { id: claimId } });
    if (!existingClaim) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Claim not found",
            summary: "No claim exists for this review link",
          }),
        );
    }

    if (action === "approve") {
      if (
        existingClaim.status !== CLAIM_STATUSES.PAID &&
        existingClaim.status !== CLAIM_STATUSES.REJECTED
      ) {
        await prisma.claim.update({
          where: { id: claimId },
          data: {
            status: CLAIM_STATUSES.CONFIRMED,
          },
        });

        await writeAuditLog({
          event: "CLAIM_APPROVED_MANUAL",
          claimId,
          sessionId: existingClaim.sessionId,
          address: existingClaim.address,
          payload: {
            previousStatus: existingClaim.status,
          },
        });

        await enqueueAndProcessPayout(claimId, { bypassManualReviewGuards: true });
      }
    } else if (
      existingClaim.status !== CLAIM_STATUSES.REJECTED &&
      existingClaim.status !== CLAIM_STATUSES.PAID
    ) {
      await prisma.claim.update({
        where: { id: claimId },
        data: {
          status: CLAIM_STATUSES.REJECTED,
        },
      });

      await writeAuditLog({
        level: "WARN",
        event: "CLAIM_REJECTED_MANUAL",
        claimId,
        sessionId: existingClaim.sessionId,
        address: existingClaim.address,
        payload: {
          previousStatus: existingClaim.status,
        },
      });
    }

    const updatedClaim = await prisma.claim.findUnique({ where: { id: claimId } });
    const pageTitle = action === "approve" ? "Claim approved" : "Claim rejected";
    const summary =
      action === "approve"
        ? "The claim action was applied and the latest claim state is shown below"
        : "The claim was rejected and the latest claim state is shown below";

    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        renderAdminReviewPage({
          title: pageTitle,
          summary,
          claim: updatedClaim,
        }),
      );
  });

  app.get("/admin/payouts", async (req, reply) => {
    const token = String((req.query as { token?: string })?.token || "").trim();
    if (
      !config.adminReviewSecret ||
      !safeEqual(buildAdminScopeToken(config.adminReviewSecret, "payouts:list"), token)
    ) {
      return reply
        .code(403)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Payout list rejected",
            summary: "The payout list token is invalid",
          }),
        );
    }

    const claims = await prisma.claim.findMany({
      where: {
        OR: [
          { status: CLAIM_STATUSES.CONFIRMED },
          { payoutJob: { is: { status: PAYOUT_STATUSES.QUEUED } } },
          { payoutJob: { is: { status: PAYOUT_STATUSES.FAILED } } },
        ],
      },
      include: { payoutJob: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    });

    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        renderAdminPayoutListPage({
          title: "Pending FPOM payouts",
          summary: "Recent non-terminal payout jobs stored in SQLite. Retry links are generated only for retryable claims.",
          rows: claims.map((claim) => ({
            claimId: claim.id,
            status: claim.status,
            payoutStatus: claim.payoutJob?.status ?? "-",
            amount: claim.amount,
            address: claim.address,
            txHash: claim.txHash,
            updatedAt: claim.updatedAt,
            retryLink: isRetryablePayoutClaim(claim) ? buildAdminPayoutRetryLink(config, claim.id) : null,
          })),
        }),
      );
  });

  app.get("/admin/payouts/:claimId", async (req, reply) => {
    const claimId = String((req.params as { claimId?: string })?.claimId || "").trim();
    const actionRaw = String((req.query as { action?: string })?.action || "").trim().toLowerCase();
    const token = String((req.query as { token?: string })?.token || "").trim();

    if (!claimId || actionRaw !== "retry") {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Invalid payout action",
            summary: "Use a valid claim id and retry action",
          }),
        );
    }

    const expectedToken = config.adminReviewSecret
      ? buildAdminScopeToken(config.adminReviewSecret, `payout:${claimId}:retry`)
      : "";
    if (!config.adminReviewSecret || !safeEqual(expectedToken, token)) {
      return reply
        .code(403)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Retry link rejected",
            summary: "The payout retry token is invalid",
          }),
        );
    }

    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      include: { payoutJob: true },
    });
    if (!claim) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Claim not found",
            summary: "No payout claim exists for this retry link",
          }),
        );
    }

    if (!isRetryablePayoutClaim(claim)) {
      return reply
        .code(409)
        .type("text/html; charset=utf-8")
        .send(
          renderAdminReviewPage({
            title: "Payout retry skipped",
            summary: "This claim is not retryable in its current state",
            claim,
          }),
        );
    }

    await writeAuditLog({
      event: "PAYOUT_RETRY_TRIGGERED_MANUAL",
      claimId: claim.id,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        previousStatus: claim.status,
        payoutJobStatus: claim.payoutJob?.status ?? null,
        txHash: claim.txHash,
      },
    });

    if (claim.txHash) {
      await reconcilePendingPayout(claim.id).catch((error) => {
        app.log.warn({ err: error, claimId: claim.id }, "Manual payout retry reconcile failed");
      });
      schedulePayoutFinalization(claim.id, claim.txHash);
    } else {
      await enqueueAndProcessPayout(claim.id).catch((error) => {
        app.log.warn({ err: error, claimId: claim.id }, "Manual payout retry enqueue failed");
      });
    }

    const updatedClaim = await prisma.claim.findUnique({ where: { id: claim.id } });
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(
        renderAdminReviewPage({
          title: "Payout retry requested",
          summary: "The payout retry was triggered and the latest claim state is shown below",
          claim: updatedClaim,
        }),
      );
  });

  app.get("/claim/:claimId", async (req, reply) => {
    const claimId = (req.params as { claimId?: string })?.claimId?.trim();
    if (!claimId) {
      return reply.code(400).send({ error: "invalid_claim_id" });
    }

    try {
      await reconcilePendingPayout(claimId);
    } catch (error) {
      app.log.warn({ err: error, claimId }, "Failed to reconcile pending payout");
    }

    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      include: { payoutJob: true },
    });
    if (!claim) {
      return reply.code(404).send({ error: "claim_not_found" });
    }

    return {
      claimId: claim.id,
      address: claim.address,
      xProfile: claim.xProfile,
      amount: claim.amount,
      status: claim.status,
      txHash: claim.txHash,
      verificationMode: claim.verificationMode,
      payoutJob: claim.payoutJob
        ? {
            status: claim.payoutJob.status,
            attempts: claim.payoutJob.attempts,
            lastError: claim.payoutJob.lastError,
          }
        : null,
    };
  });

  return app;
}

/**
 * Boots backend server from environment config
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  const config = getConfig();
  const app = createApp({ config });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      dryRun: config.payoutDryRun,
      maxSinglePayoutAmount: config.maxSinglePayoutAmount,
      maxPayoutsPerDay: config.maxPayoutsPerDay,
      maxClaimsPerAddress: config.maxClaimsPerAddress,
      maxClaimsPerXProfile: config.maxClaimsPerXProfile,
      fpomContractAddress: config.fpomContractAddress,
      payoutSenderConfigured: Boolean(config.payoutDryRun || config.massaRewardWalletPk.trim()),
      massaRpcUrl: config.massaRpcUrl || "mainnet_default",
      massaOperationWait: config.massaOperationWait,
      xPromoTweet: config.xPromoTweet,
      slackWebhookConfigured: Boolean(config.slackWebhookUrl),
      adminReviewBaseUrl: config.adminReviewBaseUrl,
      adminReviewSecretConfigured: Boolean(config.adminReviewSecret),
      corsAllowedOrigins: config.corsAllowedOrigins,
    },
    "FPOM rewards backend started",
  );
}

/**
 * Checks whether current file is executed as process entry point
 *
 * @returns {boolean} True when server should auto-bootstrap
 */
function isMainModule() {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }
  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isMainModule()) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
