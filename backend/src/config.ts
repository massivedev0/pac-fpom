export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8787),

  fpomContractAddress:
    process.env.FPOM_CONTRACT_ADDRESS ??
    "AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",

  payoutDryRun: String(process.env.PAYOUT_DRY_RUN ?? "true") !== "false",
  maxClaimsPerAddress: Number(process.env.MAX_CLAIMS_PER_ADDRESS ?? 2),
  ipClaimsPerDayLimit: Number(process.env.IP_CLAIMS_PER_DAY_LIMIT ?? 10),
  minRunDurationMs: Number(process.env.MIN_RUN_DURATION_MS ?? 45_000),
  maxRunDurationMs: Number(process.env.MAX_RUN_DURATION_MS ?? 900_000),
};
