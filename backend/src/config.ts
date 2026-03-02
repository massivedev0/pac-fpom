export type AppConfig = {
  host: string;
  port: number;
  fpomContractAddress: string;
  payoutDryRun: boolean;
  maxSinglePayoutAmount: number;
  maxPayoutsPerDay: number;
  slackWebhookUrl: string;
  maxClaimsPerAddress: number;
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

export function getConfig(env: EnvSource = process.env): AppConfig {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: asNumber(env.PORT, 8787),
    fpomContractAddress:
      env.FPOM_CONTRACT_ADDRESS ??
      "AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
    payoutDryRun: String(env.PAYOUT_DRY_RUN ?? "true") !== "false",
    maxSinglePayoutAmount: asNumber(env.MAX_SINGLE_PAYOUT_AMOUNT, 300_000),
    maxPayoutsPerDay: asNumber(env.MAX_PAYOUTS_PER_DAY, 50),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL ?? "",
    maxClaimsPerAddress: asNumber(env.MAX_CLAIMS_PER_ADDRESS, 2),
    ipClaimsPerDayLimit: asNumber(env.IP_CLAIMS_PER_DAY_LIMIT, 10),
    minRunDurationMs: asNumber(env.MIN_RUN_DURATION_MS, 45_000),
    maxRunDurationMs: asNumber(env.MAX_RUN_DURATION_MS, 900_000),
    logLevel: env.LOG_LEVEL ?? "info",
    prettyLogs: String(env.PRETTY_LOGS ?? "true") !== "false",
  };
}
