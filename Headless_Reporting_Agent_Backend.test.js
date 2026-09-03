/**
 * Unit tests for Headless_Reporting_Agent_Backend.js
 *
 * Run with Node's built-in test runner — no package.json required:
 *   node --test Headless_Reporting_Agent_Backend.test.js
 *
 * Requires Node ≥ 18 (node:test + assert are built-in).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Import the named exports we need to test.
// The backend exports these at the bottom of the file.
// ---------------------------------------------------------------------------
import {
  computeRates,
  filterByStatus,
  parseQuery,
  normalizeRestRows,
  normalizeMessageRows,
  patchSessionState,
  getSessionState,
} from "./Headless_Reporting_Agent_Backend.js";


// ===========================================================================
// computeRates()
// ===========================================================================

describe("computeRates()", () => {
  it("computes all six rate fields correctly", () => {
    const bucket = {
      date: "2026-01-15",
      sent: 1000, delivered: 900, bounced: 80, undelivered: 20,
      opens: 360, clicks: 72,
    };
    const result = computeRates(bucket);

    assert.strictEqual(result.deliveryRate,    90);       // 900/1000
    assert.strictEqual(result.bounceRate,       8);       // 80/1000
    assert.strictEqual(result.undeliveredRate,  2);       // 20/1000
    assert.strictEqual(result.openRate,         40);      // 360/900
    assert.strictEqual(result.clickRate,         8);      // 72/900
    assert.strictEqual(result.ctor,             20);      // 72/360
  });

  it("does not mutate the original bucket", () => {
    const bucket = { date: "2026-01-15", sent: 100, delivered: 90, bounced: 10, undelivered: 0, opens: 20, clicks: 5 };
    computeRates(bucket);
    assert.strictEqual(Object.keys(bucket).length, 7); // no extra fields added
  });

  it("returns 0 for all rates when sent is 0 (no division by zero)", () => {
    const bucket = { date: "2026-01-15", sent: 0, delivered: 0, bounced: 0, undelivered: 0, opens: 0, clicks: 0 };
    const result = computeRates(bucket);
    assert.strictEqual(result.deliveryRate,    0);
    assert.strictEqual(result.bounceRate,       0);
    assert.strictEqual(result.undeliveredRate,  0);
    assert.strictEqual(result.openRate,         0);
    assert.strictEqual(result.clickRate,        0);
    assert.strictEqual(result.ctor,             0);
  });

  it("returns 0 for openRate/clickRate/ctor when delivered is 0", () => {
    const bucket = { date: "2026-01-15", sent: 50, delivered: 0, bounced: 50, undelivered: 0, opens: 0, clicks: 0 };
    const result = computeRates(bucket);
    assert.strictEqual(result.openRate,  0);
    assert.strictEqual(result.clickRate, 0);
    assert.strictEqual(result.ctor,      0);
  });

  it("returns 0 for ctor when opens is 0 but clicks somehow non-zero", () => {
    // Edge case: defensive, should never happen in real data
    const bucket = { date: "2026-01-15", sent: 100, delivered: 80, bounced: 20, undelivered: 0, opens: 0, clicks: 5 };
    const result = computeRates(bucket);
    assert.strictEqual(result.ctor, 0);
  });

  it("preserves all original fields in the returned object", () => {
    const bucket = { date: "2026-03-01", sent: 200, delivered: 180, bounced: 15, undelivered: 5, opens: 60, clicks: 12 };
    const result = computeRates(bucket);
    assert.strictEqual(result.date,        "2026-03-01");
    assert.strictEqual(result.sent,        200);
    assert.strictEqual(result.delivered,   180);
    assert.strictEqual(result.bounced,      15);
    assert.strictEqual(result.undelivered,   5);
    assert.strictEqual(result.opens,        60);
    assert.strictEqual(result.clicks,       12);
  });
});


// ===========================================================================
// filterByStatus()
// ===========================================================================

describe("filterByStatus()", () => {
  const rows = [
    { date: "2026-01-01", sent: 1000, delivered: 900, bounced: 80, undelivered: 20, opens: 300, clicks: 60 },
    { date: "2026-01-02", sent: 800,  delivered: 740, bounced: 40, undelivered: 20, opens: 200, clicks: 30 },
  ];

  it("returns rows unchanged for status='all'", () => {
    const result = filterByStatus(rows, "all");
    assert.deepStrictEqual(result, rows);
  });

  it("zeros all columns except delivered when status='delivered'", () => {
    const result = filterByStatus(rows, "delivered");
    for (const r of result) {
      assert.strictEqual(r.bounced,     0);
      assert.strictEqual(r.undelivered, 0);
      assert.strictEqual(r.opens,       0);
      assert.strictEqual(r.clicks,      0);
    }
    assert.strictEqual(result[0].delivered, 900);
    assert.strictEqual(result[1].delivered, 740);
  });

  it("preserves sent as denominator for all status values", () => {
    for (const status of ["delivered", "bounced", "undelivered", "opened", "clicked"]) {
      const result = filterByStatus(rows, status);
      assert.strictEqual(result[0].sent, 1000);
      assert.strictEqual(result[1].sent, 800);
    }
  });

  it("zeros all columns except bounced when status='bounced'", () => {
    const result = filterByStatus(rows, "bounced");
    assert.strictEqual(result[0].bounced, 80);
    assert.strictEqual(result[0].delivered, 0);
    assert.strictEqual(result[0].opens, 0);
  });

  it("zeros all columns except opens when status='opened'", () => {
    const result = filterByStatus(rows, "opened");
    assert.strictEqual(result[0].opens, 300);
    assert.strictEqual(result[0].delivered, 0);
    assert.strictEqual(result[0].clicks, 0);
  });

  it("zeros all columns except clicks when status='clicked'", () => {
    const result = filterByStatus(rows, "clicked");
    assert.strictEqual(result[0].clicks, 60);
    assert.strictEqual(result[0].opens, 0);
  });

  it("zeros all columns except undelivered when status='undelivered'", () => {
    const result = filterByStatus(rows, "undelivered");
    assert.strictEqual(result[0].undelivered, 20);
    assert.strictEqual(result[0].delivered, 0);
  });

  it("does not mutate the input rows", () => {
    filterByStatus(rows, "bounced");
    assert.strictEqual(rows[0].delivered, 900); // unchanged
  });
});


// ===========================================================================
// parseQuery()
// ===========================================================================

describe("parseQuery()", () => {
  it("throws MISSING_JOURNEY when no journeyId is provided", () => {
    assert.throws(
      () => parseQuery({}, {}),
      (err) => err.code === "MISSING_JOURNEY"
    );
  });

  it("resolves journeyId from raw query", () => {
    const result = parseQuery({ journeyId: "Welcome Series" }, {});
    assert.strictEqual(result.journeyId, "Welcome Series");
  });

  it("falls back to inheritedState.journeyId when raw.journeyId is missing", () => {
    const result = parseQuery({}, { journeyId: "Cart Abandonment" });
    assert.strictEqual(result.journeyId, "Cart Abandonment");
  });

  it("uses all default metrics when none are provided", () => {
    const result = parseQuery({ journeyId: "J1" }, {});
    assert.deepStrictEqual(result.metrics, ["sent", "delivered", "bounced", "undelivered", "opens", "clicks"]);
  });

  it("uses provided metrics when specified", () => {
    const result = parseQuery({ journeyId: "J1", metrics: ["bounced", "clicks"] }, {});
    assert.deepStrictEqual(result.metrics, ["bounced", "clicks"]);
  });

  it("resolves relative range 'last_7d' correctly", () => {
    const result = parseQuery({ journeyId: "J1", range: "last_7d" }, {});
    const spanDays = (new Date(result.dateRange.end) - new Date(result.dateRange.start)) / 86400000;
    assert.ok(spanDays >= 6.9 && spanDays <= 7.1, `Expected ~7 days, got ${spanDays}`);
  });

  it("resolves relative range 'last_30d' correctly", () => {
    const result = parseQuery({ journeyId: "J1", range: "last_30d" }, {});
    const spanDays = (new Date(result.dateRange.end) - new Date(result.dateRange.start)) / 86400000;
    assert.ok(spanDays >= 29.9 && spanDays <= 30.1, `Expected ~30 days, got ${spanDays}`);
  });

  it("accepts an explicit dateRange object", () => {
    const dr = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-05T00:00:00.000Z" };
    const result = parseQuery({ journeyId: "J1", dateRange: dr }, {});
    assert.deepStrictEqual(result.dateRange, dr);
  });

  it("falls back to inheritedState.dateRange when no range is given", () => {
    const dr = { start: "2026-02-01T00:00:00.000Z", end: "2026-02-15T00:00:00.000Z" };
    const result = parseQuery({ journeyId: "J1" }, { dateRange: dr });
    assert.deepStrictEqual(result.dateRange, dr);
  });

  it("defaults to last_30d when no range anywhere", () => {
    const result = parseQuery({ journeyId: "J1" }, {});
    const spanDays = (new Date(result.dateRange.end) - new Date(result.dateRange.start)) / 86400000;
    assert.ok(spanDays >= 29.9 && spanDays <= 30.1, `Expected ~30 days, got ${spanDays}`);
  });

  it("sets groupBy='day' for spans > 3 days", () => {
    const result = parseQuery({ journeyId: "J1", range: "last_30d" }, {});
    assert.strictEqual(result.groupBy, "day");
  });

  it("sets groupBy='hour' for spans ≤ 3 days", () => {
    const dr = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" };
    const result = parseQuery({ journeyId: "J1", dateRange: dr }, {});
    assert.strictEqual(result.groupBy, "hour");
  });

  it("uses 'all' as default channel when none is provided", () => {
    const result = parseQuery({ journeyId: "J1" }, {});
    assert.strictEqual(result.channel, "all");
  });

  it("falls back to inheritedState.channel when raw.channel is missing", () => {
    const result = parseQuery({ journeyId: "J1" }, { channel: "sms" });
    assert.strictEqual(result.channel, "sms");
  });
});


// ===========================================================================
// normalizeRestRows()
// ===========================================================================

describe("normalizeRestRows()", () => {
  // Helpers to build fake DE rows
  const row = (sentDate, messageStatus) => ({ SentDate: sentDate, MessageStatus: messageStatus });

  it("returns an empty array for no rows", () => {
    assert.deepStrictEqual(normalizeRestRows([]), []);
  });

  it("ignores rows with a null/unparseable SentDate", () => {
    const result = normalizeRestRows([
      row(null, "Delivered"),
      row("not-a-date", "Sent"),
    ]);
    assert.strictEqual(result.length, 0);
  });

  it("groups rows by day for groupBy='day'", () => {
    const rows = [
      row("1/15/2026 9:00:00 AM",  "Sent"),
      row("1/15/2026 2:00:00 PM",  "Delivered"),
      row("1/16/2026 10:00:00 AM", "Bounced"),
    ];
    const result = normalizeRestRows(rows, "day");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].date, "2026-01-15");
    assert.strictEqual(result[1].date, "2026-01-16");
  });

  it("groups rows by hour for groupBy='hour'", () => {
    const rows = [
      row("1/15/2026 9:00:00 AM",  "Delivered"),
      row("1/15/2026 9:30:00 AM",  "Delivered"),
      row("1/15/2026 10:00:00 AM", "Sent"),
    ];
    const result = normalizeRestRows(rows, "hour");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].date, "2026-01-15T09");
    assert.strictEqual(result[1].date, "2026-01-15T10");
  });

  it("correctly counts MessageStatus=Sent as sent only (not delivered)", () => {
    const result = normalizeRestRows([row("3/24/2026 11:45:00 AM", "Sent")], "day");
    assert.strictEqual(result[0].sent,      1);
    assert.strictEqual(result[0].delivered, 0);
    assert.strictEqual(result[0].bounced,   0);
  });

  it("counts Delivered as both sent and delivered", () => {
    // MESSAGE_STATUS.SENT includes "Delivered"
    const result = normalizeRestRows([row("3/24/2026 11:45:00 AM", "Delivered")], "day");
    assert.strictEqual(result[0].sent,      1);
    assert.strictEqual(result[0].delivered, 1);
    assert.strictEqual(result[0].bounced,   0);
  });

  it("counts Opened as sent + delivered + opens", () => {
    const result = normalizeRestRows([row("3/24/2026 11:45:00 AM", "Opened")], "day");
    assert.strictEqual(result[0].sent,      1);
    assert.strictEqual(result[0].delivered, 1);
    assert.strictEqual(result[0].opens,     1);
    assert.strictEqual(result[0].clicks,    0);
  });

  it("counts Clicked as sent + delivered + clicks (opens NOT incremented — Clicked is not in OPENS set)", () => {
    // MESSAGE_STATUS.OPENS = ["Opened"] only. Clicked is in DELIVERED (hence delivered=1)
    // and in CLICKS (hence clicks=1), but NOT in OPENS. The DE logs one status per row.
    const result = normalizeRestRows([row("3/24/2026 11:45:00 AM", "Clicked")], "day");
    assert.strictEqual(result[0].sent,      1);
    assert.strictEqual(result[0].delivered, 1);
    assert.strictEqual(result[0].opens,     0);
    assert.strictEqual(result[0].clicks,    1);
  });

  it("counts Bounced as sent only (not delivered)", () => {
    const result = normalizeRestRows([row("3/24/2026 11:45:00 AM", "Bounced")], "day");
    assert.strictEqual(result[0].sent,      1);
    assert.strictEqual(result[0].bounced,   1);
    assert.strictEqual(result[0].delivered, 0);
  });

  it("counts Undelivered as sent + undelivered (not delivered)", () => {
    const result = normalizeRestRows([row("3/24/2026 11:45:00 AM", "Undelivered")], "day");
    assert.strictEqual(result[0].sent,        1);
    assert.strictEqual(result[0].undelivered, 1);
    assert.strictEqual(result[0].delivered,   0);
  });

  it("returns buckets sorted by date ascending", () => {
    const rows = [
      row("3/3/2026 9:00:00 AM",  "Sent"),
      row("3/1/2026 9:00:00 AM",  "Sent"),
      row("3/2/2026 9:00:00 AM",  "Sent"),
    ];
    const result = normalizeRestRows(rows, "day");
    assert.strictEqual(result[0].date, "2026-03-01");
    assert.strictEqual(result[1].date, "2026-03-02");
    assert.strictEqual(result[2].date, "2026-03-03");
  });

  it("handles PM-hour conversion correctly (12 PM stays 12, 1 PM becomes 13)", () => {
    const rows = [
      row("1/5/2026 12:00:00 PM", "Sent"),  // noon → T12
      row("1/5/2026 1:00:00 PM",  "Sent"),  // 1 PM → T13
      row("1/5/2026 12:00:00 AM", "Sent"),  // midnight → T00
    ];
    const result = normalizeRestRows(rows, "hour");
    const hours = result.map((r) => r.date.slice(-2));
    assert.ok(hours.includes("12"), "noon hour should be 12");
    assert.ok(hours.includes("13"), "1 PM should be 13");
    assert.ok(hours.includes("00"), "midnight should be 00");
  });

  it("accepts ISO date strings as a fallback (no crash)", () => {
    // Some future API version or test fixture may emit ISO dates
    const rows = [
      { SentDate: "2026-06-01T09:00:00", MessageStatus: "Sent" },
      { SentDate: "2026-06-01",          MessageStatus: "Delivered" },
    ];
    const result = normalizeRestRows(rows, "day");
    // Both should fall into the 2026-06-01 bucket
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].date, "2026-06-01");
    assert.strictEqual(result[0].sent,      2);
    assert.strictEqual(result[0].delivered, 1);
  });

  it("parses SMS date format DD/MM/YYYY, h:mm am/pm (day groupBy)", () => {
    // SMS rows use DD/MM/YYYY locale with comma separator and no seconds
    const rows = [
      row("22/08/2026, 5:03 am",  "Delivered"),
      row("22/08/2026, 11:45 pm", "Undelivered"),
      row("23/08/2026, 12:00 pm", "Delivered"),
    ];
    const result = normalizeRestRows(rows, "day");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].date, "2026-08-22");
    assert.strictEqual(result[0].sent,        2);  // Delivered + Undelivered both count as sent
    assert.strictEqual(result[0].delivered,   1);
    assert.strictEqual(result[0].undelivered, 1);
    assert.strictEqual(result[1].date, "2026-08-23");
    assert.strictEqual(result[1].sent,      1);
    assert.strictEqual(result[1].delivered, 1);
  });

  it("parses SMS date format correctly for hour groupBy", () => {
    const rows = [
      row("22/08/2026, 5:03 am",  "Delivered"),   // → T05
      row("22/08/2026, 1:15 pm",  "Undelivered"), // → T13
      row("22/08/2026, 12:00 pm", "Delivered"),    // → T12
    ];
    const result = normalizeRestRows(rows, "hour");
    const hours = result.map((r) => r.date.slice(-2));
    assert.ok(hours.includes("05"), "5 am should be 05");
    assert.ok(hours.includes("13"), "1 pm should be 13");
    assert.ok(hours.includes("12"), "noon should be 12");
  });
});


// ===========================================================================
// patchSessionState() — mismatch guard
// ===========================================================================

describe("patchSessionState() — drill-level mismatch guard", () => {
  // Use a unique session ID per test to avoid state bleed
  let sid = 0;
  const nextSid = () => `test-session-${++sid}`;

  it("does not correct drillLevel when span ≤ 30 days at message level", async () => {
    const id = nextSid();
    const dr = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-15T00:00:00.000Z" };
    const { session, corrected } = await patchSessionState(id, { drillLevel: "message", dateRange: dr });
    assert.strictEqual(corrected, false);
    assert.strictEqual(session.viewState.drillLevel, "message");
  });

  it("corrects drillLevel from 'message' to 'journey' when span > 30 days", async () => {
    const id = nextSid();
    const dr = { start: "2026-01-01T00:00:00.000Z", end: "2026-04-01T00:00:00.000Z" }; // ~90 days
    const { session, corrected } = await patchSessionState(id, { drillLevel: "message", dateRange: dr });
    assert.strictEqual(corrected, true);
    assert.strictEqual(session.viewState.drillLevel, "journey");
  });

  it("does not correct drillLevel='journey' regardless of span", async () => {
    const id = nextSid();
    const dr = { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T00:00:00.000Z" }; // whole year
    const { session, corrected } = await patchSessionState(id, { drillLevel: "journey", dateRange: dr });
    assert.strictEqual(corrected, false);
    assert.strictEqual(session.viewState.drillLevel, "journey");
  });

  it("does not correct drillLevel='overview' regardless of span", async () => {
    const id = nextSid();
    const dr = { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T00:00:00.000Z" };
    const { session, corrected } = await patchSessionState(id, { drillLevel: "overview", dateRange: dr });
    assert.strictEqual(corrected, false);
    assert.strictEqual(session.viewState.drillLevel, "overview");
  });

  it("merges patch fields without overwriting unpatch fields", async () => {
    const id = nextSid();
    await patchSessionState(id, { journeyId: "Welcome Series", channel: "email" });
    const { session } = await patchSessionState(id, { channel: "sms" });
    // journeyId should still be set from the first patch
    assert.strictEqual(session.viewState.journeyId, "Welcome Series");
    assert.strictEqual(session.viewState.channel,   "sms");
  });

  it("stamps updatedBy and updatedAt on every patch", async () => {
    const id = nextSid();
    const before = Date.now();
    const { session } = await patchSessionState(id, { channel: "push" }, "dashboard");
    const after = Date.now();
    assert.strictEqual(session.viewState.updatedBy, "dashboard");
    const ts = new Date(session.viewState.updatedAt).getTime();
    assert.ok(ts >= before && ts <= after, "updatedAt should be within the test window");
  });

  it("initialises a new session on first patch (no pre-seeding needed)", async () => {
    const id = nextSid();
    const { session } = await patchSessionState(id, { journeyId: "New Journey" });
    assert.strictEqual(session.viewState.journeyId, "New Journey");
    // Default fields should still be present
    assert.strictEqual(session.viewState.channel, "all");
  });
});


// ===========================================================================
// normalizeMessageRows()
// ===========================================================================

describe("normalizeMessageRows()", () => {
  const row = (sentDate, messageStatus, messageName, commType = "Email") => ({
    SentDate: sentDate,
    MessageStatus: messageStatus,
    MessageName: messageName,
    CommunicationType: commType,
  });

  it("returns an empty array when there are no rows", () => {
    assert.deepStrictEqual(normalizeMessageRows([]), []);
  });

  it("groups rows by MessageName into separate entries", () => {
    const rows = [
      row("1/10/2026 9:00:00 AM", "Sent",      "Welcome Email"),
      row("1/10/2026 9:00:00 AM", "Delivered", "Password Reset"),
      row("1/10/2026 9:30:00 AM", "Bounced",   "Welcome Email"),
    ];
    const result = normalizeMessageRows(rows, "day");
    assert.strictEqual(result.length, 2);
    const names = result.map((m) => m.name);
    assert.ok(names.includes("Welcome Email"),  "Should include Welcome Email");
    assert.ok(names.includes("Password Reset"), "Should include Password Reset");
  });

  it("each MessageEntry has id, name, channel, and buckets fields", () => {
    const rows = [
      row("2/1/2026 10:00:00 AM", "Delivered", "Monthly Newsletter", "Email"),
    ];
    const result = normalizeMessageRows(rows, "day");
    assert.strictEqual(result.length, 1);
    const entry = result[0];
    assert.strictEqual(entry.id,      "Monthly Newsletter");
    assert.strictEqual(entry.name,    "Monthly Newsletter");
    assert.strictEqual(entry.channel, "email");  // lower-cased
    assert.ok(Array.isArray(entry.buckets), "buckets should be an array");
    assert.strictEqual(entry.buckets.length, 1);
  });

  it("lower-cases the channel from CommunicationType", () => {
    const rows = [row("3/1/2026 8:00:00 AM", "Sent", "SMS Alert", "SMS")];
    const result = normalizeMessageRows(rows, "day");
    assert.strictEqual(result[0].channel, "sms");
  });

  it("correctly counts metrics per message (not cross-contaminated)", () => {
    const rows = [
      row("1/5/2026 9:00:00 AM", "Delivered", "Msg A"),
      row("1/5/2026 9:00:00 AM", "Bounced",   "Msg A"),
      row("1/5/2026 9:00:00 AM", "Delivered", "Msg B"),
    ];
    const result = normalizeMessageRows(rows, "day");
    const msgA = result.find((m) => m.name === "Msg A");
    const msgB = result.find((m) => m.name === "Msg B");

    assert.ok(msgA, "Msg A should exist");
    assert.ok(msgB, "Msg B should exist");

    // Msg A: 2 rows — 1 Delivered (also counts as sent) + 1 Bounced (also counts as sent)
    const totalsA = msgA.buckets.reduce((a, b) => ({ sent: a.sent + b.sent, delivered: a.delivered + b.delivered, bounced: a.bounced + b.bounced }), { sent: 0, delivered: 0, bounced: 0 });
    assert.strictEqual(totalsA.sent,      2);
    assert.strictEqual(totalsA.delivered, 1);
    assert.strictEqual(totalsA.bounced,   1);

    // Msg B: 1 Delivered
    const totalsB = msgB.buckets.reduce((a, b) => ({ sent: a.sent + b.sent, delivered: a.delivered + b.delivered }), { sent: 0, delivered: 0 });
    assert.strictEqual(totalsB.sent,      1);
    assert.strictEqual(totalsB.delivered, 1);
  });

  it("sorts messages by total sent descending (busiest first)", () => {
    const rows = [
      row("1/1/2026 9:00:00 AM", "Sent",      "Small Message"),          // 1 row
      row("1/1/2026 9:00:00 AM", "Delivered", "Big Message"),             // 3 rows
      row("1/1/2026 9:30:00 AM", "Delivered", "Big Message"),
      row("1/1/2026 10:00:00 AM", "Bounced",  "Big Message"),
    ];
    const result = normalizeMessageRows(rows, "day");
    assert.strictEqual(result[0].name, "Big Message",   "Busiest message should be first");
    assert.strictEqual(result[1].name, "Small Message", "Quieter message should be second");
  });

  it("uses '(unnamed)' for rows with no MessageName", () => {
    const rows = [
      { SentDate: "1/2/2026 8:00:00 AM", MessageStatus: "Sent", CommunicationType: "Email" },
    ];
    const result = normalizeMessageRows(rows, "day");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "(unnamed)");
  });

  it("buckets include computeRates() derived fields", () => {
    const rows = [
      row("1/8/2026 9:00:00 AM", "Delivered", "Rate Test"),
    ];
    const result = normalizeMessageRows(rows, "day");
    const bucket = result[0].buckets[0];
    assert.ok("deliveryRate" in bucket, "Should have deliveryRate");
    assert.ok("bounceRate"   in bucket, "Should have bounceRate");
  });
});
