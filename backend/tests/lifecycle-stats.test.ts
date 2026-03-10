import assert from "node:assert/strict";
import test from "node:test";
import { buildLifecycleStats } from "../src/lifecycle-stats.js";

test("buildLifecycleStats should aggregate recent daily buckets with zeros for gaps", () => {
  const rows = buildLifecycleStats(
    {
      gamesStarted: [new Date(2026, 2, 8, 12, 0), new Date(2026, 2, 10, 9, 0)],
      coinRequests: [new Date(2026, 2, 10, 10, 30)],
      payoutsSent: [new Date(2026, 2, 8, 13, 0)],
      manualReview: [new Date(2026, 2, 9, 11, 0)],
    },
    "day",
    3,
  );

  assert.deepEqual(rows, [
    {
      period: "2026-03-08",
      gamesStarted: 1,
      coinRequests: 0,
      payoutsSent: 1,
      manualReview: 0,
    },
    {
      period: "2026-03-09",
      gamesStarted: 0,
      coinRequests: 0,
      payoutsSent: 0,
      manualReview: 1,
    },
    {
      period: "2026-03-10",
      gamesStarted: 1,
      coinRequests: 1,
      payoutsSent: 0,
      manualReview: 0,
    },
  ]);
});

test("buildLifecycleStats should bucket weekly stats by monday", () => {
  const rows = buildLifecycleStats(
    {
      gamesStarted: [new Date(2026, 2, 10, 12, 0), new Date(2026, 2, 16, 9, 0)],
      coinRequests: [new Date(2026, 2, 10, 12, 30)],
      payoutsSent: [new Date(2026, 2, 16, 14, 0)],
      manualReview: [new Date(2026, 2, 11, 8, 0)],
    },
    "week",
    2,
  );

  assert.deepEqual(rows, [
    {
      period: "2026-03-09",
      gamesStarted: 1,
      coinRequests: 1,
      payoutsSent: 0,
      manualReview: 1,
    },
    {
      period: "2026-03-16",
      gamesStarted: 1,
      coinRequests: 0,
      payoutsSent: 1,
      manualReview: 0,
    },
  ]);
});

test("buildLifecycleStats should aggregate monthly buckets", () => {
  const rows = buildLifecycleStats(
    {
      gamesStarted: [new Date(2026, 1, 26, 12, 0), new Date(2026, 2, 10, 12, 0)],
      coinRequests: [new Date(2026, 2, 2, 12, 0)],
      payoutsSent: [new Date(2026, 2, 3, 12, 0)],
      manualReview: [],
    },
    "month",
    2,
  );

  assert.deepEqual(rows, [
    {
      period: "2026-02",
      gamesStarted: 1,
      coinRequests: 0,
      payoutsSent: 0,
      manualReview: 0,
    },
    {
      period: "2026-03",
      gamesStarted: 1,
      coinRequests: 1,
      payoutsSent: 1,
      manualReview: 0,
    },
  ]);
});
