import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { type AppConfig, getConfig } from "./config.js";
import { computeServerScore, normalizeRunSummary } from "./scoring.js";
import { extractIpFromRequest, isLikelyMassaAddress, randomToken, sha256Hex } from "./utils.js";

const VERIFICATION_MODES = {
  wallet_signature: "wallet_signature",
  address_only: "address_only",
} as const;

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

const claimPrepareSchema = z.object({
  sessionId: z.string().trim().min(8),
  address: z.string().trim().min(10),
  xProfile: z.string().trim().min(10).max(200),
  verificationMode: z
    .enum([VERIFICATION_MODES.wallet_signature, VERIFICATION_MODES.address_only])
    .default(VERIFICATION_MODES.wallet_signature),
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
};

type PayoutContext = {
  claimId: string;
  sessionId: string;
  address: string;
  xProfile: string;
  amount: number;
  verificationMode: string;
  riskScore?: number | null;
  txHash?: string;
  dryRun?: boolean;
  reason?: string;
};

const X_PROFILE_REGEX = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/?$/;

function normalizeXProfileUrl(input: string): string | null {
  const trimmed = input.trim();
  const match = X_PROFILE_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }
  const username = match[1].toLowerCase();
  return `https://x.com/${username}`;
}

function safeXProfile(value: string | null | undefined): string {
  return value ?? "https://x.com/unknown";
}

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

function formatSlackPayoutMessage(context: PayoutContext): string {
  const payoutMode = context.dryRun ? "DRY RUN" : "REAL";
  return [
    "FPOM payout event",
    `Mode: ${payoutMode}`,
    `Claim ID: ${context.claimId}`,
    `Session ID: ${context.sessionId}`,
    `Address: ${context.address}`,
    `X profile: ${context.xProfile}`,
    `Amount: ${context.amount.toLocaleString("en-US")} FPOM`,
    `Verification: ${context.verificationMode}`,
    context.riskScore === undefined ? undefined : `Risk score: ${context.riskScore}`,
    context.txHash ? `Tx hash: ${context.txHash}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSlackManualReviewMessage(context: PayoutContext): string {
  return [
    "FPOM manual review requested",
    `Reason: ${context.reason ?? "unknown"}`,
    `Claim ID: ${context.claimId}`,
    `Session ID: ${context.sessionId}`,
    `Address: ${context.address}`,
    `X profile: ${context.xProfile}`,
    `Amount: ${context.amount.toLocaleString("en-US")} FPOM`,
    `Verification: ${context.verificationMode}`,
    context.riskScore === undefined ? undefined : `Risk score: ${context.riskScore}`,
  ]
    .filter(Boolean)
    .join("\n");
}

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

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const config = options.config ?? getConfig();
  const prisma = options.prisma ?? new PrismaClient();
  const app = Fastify({ logger: createLoggerOptions(config) });
  const writeAuditLog = createAuditWriter(prisma, app.log);
  const allowedOrigins = new Set(config.corsAllowedOrigins);
  const corsMethods = "GET,POST,OPTIONS";
  const corsHeaders = "content-type";

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
    await prisma.$disconnect();
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/public/config", async () => ({
    xPromoTweet: config.xPromoTweet,
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

    const scoreServer = computeServerScore(run);
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
  };

  async function markAsManualReview(input: ReviewInput, reason: string) {
    const claim = await prisma.claim.update({
      where: { id: input.claimId },
      data: {
        status: CLAIM_STATUSES.MANUAL_REVIEW,
        signature: input.signature,
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
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        xProfile: claim.xProfile,
      },
    });

    const run = await prisma.run.findUnique({ where: { sessionId: claim.sessionId } });
    await sendSlackNotification(
      app,
      config,
      formatSlackManualReviewMessage({
        claimId: claim.id,
        sessionId: claim.sessionId,
        address: claim.address,
        xProfile: safeXProfile(claim.xProfile),
        amount: claim.amount,
        verificationMode: claim.verificationMode,
        riskScore: run?.riskScore ?? null,
        reason,
      }),
    );

    return {
      status: CLAIM_STATUSES.MANUAL_REVIEW,
      reason,
    };
  }

  async function enqueueAndProcessPayout(claimId: string) {
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

    if (claim.amount > config.maxSinglePayoutAmount) {
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
    if (paidLast24h >= config.maxPayoutsPerDay) {
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
        event: "PAYOUT_PAID_DRY_RUN",
        claimId,
        sessionId: claim.sessionId,
        address: claim.address,
        payload: {
          txHash,
          amount: claim.amount,
          verificationMode: claim.verificationMode,
          xProfile: claim.xProfile,
        },
      });

      await sendSlackNotification(
        app,
        config,
        formatSlackPayoutMessage({
          claimId: claim.id,
          sessionId: claim.sessionId,
          address: claim.address,
          xProfile: safeXProfile(claim.xProfile),
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

    await prisma.$transaction([
      prisma.payoutJob.update({
        where: { claimId },
        data: {
          status: PAYOUT_STATUSES.FAILED,
          attempts: { increment: 1 },
          lastError: "Real payout integration is not configured yet.",
        },
      }),
    ]);

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

    let risk = 0;
    if (claim.verificationMode === VERIFICATION_MODES.address_only) {
      risk += 2;
    }
    if (ipClaims24h >= config.ipClaimsPerDayLimit) {
      risk += 5;
    }
    if (fpClaims24h >= 3) {
      risk += 3;
    }
    if (sessionEventsCount === 0) {
      risk += 2;
    } else if (sessionEventsCount < 5) {
      risk += 1;
    }
    if (sessionEventsCount > 5000) {
      risk += 2;
    }
    if (run.durationMs < config.minRunDurationMs || run.durationMs > config.maxRunDurationMs) {
      risk += 3;
    }
    const scoreDiff = Math.abs(run.finalScoreClient - run.finalScoreServer);
    if (scoreDiff > Math.max(500, Math.floor(run.finalScoreServer * 0.2))) {
      risk += 2;
    }

    await prisma.run.update({ where: { sessionId: claim.sessionId }, data: { riskScore: risk } });

    await writeAuditLog({
      event: "CLAIM_VERIFICATION_CHECKED",
      claimId: claim.id,
      sessionId: claim.sessionId,
      address: claim.address,
      payload: {
        verificationMode: claim.verificationMode,
        risk,
        xProfile: claim.xProfile,
        ipClaims24h,
        fpClaims24h,
        sessionEventsCount,
      },
    });

    if (risk >= 5) {
      return markAsManualReview(parsed.data, "risk_threshold_exceeded");
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

  app.get("/claim/:claimId", async (req, reply) => {
    const claimId = (req.params as { claimId?: string })?.claimId?.trim();
    if (!claimId) {
      return reply.code(400).send({ error: "invalid_claim_id" });
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
      xPromoTweet: config.xPromoTweet,
      slackWebhookConfigured: Boolean(config.slackWebhookUrl),
      corsAllowedOrigins: config.corsAllowedOrigins,
    },
    "FPOM rewards backend started",
  );
}

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
