export type AppConfig = {
  host: string;
  port: number;
  corsAllowedOrigins: string[];
  fpomContractAddress: string;
  massaRewardWalletPk: string;
  massaRpcUrl: string;
  massaOperationWait: "final" | "speculative";
  massaOperationTimeoutMs: number;
  massaOperationPollIntervalMs: number;
  massaExplorerTxUrlTemplate: string;
  xPromoTweet: string;
  payoutDryRun: boolean;
  maxSinglePayoutAmount: number;
  maxPayoutsPerDay: number;
  slackWebhookUrl: string;
  notifyBalanceBelow: number;
  adminReviewBaseUrl: string;
  adminReviewSecret: string;
  maxClaimsPerAddress: number;
  maxClaimsPerXProfile: number;
  ipClaimsPerDayLimit: number;
  minRunDurationMs: number;
  maxRunDurationMs: number;
  logLevel: string;
  prettyLogs: boolean;
};

type EnvSource = Record<string, string | undefined>;

/**
 * Parses numeric env value with fallback
 *
 * @param {string | undefined} value Raw env value
 * @param {number} fallback Default number
 * @returns {number} Parsed numeric value or fallback
 */
function asNumber(value: string | undefined, fallback: number): number {
  const normalized = typeof value === "string" ? value.replaceAll("_", "").trim() : value;
  const parsed = Number(normalized);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

/**
 * Splits comma-separated env value into trimmed entries
 *
 * @param {string | undefined} value Raw CSV env value
 * @returns {string[]} Parsed values without empties
 */
function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Builds application config from environment variables
 *
 * @param {EnvSource} [env=process.env] Env source object
 * @returns {AppConfig} Normalized backend config
 */
export function getConfig(env: EnvSource = process.env): AppConfig {
  const corsAllowedOrigins = parseCsv(env.CORS_ALLOWED_ORIGINS);
  const defaultAllowedOrigins = [
    "http://localhost:4177",
    "http://127.0.0.1:4177",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];
  const massaOperationWait =
    env.MASSA_OPERATION_WAIT === "final" ? "final" : "speculative";
  const massaRewardWalletPk =
    env.MASSA_REWARD_WALLET_PK ??
    env.MASSA_ACCOUNT_SECRET_KEY ??
    env.MASSA_WALLET_PK ??
    "";

  return {
    host: env.HOST ?? "0.0.0.0",
    port: asNumber(env.PORT, 8787),
    corsAllowedOrigins: corsAllowedOrigins.length > 0 ? corsAllowedOrigins : defaultAllowedOrigins,
    fpomContractAddress:
      env.FPOM_CONTRACT_ADDRESS ??
      "AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
    massaRewardWalletPk,
    massaRpcUrl: env.MASSA_RPC_URL?.trim() ?? "",
    massaOperationWait,
    massaOperationTimeoutMs: asNumber(env.MASSA_OPERATION_TIMEOUT_MS, 90_000),
    massaOperationPollIntervalMs: asNumber(env.MASSA_OPERATION_POLL_INTERVAL_MS, 1_500),
    massaExplorerTxUrlTemplate: env.MASSA_EXPLORER_TX_URL_TEMPLATE?.trim() ?? "",
    xPromoTweet: env.X_PROMO_TWEET ?? "https://x.com/massalabs",
    payoutDryRun: String(env.PAYOUT_DRY_RUN ?? "true") !== "false",
    maxSinglePayoutAmount: asNumber(env.MAX_SINGLE_PAYOUT_AMOUNT, 300_000),
    maxPayoutsPerDay: asNumber(env.MAX_PAYOUTS_PER_DAY, 50),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL ?? "",
    notifyBalanceBelow: asNumber(env.NOTIFY_BALANCE_BELOW, 0),
    adminReviewBaseUrl: (env.ADMIN_REVIEW_BASE_URL ?? "").replace(/\/+$/, ""),
    adminReviewSecret: env.ADMIN_REVIEW_SECRET ?? "",
    maxClaimsPerAddress: asNumber(env.MAX_CLAIMS_PER_ADDRESS, 2),
    maxClaimsPerXProfile: asNumber(env.MAX_CLAIMS_PER_X_PROFILE, 2),
    ipClaimsPerDayLimit: asNumber(env.IP_CLAIMS_PER_DAY_LIMIT, 10),
    minRunDurationMs: asNumber(env.MIN_RUN_DURATION_MS, 45_000),
    maxRunDurationMs: asNumber(env.MAX_RUN_DURATION_MS, 900_000),
    logLevel: env.LOG_LEVEL ?? "info",
    prettyLogs: String(env.PRETTY_LOGS ?? "true") !== "false",
  };
}
