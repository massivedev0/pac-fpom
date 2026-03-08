import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { type AppConfig } from "../src/config.js";
import { type PayoutSender } from "../src/massa-payout.js";
import { createApp } from "../src/server.js";
import { hmacSha256Hex } from "../src/utils.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL_TEST ||
  "file:./rewards.test.db";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const BASE_CONFIG: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  corsAllowedOrigins: ["http://localhost:4177"],
  fpomContractAddress: "AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
  massaRewardWalletPk: "",
  massaRpcUrl: "",
  massaOperationWait: "final",
  massaOperationTimeoutMs: 90_000,
  massaOperationPollIntervalMs: 1_500,
  xPromoTweet: "https://x.com/massalabs",
  payoutDryRun: true,
  maxSinglePayoutAmount: 300_000,
  maxPayoutsPerDay: 50,
  slackWebhookUrl: "",
  notifyBalanceBelow: 0,
  adminReviewBaseUrl: "http://localhost:8787",
  adminReviewSecret: "test-review-secret",
  maxClaimsPerAddress: 2,
  maxClaimsPerXProfile: 2,
  ipClaimsPerDayLimit: 10,
  minRunDurationMs: 45_000,
  maxRunDurationMs: 900_000,
  logLevel: "error",
  prettyLogs: false,
};

const VALID_ADDRESS = "AU12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib";

const WINNING_RUN = {
  won: true,
  durationMs: 180_000,
  pelletsEaten: 233,
  powerPelletsEaten: 5,
  enemiesEaten: 2,
  finalScoreClient: 106_050,
};

type TestContext = {
  app: ReturnType<typeof createApp>;
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
};

/**
 * Removes all reward tables between test cases
 *
 * @param {PrismaClient} prisma Active Prisma client
 * @returns {Promise<void>}
 */
async function clearDatabase(prisma: PrismaClient) {
  await prisma.payoutJob.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.claim.deleteMany();
  await prisma.run.deleteMany();
  await prisma.sessionEvent.deleteMany();
  await prisma.session.deleteMany();
}

/**
 * Creates isolated Fastify + Prisma test context
 *
 * @param {Partial<AppConfig>} [configPatch={}] Per-test config overrides
 * @param {PayoutSender | null} [payoutSender=null] Optional mocked payout sender
 * @param {boolean} [enableBackgroundWorkers=false] Enables startup workers when needed by test
 * @returns {Promise<TestContext>} Ready test context
 */
async function createTestContext(
  configPatch: Partial<AppConfig> = {},
  payoutSender: PayoutSender | null = null,
  enableBackgroundWorkers = false,
): Promise<TestContext> {
  assert.match(process.env.DATABASE_URL ?? "", /rewards\.test\.db/);
  const prisma = new PrismaClient();
  await clearDatabase(prisma);

  const app = createApp({
    config: {
      ...BASE_CONFIG,
      ...configPatch,
    },
    prisma,
    payoutSender,
    enableBackgroundWorkers,
  });

  await app.ready();

  return {
    app,
    prisma,
    cleanup: async () => {
      await app.close();
    },
  };
}

/**
 * Starts a telemetry session for tests
 *
 * @param {ReturnType<typeof createApp>} app Fastify app under test
 * @returns {Promise<{ sessionId: string; nonce: string }>} Created session payload
 */
async function startSession(app: ReturnType<typeof createApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/session/start",
    payload: { fingerprint: "test-device-12345" },
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { sessionId: string; nonce: string };
}

/**
 * Calls claim prepare endpoint with arbitrary payload
 *
 * @param {ReturnType<typeof createApp>} app Fastify app under test
 * @param {Record<string, unknown>} payload Request body
 * @returns {Promise<import("light-my-request").Response>} Injected response
 */
async function prepareClaim(app: ReturnType<typeof createApp>, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/claim/prepare",
    payload,
  });
  return response;
}

/**
 * Calls claim confirm endpoint with arbitrary payload
 *
 * @param {ReturnType<typeof createApp>} app Fastify app under test
 * @param {Record<string, unknown>} payload Request body
 * @returns {Promise<import("light-my-request").Response>} Injected response
 */
async function confirmClaim(app: ReturnType<typeof createApp>, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/claim/confirm",
    payload,
  });
  return response;
}

/**
 * Pushes synthetic telemetry events into a test session
 *
 * @param {ReturnType<typeof createApp>} app Fastify app under test
 * @param {string} sessionId Target session id
 * @param {number} [count=12] Number of events to create
 * @returns {Promise<void>}
 */
async function pushSessionEvents(
  app: ReturnType<typeof createApp>,
  sessionId: string,
  count = 12,
) {
  const response = await app.inject({
    method: "POST",
    url: "/session/event",
    payload: {
      sessionId,
      startSeq: 0,
      events: Array.from({ length: count }, (_, idx) => ({
        type: "tick",
        idx,
      })),
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as { accepted: number };
  assert.equal(body.accepted, count);
}

let xProfileSequence = 0;

/**
 * Generates unique X profile URL for tests
 *
 * @returns {string} Unique X profile URL
 */
function nextXProfile(): string {
  xProfileSequence += 1;
  return `https://x.com/fpomplayer${xProfileSequence}`;
}

/**
 * Creates a paid claim through prepare + confirm endpoints
 *
 * @param {ReturnType<typeof createApp>} app Fastify app under test
 * @param {string} [address=VALID_ADDRESS] Recipient address
 * @param {string} [xProfile=nextXProfile()] Unique X profile URL
 * @returns {Promise<string>} Final claim id
 */
async function createPaidClaim(
  app: ReturnType<typeof createApp>,
  address = VALID_ADDRESS,
  xProfile = nextXProfile(),
) {
  const session = await startSession(app);

  const prepareResponse = await prepareClaim(app, {
    sessionId: session.sessionId,
    address,
    xProfile,
    verificationMode: "address_only",
    run: WINNING_RUN,
  });

  assert.equal(prepareResponse.statusCode, 200);
  const prepared = prepareResponse.json() as { claimId: string };

  const confirmResponse = await confirmClaim(app, {
    claimId: prepared.claimId,
  });

  assert.equal(confirmResponse.statusCode, 200);
  return prepared.claimId;
}

/**
 * Waits until async predicate becomes true
 *
 * @param {() => Promise<boolean>} predicate Async condition
 * @param {number} [timeoutMs=2000] Max wait time
 * @returns {Promise<void>}
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.fail(`Condition was not met within ${timeoutMs}ms`);
}

test("reward claim happy path should pay in dry run and write audit logs", async () => {
  const context = await createTestContext();

  try {
    const claimId = await createPaidClaim(context.app);

    const claimResponse = await context.app.inject({
      method: "GET",
      url: `/claim/${claimId}`,
    });

    assert.equal(claimResponse.statusCode, 200);
    const claimBody = claimResponse.json() as { status: string; txHash: string };
    assert.equal(claimBody.status, "PAID");
    assert.match(claimBody.txHash, /^dryrun_/);

    const logs = await context.prisma.auditLog.findMany({
      where: { claimId },
      orderBy: { createdAt: "asc" },
      select: { event: true },
    });

    const events = logs.map((item) => item.event);
    assert.ok(events.includes("CLAIM_PREPARED"));
    assert.ok(events.includes("CLAIM_CONFIRMED"));
    assert.ok(events.includes("PAYOUT_PAID_DRY_RUN"));
  } finally {
    await context.cleanup();
  }
});

test("public config should expose promo tweet url", async () => {
  const context = await createTestContext({
    xPromoTweet: "https://x.com/fpomofficial/status/1234567890",
  });

  try {
    const response = await context.app.inject({
      method: "GET",
      url: "/public/config",
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { xPromoTweet: string };
    assert.equal(body.xPromoTweet, "https://x.com/fpomofficial/status/1234567890");
  } finally {
    await context.cleanup();
  }
});

test("claim prepare should default to address_only and confirm without signature", async () => {
  const context = await createTestContext();

  try {
    const session = await startSession(context.app);

    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      run: WINNING_RUN,
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as {
      claimId: string;
      requiresSignature: boolean;
      verificationMode: string;
    };
    assert.equal(prepared.requiresSignature, false);
    assert.equal(prepared.verificationMode, "address_only");

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 200);
    const body = confirmResponse.json() as { status: string };
    assert.equal(body.status, "PAID");
  } finally {
    await context.cleanup();
  }
});

test("same address should not exceed two paid claims", async () => {
  const context = await createTestContext();

  try {
    await createPaidClaim(context.app, VALID_ADDRESS);
    await createPaidClaim(context.app, VALID_ADDRESS);

    const session = await startSession(context.app);

    const thirdPrepare = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: WINNING_RUN,
    });

    assert.equal(thirdPrepare.statusCode, 409);
    const body = thirdPrepare.json() as { error: string };
    assert.equal(body.error, "limit_reached");
  } finally {
    await context.cleanup();
  }
});

test("wallet_signature mode should require signature on confirm", async () => {
  const context = await createTestContext();

  try {
    const session = await startSession(context.app);

    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "wallet_signature",
      run: WINNING_RUN,
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as { claimId: string };

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 400);
    const body = confirmResponse.json() as { error: string };
    assert.equal(body.error, "signature_required");
  } finally {
    await context.cleanup();
  }
});

test("claim prepare should reject non-winning run", async () => {
  const context = await createTestContext();

  try {
    const session = await startSession(context.app);

    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: {
        ...WINNING_RUN,
        won: false,
      },
    });

    assert.equal(prepareResponse.statusCode, 400);
    const body = prepareResponse.json() as { error: string };
    assert.equal(body.error, "round_not_won");
  } finally {
    await context.cleanup();
  }
});

test("address_only claim with session events should keep low risk score", async () => {
  const context = await createTestContext();

  try {
    const session = await startSession(context.app);
    await pushSessionEvents(context.app, session.sessionId, 10);

    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: WINNING_RUN,
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as { claimId: string };

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 200);
    const run = await context.prisma.run.findUnique({ where: { sessionId: session.sessionId } });
    assert.ok(run);
    assert.equal(run.riskScore, 2);
  } finally {
    await context.cleanup();
  }
});

test("claim should go to manual review when payout exceeds single amount limit", async () => {
  const context = await createTestContext({
    maxSinglePayoutAmount: 100_000,
  });

  try {
    const session = await startSession(context.app);

    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: {
        ...WINNING_RUN,
        enemiesEaten: 80,
        finalScoreClient: 301_050,
      },
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as { claimId: string };

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 200);
    const body = confirmResponse.json() as { status: string; reason: string };
    assert.equal(body.status, "MANUAL_REVIEW");
    assert.match(body.reason, /single_payout_limit_exceeded/);
  } finally {
    await context.cleanup();
  }
});

test("manual review approve link should auto-pay claim and render claim details", async () => {
  const context = await createTestContext({
    maxSinglePayoutAmount: 100_000,
  });

  try {
    const session = await startSession(context.app);

    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: {
        ...WINNING_RUN,
        enemiesEaten: 80,
        finalScoreClient: 301_050,
      },
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as { claimId: string };

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 200);
    const approveToken = hmacSha256Hex(BASE_CONFIG.adminReviewSecret, `${prepared.claimId}:approve`);
    const reviewResponse = await context.app.inject({
      method: "GET",
      url: `/admin/review/${prepared.claimId}?action=approve&token=${approveToken}`,
    });

    assert.equal(reviewResponse.statusCode, 200);
    assert.match(reviewResponse.body, /Claim approved/);
    assert.match(reviewResponse.body, /PAID/);

    const claim = await context.prisma.claim.findUnique({ where: { id: prepared.claimId } });
    assert.ok(claim);
    assert.equal(claim.status, "PAID");
  } finally {
    await context.cleanup();
  }
});

test("manual review reject link should reject claim and render claim details", async () => {
  const context = await createTestContext({
    maxSinglePayoutAmount: 100_000,
  });

  try {
    const session = await startSession(context.app);

    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: {
        ...WINNING_RUN,
        enemiesEaten: 80,
        finalScoreClient: 301_050,
      },
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as { claimId: string };

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 200);
    const rejectToken = hmacSha256Hex(BASE_CONFIG.adminReviewSecret, `${prepared.claimId}:reject`);
    const reviewResponse = await context.app.inject({
      method: "GET",
      url: `/admin/review/${prepared.claimId}?action=reject&token=${rejectToken}`,
    });

    assert.equal(reviewResponse.statusCode, 200);
    assert.match(reviewResponse.body, /Claim rejected/);
    assert.match(reviewResponse.body, /REJECTED/);

    const claim = await context.prisma.claim.findUnique({ where: { id: prepared.claimId } });
    assert.ok(claim);
    assert.equal(claim.status, "REJECTED");
  } finally {
    await context.cleanup();
  }
});

test("claim should go to manual review when daily payout limit is reached", async () => {
  const context = await createTestContext({
    maxPayoutsPerDay: 1,
  });

  try {
    await createPaidClaim(context.app, VALID_ADDRESS);

    const session2 = await startSession(context.app);
    const prepare2 = await prepareClaim(context.app, {
      sessionId: session2.sessionId,
      address: "AU9XGDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: WINNING_RUN,
    });

    assert.equal(prepare2.statusCode, 200);
    const prepared2 = prepare2.json() as { claimId: string };

    const confirm2 = await confirmClaim(context.app, {
      claimId: prepared2.claimId,
    });

    assert.equal(confirm2.statusCode, 200);
    const body2 = confirm2.json() as { status: string; reason: string };
    assert.equal(body2.status, "MANUAL_REVIEW");
    assert.match(body2.reason, /daily_payout_limit_exceeded/);
  } finally {
    await context.cleanup();
  }
});

test("same x profile should not exceed two paid claims", async () => {
  const context = await createTestContext();

  try {
    const xProfile = "https://x.com/fpompromo";
    await createPaidClaim(context.app, "AU12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib", xProfile);
    await createPaidClaim(context.app, "AU9XGDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib", xProfile);

    const session = await startSession(context.app);
    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: "AU77GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
      xProfile,
      verificationMode: "address_only",
      run: WINNING_RUN,
    });

    assert.equal(prepareResponse.statusCode, 409);
    const body = prepareResponse.json() as { error: string; limitType: string };
    assert.equal(body.error, "limit_reached");
    assert.equal(body.limitType, "x_profile");
  } finally {
    await context.cleanup();
  }
});

test("real payout sender should mark claim paid with on-chain tx hash", async () => {
  const payoutSender: PayoutSender = {
    isConfigured: () => true,
    async sendTokenPayout() {
      return {
        outcome: "paid",
        txHash: "op_paid_123",
        rawAmount: "106050000000000000000000",
        tokenDecimals: 18,
        observedStatus: "Success",
      };
    },
    async reconcilePayout(txHash) {
      return {
        outcome: "paid",
        txHash,
        observedStatus: "Success",
      };
    },
  };
  const context = await createTestContext({ payoutDryRun: false }, payoutSender);

  try {
    const claimId = await createPaidClaim(context.app);
    const claim = await context.prisma.claim.findUnique({ where: { id: claimId } });
    assert.ok(claim);
    assert.equal(claim.status, "PAID");
    assert.equal(claim.txHash, "op_paid_123");

    const payoutJob = await context.prisma.payoutJob.findUnique({ where: { claimId } });
    assert.ok(payoutJob);
    assert.equal(payoutJob.status, "PAID");

    const logs = await context.prisma.auditLog.findMany({
      where: { claimId },
      orderBy: { createdAt: "asc" },
      select: { event: true },
    });
    assert.ok(logs.some((entry) => entry.event === "PAYOUT_PAID_ONCHAIN"));
  } finally {
    await context.cleanup();
  }
});

test("real payout sender should keep claim confirmed until reconciliation succeeds", async () => {
  let reconcileCalls = 0;
  const payoutSender: PayoutSender = {
    isConfigured: () => true,
    async sendTokenPayout() {
      return {
        outcome: "pending",
        txHash: "op_pending_123",
        rawAmount: "106050000000000000000000",
        tokenDecimals: 18,
        observedStatus: "PendingInclusion",
      };
    },
    async reconcilePayout(txHash) {
      reconcileCalls += 1;
      return {
        outcome: "paid",
        txHash,
        observedStatus: "Success",
      };
    },
  };
  const context = await createTestContext({ payoutDryRun: false }, payoutSender);

  try {
    const session = await startSession(context.app);
    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: WINNING_RUN,
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as { claimId: string };

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 200);
    const confirmBody = confirmResponse.json() as { status: string; txHash: string };
    assert.equal(confirmBody.status, "CONFIRMED");
    assert.equal(confirmBody.txHash, "op_pending_123");

    const claimAfterConfirm = await context.prisma.claim.findUnique({ where: { id: prepared.claimId } });
    assert.ok(claimAfterConfirm);
    assert.equal(claimAfterConfirm.status, "CONFIRMED");

    const claimPollResponse = await context.app.inject({
      method: "GET",
      url: `/claim/${prepared.claimId}`,
    });

    assert.equal(claimPollResponse.statusCode, 200);
    const claimPollBody = claimPollResponse.json() as { status: string; txHash: string };
    assert.equal(claimPollBody.status, "PAID");
    assert.equal(claimPollBody.txHash, "op_pending_123");
    assert.ok(reconcileCalls >= 1);
  } finally {
    await context.cleanup();
  }
});

test("real payout sender failure should move claim to manual review", async () => {
  const payoutSender: PayoutSender = {
    isConfigured: () => true,
    async sendTokenPayout() {
      return {
        outcome: "failed",
        txHash: "op_failed_123",
        rawAmount: "106050000000000000000000",
        tokenDecimals: 18,
        observedStatus: "Error",
        error: "operation_failed:Error",
      };
    },
    async reconcilePayout(txHash) {
      return {
        outcome: "failed",
        txHash,
        observedStatus: "Error",
        error: "operation_failed:Error",
      };
    },
  };
  const context = await createTestContext({ payoutDryRun: false }, payoutSender);

  try {
    const session = await startSession(context.app);
    const prepareResponse = await prepareClaim(context.app, {
      sessionId: session.sessionId,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      run: WINNING_RUN,
    });

    assert.equal(prepareResponse.statusCode, 200);
    const prepared = prepareResponse.json() as { claimId: string };

    const confirmResponse = await confirmClaim(context.app, {
      claimId: prepared.claimId,
    });

    assert.equal(confirmResponse.statusCode, 200);
    const body = confirmResponse.json() as { status: string; reason: string; txHash: string };
    assert.equal(body.status, "MANUAL_REVIEW");
    assert.match(body.reason, /onchain_payout_failed/);
    assert.equal(body.txHash, "op_failed_123");
  } finally {
    await context.cleanup();
  }
});

test("low balance alert should be sent at most once per day", async () => {
  const originalFetch = globalThis.fetch;
  const slackRequests: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    slackRequests.push(String(init?.body || ""));
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const payoutSender: PayoutSender = {
    isConfigured: () => true,
    async getBalanceSnapshot() {
      return {
        payoutAddress: VALID_ADDRESS,
        masBalanceRaw: "1500000000",
        masBalanceMas: "1.5",
        fpomBalanceRaw: "500000000000000000000",
        fpomBalanceTokens: "500",
        tokenDecimals: 18,
      };
    },
    async sendTokenPayout() {
      return {
        outcome: "pending",
        txHash: `op_low_balance_${Date.now()}`,
        rawAmount: "106050000000000000000000",
        tokenDecimals: 18,
        observedStatus: "SUBMITTED",
        balanceSnapshot: await this.getBalanceSnapshot?.(),
        projectedFpomBalanceRaw: "500000000000000000000",
      };
    },
    async reconcilePayout(txHash) {
      return {
        outcome: "pending",
        txHash,
        observedStatus: "PendingInclusion",
      };
    },
  };

  const context = await createTestContext(
    {
      payoutDryRun: false,
      slackWebhookUrl: "https://hooks.slack.test/services/fpom",
      notifyBalanceBelow: 1_000,
    },
    payoutSender,
  );

  try {
    await createPaidClaim(context.app, VALID_ADDRESS, nextXProfile());
    await createPaidClaim(
      context.app,
      "AU9XGDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
      nextXProfile(),
    );

    const alerts = await context.prisma.auditLog.findMany({
      where: { event: "BALANCE_LOW_ALERT_SENT" },
      orderBy: { createdAt: "asc" },
    });

    assert.equal(alerts.length, 1);
    assert.equal(slackRequests.length, 1);
    assert.match(slackRequests[0], /FPOM payout wallet balance is low/);
  } finally {
    globalThis.fetch = originalFetch;
    await context.cleanup();
  }
});

test("startup recovery should resume queued payouts after restart", async () => {
  const payoutSender: PayoutSender = {
    isConfigured: () => true,
    async sendTokenPayout() {
      return {
        outcome: "pending",
        txHash: "op_recovered_submit_123",
        rawAmount: "106050000000000000000000",
        tokenDecimals: 18,
        observedStatus: "SUBMITTED",
      };
    },
    async reconcilePayout(txHash) {
      return {
        outcome: "pending",
        txHash,
        observedStatus: "PendingInclusion",
      };
    },
  };

  const prisma = new PrismaClient();
  await clearDatabase(prisma);

  const session = await prisma.session.create({
    data: {
      nonce: "restart-session-nonce",
      ipHash: "ip-hash",
      fpHash: "fp-hash",
    },
  });
  await prisma.run.create({
    data: {
      sessionId: session.id,
      won: true,
      durationMs: WINNING_RUN.durationMs,
      pelletsEaten: WINNING_RUN.pelletsEaten,
      powerPelletsEaten: WINNING_RUN.powerPelletsEaten,
      enemiesEaten: WINNING_RUN.enemiesEaten,
      finalScoreClient: WINNING_RUN.finalScoreClient,
      finalScoreServer: WINNING_RUN.finalScoreClient,
      riskScore: 2,
    },
  });
  const claim = await prisma.claim.create({
    data: {
      sessionId: session.id,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      amount: WINNING_RUN.finalScoreClient,
      challenge: "restart-challenge",
      status: "CONFIRMED",
      ipHash: "ip-hash",
      fpHash: "fp-hash",
    },
  });
  await prisma.payoutJob.create({
    data: {
      claimId: claim.id,
      status: "QUEUED",
    },
  });

  const app = createApp({
    config: {
      ...BASE_CONFIG,
      payoutDryRun: false,
    },
    prisma,
    payoutSender,
    enableBackgroundWorkers: true,
  });

  try {
    await app.ready();

    await waitFor(async () => {
      const recoveredClaim = await prisma.claim.findUnique({ where: { id: claim.id } });
      return recoveredClaim?.txHash === "op_recovered_submit_123";
    });

    const recoveredClaim = await prisma.claim.findUnique({ where: { id: claim.id } });
    assert.ok(recoveredClaim);
    assert.equal(recoveredClaim.status, "CONFIRMED");
    assert.equal(recoveredClaim.txHash, "op_recovered_submit_123");

    const recoveryLog = await prisma.auditLog.findFirst({
      where: {
        claimId: claim.id,
        event: "PAYOUT_RECOVERY_RETRY_ENQUEUED",
      },
    });
    assert.ok(recoveryLog);
  } finally {
    await app.close();
  }
});

test("startup recovery should finalize confirmed payouts with tx hash", async () => {
  const payoutSender: PayoutSender = {
    isConfigured: () => true,
    async sendTokenPayout() {
      return {
        outcome: "pending",
        txHash: "unused",
        rawAmount: "106050000000000000000000",
        tokenDecimals: 18,
        observedStatus: "SUBMITTED",
      };
    },
    async reconcilePayout(txHash) {
      return {
        outcome: "paid",
        txHash,
        observedStatus: "Success",
      };
    },
  };

  const prisma = new PrismaClient();
  await clearDatabase(prisma);

  const session = await prisma.session.create({
    data: {
      nonce: "restart-session-nonce-2",
      ipHash: "ip-hash-2",
      fpHash: "fp-hash-2",
    },
  });
  await prisma.run.create({
    data: {
      sessionId: session.id,
      won: true,
      durationMs: WINNING_RUN.durationMs,
      pelletsEaten: WINNING_RUN.pelletsEaten,
      powerPelletsEaten: WINNING_RUN.powerPelletsEaten,
      enemiesEaten: WINNING_RUN.enemiesEaten,
      finalScoreClient: WINNING_RUN.finalScoreClient,
      finalScoreServer: WINNING_RUN.finalScoreClient,
      riskScore: 2,
    },
  });
  const claim = await prisma.claim.create({
    data: {
      sessionId: session.id,
      address: VALID_ADDRESS,
      xProfile: nextXProfile(),
      verificationMode: "address_only",
      amount: WINNING_RUN.finalScoreClient,
      challenge: "restart-challenge-2",
      status: "CONFIRMED",
      txHash: "op_existing_confirmed_123",
      ipHash: "ip-hash-2",
      fpHash: "fp-hash-2",
    },
  });
  await prisma.payoutJob.create({
    data: {
      claimId: claim.id,
      status: "QUEUED",
    },
  });

  const app = createApp({
    config: {
      ...BASE_CONFIG,
      payoutDryRun: false,
    },
    prisma,
    payoutSender,
    enableBackgroundWorkers: true,
  });

  try {
    await app.ready();

    await waitFor(async () => {
      const recoveredClaim = await prisma.claim.findUnique({ where: { id: claim.id } });
      return recoveredClaim?.status === "PAID";
    });

    const recoveredClaim = await prisma.claim.findUnique({ where: { id: claim.id } });
    assert.ok(recoveredClaim);
    assert.equal(recoveredClaim.status, "PAID");
    assert.equal(recoveredClaim.txHash, "op_existing_confirmed_123");

    const recoveryLog = await prisma.auditLog.findFirst({
      where: {
        claimId: claim.id,
        event: "PAYOUT_RECOVERY_RECONCILE_SCHEDULED",
      },
    });
    assert.ok(recoveryLog);
  } finally {
    await app.close();
  }
});
