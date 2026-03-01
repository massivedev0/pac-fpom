import { PrismaClient } from "@prisma/client";

type CliOptions = {
  limit: number;
  event?: string;
  address?: string;
  claimId?: string;
  json: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: 50,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = Math.floor(parsed);
      }
      i += 1;
      continue;
    }

    if (arg === "--event" && next) {
      options.event = next;
      i += 1;
      continue;
    }

    if (arg === "--address" && next) {
      options.address = next;
      i += 1;
      continue;
    }

    if (arg === "--claim" && next) {
      options.claimId = next;
      i += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

function short(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function formatPayload(payload: string | null): string {
  if (!payload) {
    return "-";
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const compact = JSON.stringify(parsed);
    if (compact.length <= 100) {
      return compact;
    }
    return `${compact.slice(0, 97)}...`;
  } catch {
    if (payload.length <= 100) {
      return payload;
    }
    return `${payload.slice(0, 97)}...`;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  const logs = await prisma.auditLog.findMany({
    where: {
      event: options.event,
      address: options.address,
      claimId: options.claimId,
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(logs, null, 2));
    await prisma.$disconnect();
    return;
  }

  if (logs.length === 0) {
    console.log("No audit logs found for provided filters");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${logs.length} audit log entries`);
  console.log("time | level | event | claim | address | session | payload");

  for (const row of logs) {
    const line = [
      row.createdAt.toISOString(),
      row.level,
      row.event,
      short(row.claimId),
      short(row.address),
      short(row.sessionId),
      formatPayload(row.payload),
    ].join(" | ");
    console.log(line);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
