export type StatsPeriod = "day" | "week" | "month";

export type LifecycleStatsInput = {
  gamesStarted: Date[];
  coinRequests: Date[];
  payoutsSent: Date[];
  manualReview: Date[];
};

export type LifecycleStatsRow = {
  period: string;
  gamesStarted: number;
  coinRequests: number;
  payoutsSent: number;
  manualReview: number;
};

export const PAYOUT_SENT_AUDIT_EVENTS = [
  "PAYOUT_PAID_DRY_RUN",
  "PAYOUT_PAID_ONCHAIN",
  "PAYOUT_SUBMITTED_ONCHAIN",
] as const;

/**
 * Builds period-bucketed lifecycle stats for recent activity windows
 *
 * @param {LifecycleStatsInput} input Event timestamps by metric
 * @param {StatsPeriod} period Requested aggregation period
 * @param {number} [limit=12] Number of trailing periods to include
 * @returns {LifecycleStatsRow[]} Recent stats rows sorted ascending by period
 */
export function buildLifecycleStats(
  input: LifecycleStatsInput,
  period: StatsPeriod,
  limit = 12,
): LifecycleStatsRow[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const allDates = [
    ...input.gamesStarted,
    ...input.coinRequests,
    ...input.payoutsSent,
    ...input.manualReview,
  ].filter((value) => value instanceof Date && Number.isFinite(value.getTime()));

  if (allDates.length === 0) {
    return [];
  }

  const latestDate = allDates.reduce((latest, current) =>
    current.getTime() > latest.getTime() ? current : latest,
  );
  const lastPeriodStart = startOfPeriod(latestDate, period);
  const buckets = new Map<string, LifecycleStatsRow>();

  for (let offset = normalizedLimit - 1; offset >= 0; offset -= 1) {
    const bucketStart = shiftPeriod(lastPeriodStart, period, -offset);
    const key = formatPeriodKey(bucketStart, period);
    buckets.set(key, {
      period: key,
      gamesStarted: 0,
      coinRequests: 0,
      payoutsSent: 0,
      manualReview: 0,
    });
  }

  addDatesToBuckets(buckets, input.gamesStarted, period, "gamesStarted");
  addDatesToBuckets(buckets, input.coinRequests, period, "coinRequests");
  addDatesToBuckets(buckets, input.payoutsSent, period, "payoutsSent");
  addDatesToBuckets(buckets, input.manualReview, period, "manualReview");

  return [...buckets.values()];
}

/**
 * Normalizes date to local start of requested period
 *
 * @param {Date} value Source date
 * @param {StatsPeriod} period Aggregation period
 * @returns {Date} Local period start
 */
function startOfPeriod(value: Date, period: StatsPeriod): Date {
  const dayStart = new Date(value.getFullYear(), value.getMonth(), value.getDate());

  if (period === "day") {
    return dayStart;
  }

  if (period === "week") {
    const isoWeekday = (dayStart.getDay() + 6) % 7;
    dayStart.setDate(dayStart.getDate() - isoWeekday);
    return dayStart;
  }

  return new Date(value.getFullYear(), value.getMonth(), 1);
}

/**
 * Shifts a local period-start date by whole periods
 *
 * @param {Date} value Period-start date
 * @param {StatsPeriod} period Aggregation period
 * @param {number} offset Number of periods to shift
 * @returns {Date} Shifted period-start date
 */
function shiftPeriod(value: Date, period: StatsPeriod, offset: number): Date {
  const shifted = new Date(value);

  if (period === "day") {
    shifted.setDate(shifted.getDate() + offset);
    return shifted;
  }

  if (period === "week") {
    shifted.setDate(shifted.getDate() + offset * 7);
    return shifted;
  }

  return new Date(shifted.getFullYear(), shifted.getMonth() + offset, 1);
}

/**
 * Formats period-start date into stable printable key
 *
 * @param {Date} value Period-start date
 * @param {StatsPeriod} period Aggregation period
 * @returns {string} Printable period key
 */
function formatPeriodKey(value: Date, period: StatsPeriod): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  if (period === "month") {
    return `${year}-${month}`;
  }

  return `${year}-${month}-${day}`;
}

/**
 * Accumulates one metric into prebuilt period buckets
 *
 * @param {Map<string, LifecycleStatsRow>} buckets Existing period buckets
 * @param {Date[]} dates Metric timestamps
 * @param {StatsPeriod} period Aggregation period
 * @param {keyof Omit<LifecycleStatsRow, "period">} metric Metric field to increment
 */
function addDatesToBuckets(
  buckets: Map<string, LifecycleStatsRow>,
  dates: Date[],
  period: StatsPeriod,
  metric: keyof Omit<LifecycleStatsRow, "period">,
): void {
  for (const value of dates) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      continue;
    }

    const key = formatPeriodKey(startOfPeriod(value, period), period);
    const bucket = buckets.get(key);
    if (!bucket) {
      continue;
    }
    bucket[metric] += 1;
  }
}
