import process from "node:process";
import { PrismaClient } from "@prisma/client";

type CliOptions = {
  limit: number;
  event?: string;
  address?: string;
  claimId?: string;
  json: boolean;
};

type RowData = {
  time: string;
  level: string;
  event: string;
  claim: string;
  address: string;
  session: string;
  payload: string;
};

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
} as const;

/**
 * Parses CLI flags for audit-log viewer
 *
 * @param {string[]} argv Raw CLI arguments
 * @returns {CliOptions} Parsed CLI options
 */
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

/**
 * Shortens long ids and addresses for table output
 *
 * @param {string | null | undefined} value Raw value
 * @returns {string} Compact printable value
 */
function short(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

/**
 * Normalizes payload column into compact JSON string
 *
 * @param {string | null} payload Raw payload column
 * @returns {string} Printable payload string
 */
function formatPayload(payload: string | null): string {
  if (!payload) {
    return "-";
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return JSON.stringify(parsed);
  } catch {
    return payload;
  }
}

/**
 * Cuts text to fixed width for aligned table rendering
 *
 * @param {string} text Raw text
 * @param {number} width Max cell width
 * @returns {string} Truncated text
 */
function truncate(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 1)}…`;
}

/**
 * Wraps ANSI color codes around text when terminal output supports it
 *
 * @param {string} text Raw text
 * @param {string} code ANSI color code
 * @param {boolean} enabled Whether colors are enabled
 * @returns {string} Colorized or plain text
 */
function colorize(text: string, code: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  return `${code}${text}${COLOR.reset}`;
}

/**
 * Maps audit level to ANSI color code
 *
 * @param {string} level Audit level
 * @returns {string} ANSI color code
 */
function levelColor(level: string): string {
  if (level === "ERROR") return COLOR.red;
  if (level === "WARN") return COLOR.yellow;
  if (level === "INFO") return COLOR.blue;
  return COLOR.magenta;
}

/**
 * Converts DB audit rows into printable table rows
 *
 * @param {Awaited<ReturnType<PrismaClient["auditLog"]["findMany"]>>} logs Audit log rows
 * @returns {RowData[]} Printable row models
 */
function rowsFromLogs(
  logs: Awaited<ReturnType<PrismaClient["auditLog"]["findMany"]>>,
): RowData[] {
  return logs.map((row) => ({
    time: row.createdAt.toISOString().replace("T", " ").replace(".000Z", "Z"),
    level: row.level,
    event: row.event,
    claim: short(row.claimId),
    address: short(row.address),
    session: short(row.sessionId),
    payload: formatPayload(row.payload),
  }));
}

/**
 * Renders fixed-width colored table for terminal output
 *
 * @param {RowData[]} rows Printable table rows
 * @param {boolean} colorEnabled Whether ANSI colors are enabled
 * @returns {string} Formatted table string
 */
function renderTable(rows: RowData[], colorEnabled: boolean): string {
  const headers: RowData = {
    time: "time",
    level: "level",
    event: "event",
    claim: "claim",
    address: "address",
    session: "session",
    payload: "payload",
  };

  const maxWidths: Record<keyof RowData, number> = {
    time: 20,
    level: 5,
    event: 42,
    claim: 18,
    address: 18,
    session: 18,
    payload: 78,
  };

  const widths: Record<keyof RowData, number> = {
    time: Math.min(maxWidths.time, Math.max(headers.time.length, ...rows.map((row) => row.time.length))),
    level: Math.min(maxWidths.level, Math.max(headers.level.length, ...rows.map((row) => row.level.length))),
    event: Math.min(maxWidths.event, Math.max(headers.event.length, ...rows.map((row) => row.event.length))),
    claim: Math.min(maxWidths.claim, Math.max(headers.claim.length, ...rows.map((row) => row.claim.length))),
    address: Math.min(maxWidths.address, Math.max(headers.address.length, ...rows.map((row) => row.address.length))),
    session: Math.min(maxWidths.session, Math.max(headers.session.length, ...rows.map((row) => row.session.length))),
    payload: Math.min(maxWidths.payload, Math.max(headers.payload.length, ...rows.map((row) => row.payload.length))),
  };

  const renderCell = (value: string, key: keyof RowData): string => truncate(value, widths[key]).padEnd(widths[key], " ");

  const headerLine = [
    renderCell(headers.time, "time"),
    renderCell(headers.level, "level"),
    renderCell(headers.event, "event"),
    renderCell(headers.claim, "claim"),
    renderCell(headers.address, "address"),
    renderCell(headers.session, "session"),
    renderCell(headers.payload, "payload"),
  ].join("  ");

  const separatorLine = [
    "-".repeat(widths.time),
    "-".repeat(widths.level),
    "-".repeat(widths.event),
    "-".repeat(widths.claim),
    "-".repeat(widths.address),
    "-".repeat(widths.session),
    "-".repeat(widths.payload),
  ].join("  ");

  const lines = [
    colorize(headerLine, `${COLOR.bold}${COLOR.cyan}`, colorEnabled),
    colorize(separatorLine, COLOR.dim, colorEnabled),
  ];

  for (const row of rows) {
    const levelCell = colorize(renderCell(row.level, "level"), levelColor(row.level), colorEnabled);
    const eventCell = colorize(renderCell(row.event, "event"), COLOR.magenta, colorEnabled);
    const payloadCell = colorize(renderCell(row.payload, "payload"), COLOR.green, colorEnabled);

    lines.push(
      [
        renderCell(row.time, "time"),
        levelCell,
        eventCell,
        renderCell(row.claim, "claim"),
        renderCell(row.address, "address"),
        renderCell(row.session, "session"),
        payloadCell,
      ].join("  "),
    );
  }

  return lines.join("\n");
}

/**
 * Loads filtered audit logs and prints them to stdout
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const latestLogs = await prisma.auditLog.findMany({
      where: {
        event: options.event,
        address: options.address,
        claimId: options.claimId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: options.limit,
    });
    const logs = [...latestLogs].reverse();

    if (options.json) {
      console.log(JSON.stringify(logs, null, 2));
      return;
    }

    if (logs.length === 0) {
      console.log("No audit logs found for provided filters");
      return;
    }

    const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const rows = rowsFromLogs(logs);
    console.log(`Found ${logs.length} audit log entries`);
    console.log(renderTable(rows, colorEnabled));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
