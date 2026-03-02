import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { type AppConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const BASE_CONFIG: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  corsAllowedOrigins: ["http://localhost:4177"],
  fpomContractAddress: "AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
  xPromoTweet: "https://x.com/massalabs",
  payoutDryRun: true,
  maxSinglePayoutAmount: 300_000,
  maxPayoutsPerDay: 50,
  slackWebhookUrl: "",
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

async function clearDatabase(prisma: PrismaClient) {
  await prisma.payoutJob.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.claim.deleteMany();
  await prisma.run.deleteMany();
  await prisma.sessionEvent.deleteMany();
  await prisma.session.deleteMany();
}

async function createTestContext(configPatch: Partial<AppConfig> = {}): Promise<TestContext> {
  const prisma = new PrismaClient();
  await clearDatabase(prisma);

  const app = createApp({
    config: {
      ...BASE_CONFIG,
      ...configPatch,
    },
    prisma,
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

async function startSession(app: ReturnType<typeof createApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/session/start",
    payload: { fingerprint: "test-device-12345" },
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { sessionId: string; nonce: string };
}

async function prepareClaim(app: ReturnType<typeof createApp>, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/claim/prepare",
    payload,
  });
  return response;
}

async function confirmClaim(app: ReturnType<typeof createApp>, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/claim/confirm",
    payload,
  });
  return response;
}

let xProfileSequence = 0;

function nextXProfile(): string {
  xProfileSequence += 1;
  return `https://x.com/fpomplayer${xProfileSequence}`;
}

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
