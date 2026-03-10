import process from "node:process";
import { PrismaClient } from "@prisma/client";
import {
  buildLifecycleStats,
  PAYOUT_SENT_AUDIT_EVENTS,
  type LifecycleStatsRow,
  type StatsPeriod,
} from "../src/lifecycle-stats.js";

type CliOptions = {
  json: boolean;
  limit: number;
  period: StatsPeriod | "all";
};

type MetricColumn = keyof Omit<LifecycleStatsRow, "period">;

const PERIODS: StatsPeriod[] = ["day", "week", "month"];
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
 * Parses CLI flags for lifecycle stats viewer
 *
 * @param {string[]} argv Raw CLI arguments
 * @returns {CliOptions} Parsed options
 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    limit: 12,
    period: "all",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = Math.floor(parsed);
      }
      i += 1;
      continue;
    }

    if (arg === "--period" && next) {
      if (next === "day" || next === "week" || next === "month" || next === "all") {
        options.period = next;
      }
      i += 1;
    }
  }

  return options;
}

/**
 * Pads table cell to fixed width
 *
 * @param {string} value Raw cell value
 * @param {number} width Target width
 * @returns {string} Padded cell
 */
function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
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
 * Renders one stats table for terminal output
 *
 * @param {StatsPeriod} period Aggregation period
 * @param {LifecycleStatsRow[]} rows Rows to print
 * @param {boolean} colorEnabled Whether ANSI colors are enabled
 * @returns {string} Printable table
 */
function renderTable(period: StatsPeriod, rows: LifecycleStatsRow[], colorEnabled: boolean): string {
  const headers: Record<"period" | MetricColumn, string> = {
    period,
    gamesStarted: "games_started",
    coinRequests: "coin_requests",
    payoutsSent: "payouts_sent",
    manualReview: "manual_review",
  };

  const widths = {
    period: Math.max(headers.period.length, ...rows.map((row) => row.period.length)),
    gamesStarted: Math.max(headers.gamesStarted.length, ...rows.map((row) => String(row.gamesStarted).length)),
    coinRequests: Math.max(headers.coinRequests.length, ...rows.map((row) => String(row.coinRequests).length)),
    payoutsSent: Math.max(headers.payoutsSent.length, ...rows.map((row) => String(row.payoutsSent).length)),
    manualReview: Math.max(headers.manualReview.length, ...rows.map((row) => String(row.manualReview).length)),
  };

  const lines = [
    colorize(
      [
        pad(headers.period, widths.period),
        pad(headers.gamesStarted, widths.gamesStarted),
        pad(headers.coinRequests, widths.coinRequests),
        pad(headers.payoutsSent, widths.payoutsSent),
        pad(headers.manualReview, widths.manualReview),
      ].join("  "),
      `${COLOR.bold}${COLOR.cyan}`,
      colorEnabled,
    ),
    colorize(
      [
        "-".repeat(widths.period),
        "-".repeat(widths.gamesStarted),
        "-".repeat(widths.coinRequests),
        "-".repeat(widths.payoutsSent),
        "-".repeat(widths.manualReview),
      ].join("  "),
      COLOR.dim,
      colorEnabled,
    ),
  ];

  for (const row of rows) {
    lines.push(
      [
        colorize(pad(row.period, widths.period), COLOR.magenta, colorEnabled),
        colorize(String(row.gamesStarted).padStart(widths.gamesStarted, " "), COLOR.blue, colorEnabled),
        colorize(String(row.coinRequests).padStart(widths.coinRequests, " "), COLOR.yellow, colorEnabled),
        colorize(String(row.payoutsSent).padStart(widths.payoutsSent, " "), COLOR.green, colorEnabled),
        colorize(String(row.manualReview).padStart(widths.manualReview, " "), COLOR.red, colorEnabled),
      ].join("  "),
    );
  }

  return lines.join("\n");
}

/**
 * Loads timestamps for lifecycle metrics from audit log
 *
 * @param {PrismaClient} prisma Active Prisma client
 * @returns {Promise<{
 *   gamesStarted: Date[];
 *   coinRequests: Date[];
 *   payoutsSent: Date[];
 *   manualReview: Date[];
 * }>} Metric timestamps
 */
async function loadMetricDates(prisma: PrismaClient) {
  const logs = await prisma.auditLog.findMany({
    where: {
      event: {
        in: [
          "SESSION_STARTED",
          "CLAIM_PREPARED",
          "CLAIM_MANUAL_REVIEW",
          ...PAYOUT_SENT_AUDIT_EVENTS,
        ],
      },
    },
    select: {
      event: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  return logs.reduce<{
    gamesStarted: Date[];
    coinRequests: Date[];
    payoutsSent: Date[];
    manualReview: Date[];
  }>(
    (acc, row) => {
      if (row.event === "SESSION_STARTED") {
        acc.gamesStarted.push(row.createdAt);
      } else if (row.event === "CLAIM_PREPARED") {
        acc.coinRequests.push(row.createdAt);
      } else if (row.event === "CLAIM_MANUAL_REVIEW") {
        acc.manualReview.push(row.createdAt);
      } else if (PAYOUT_SENT_AUDIT_EVENTS.includes(row.event as (typeof PAYOUT_SENT_AUDIT_EVENTS)[number])) {
        acc.payoutsSent.push(row.createdAt);
      }
      return acc;
    },
    {
      gamesStarted: [],
      coinRequests: [],
      payoutsSent: [],
      manualReview: [],
    },
  );
}

/**
 * Main CLI entrypoint
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const metricDates = await loadMetricDates(prisma);
    const periods = options.period === "all" ? PERIODS : [options.period];
    const output = periods.map((period) => ({
      period,
      rows: buildLifecycleStats(metricDates, period, options.limit),
    }));

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    const nonEmpty = output.filter((section) => section.rows.length > 0);
    if (nonEmpty.length === 0) {
      console.log("No lifecycle stats found");
      return;
    }

    const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    for (const [index, section] of nonEmpty.entries()) {
      if (index > 0) {
        console.log("");
      }
      console.log(colorize(`Period: ${section.period}`, `${COLOR.bold}${COLOR.cyan}`, colorEnabled));
      console.log(renderTable(section.period, section.rows, colorEnabled));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
