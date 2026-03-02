export type AppConfig = {
  host: string;
  port: number;
  corsAllowedOrigins: string[];
  fpomContractAddress: string;
  xPromoTweet: string;
  payoutDryRun: boolean;
  maxSinglePayoutAmount: number;
  maxPayoutsPerDay: number;
  slackWebhookUrl: string;
  maxClaimsPerAddress: number;
  maxClaimsPerXProfile: number;
  ipClaimsPerDayLimit: number;
  minRunDurationMs: number;
  maxRunDurationMs: number;
  logLevel: string;
  prettyLogs: boolean;
};

type EnvSource = Record<string, string | undefined>;

function asNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getConfig(env: EnvSource = process.env): AppConfig {
  const corsAllowedOrigins = parseCsv(env.CORS_ALLOWED_ORIGINS);
  const defaultAllowedOrigins = [
    "http://localhost:4177",
    "http://127.0.0.1:4177",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];

  return {
    host: env.HOST ?? "0.0.0.0",
    port: asNumber(env.PORT, 8787),
    corsAllowedOrigins: corsAllowedOrigins.length > 0 ? corsAllowedOrigins : defaultAllowedOrigins,
    fpomContractAddress:
      env.FPOM_CONTRACT_ADDRESS ??
      "AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
    xPromoTweet: env.X_PROMO_TWEET ?? "https://x.com/massalabs",
    payoutDryRun: String(env.PAYOUT_DRY_RUN ?? "true") !== "false",
    maxSinglePayoutAmount: asNumber(env.MAX_SINGLE_PAYOUT_AMOUNT, 300_000),
    maxPayoutsPerDay: asNumber(env.MAX_PAYOUTS_PER_DAY, 50),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL ?? "",
    maxClaimsPerAddress: asNumber(env.MAX_CLAIMS_PER_ADDRESS, 2),
    maxClaimsPerXProfile: asNumber(env.MAX_CLAIMS_PER_X_PROFILE, 2),
    ipClaimsPerDayLimit: asNumber(env.IP_CLAIMS_PER_DAY_LIMIT, 10),
    minRunDurationMs: asNumber(env.MIN_RUN_DURATION_MS, 45_000),
    maxRunDurationMs: asNumber(env.MAX_RUN_DURATION_MS, 900_000),
    logLevel: env.LOG_LEVEL ?? "info",
    prettyLogs: String(env.PRETTY_LOGS ?? "true") !== "false",
  };
}
