/**
 * Unit tests for Headless_Reporting_Agent.js
 *
 * Run with Node's built-in test runner — no package.json required:
 *   node --test Headless_Reporting_Agent.test.js
 *
 * Requires Node ≥ 18 (node:test + assert are built-in).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseIntent,
  sumBuckets,
  formatJourneyResponse,
  formatOverviewResponse,
  buildJourneyHandoff,
  buildOverviewHandoff,
  resolveRange,
  PENDING_HANDOFFS,
  handleUserMessage,
} from "./Headless_Reporting_Agent.js";


// ===========================================================================
// parseIntent()
// ===========================================================================

describe("parseIntent()", () => {
  it("returns type='confirm_handoff' for explicit yes phrases", () => {
    for (const text of ["yes", "Yes", "yeah", "sure", "ok", "okay", "go ahead", "show me", "open it", "confirm", "do it"]) {
      const r = parseIntent(text);
      assert.strictEqual(r.type, "confirm_handoff", `Expected confirm_handoff for "${text}"`);
    }
  });

  it("returns type='overview_query' for multi-journey signals", () => {
    const overviewPhrases = [
      "show me all journeys",
      "compare email vs SMS",
      "which journey had the worst delivery rate",
      "give me an overview",
      "summary of all campaigns",
      "leaderboard",
      "ranking",
    ];
    for (const text of overviewPhrases) {
      const r = parseIntent(text);
      assert.strictEqual(r.type, "overview_query", `Expected overview_query for "${text}"`);
    }
  });

  it("returns type='journey_query' when a journey name is identified", () => {
    const r = parseIntent("How did Welcome Series perform last 30 days?");
    assert.strictEqual(r.type, "journey_query");
    assert.ok(r.journeyId?.includes("Welcome"), `Expected journeyId to contain 'Welcome', got '${r.journeyId}'`);
  });

  it("returns type='unknown' for off-topic or greetings", () => {
    const r = parseIntent("Hello there");
    assert.strictEqual(r.type, "unknown");
  });

  it("extracts channel='email' from 'email' keyword", () => {
    const r = parseIntent("email delivery for Welcome last week");
    assert.strictEqual(r.channel, "email");
  });

  it("extracts channel='sms' from 'sms' and 'text' keywords", () => {
    assert.strictEqual(parseIntent("SMS bounce rate last month").channel, "sms");
    assert.strictEqual(parseIntent("text messages last week").channel,    "sms");
  });

  it("extracts channel='push' from 'push' keyword", () => {
    assert.strictEqual(parseIntent("push delivery stats").channel, "push");
  });

  it("defaults channel to 'all' when no channel keyword found", () => {
    assert.strictEqual(parseIntent("How did Welcome Journey do?").channel, "all");
  });

  it("extracts range='last_7d' for 'last week' / 'past week' / '7 days'", () => {
    assert.strictEqual(parseIntent("results for last week").range, "last_7d");
    assert.strictEqual(parseIntent("past week performance").range,  "last_7d");
    assert.strictEqual(parseIntent("7 days report").range,          "last_7d");
  });

  it("extracts range='last_30d' for 'last month' / 'last 30 days'", () => {
    assert.strictEqual(parseIntent("last month summary").range,    "last_30d");
    assert.strictEqual(parseIntent("last 30 days stats").range,    "last_30d");
  });

  it("extracts range='this_month' for 'this month'", () => {
    assert.strictEqual(parseIntent("this month results").range, "this_month");
  });

  it("returns null range when no date range keyword is present", () => {
    assert.strictEqual(parseIntent("Welcome Journey bounce rate").range, null);
  });

  it("extracts metric hints for 'bounce rate' and 'open rate'", () => {
    const r = parseIntent("bounce rate and open rate for Welcome Journey");
    assert.ok(r.metrics.includes("bounced"), "Expected 'bounced' in metrics");
    assert.ok(r.metrics.includes("opens"),   "Expected 'opens' in metrics");
  });

  it("extracts journey name from quoted string", () => {
    const r = parseIntent(`How did "Welcome Series" perform?`);
    assert.strictEqual(r.journeyId, "Welcome Series");
  });

  it("extracts journey name from 'for <Name> journey' pattern", () => {
    const r = parseIntent("show delivery for Outage Alert journey last 7 days");
    assert.ok(r.journeyId?.includes("Outage Alert"), `Got: ${r.journeyId}`);
  });

  it("extracts journey name from 'how did <Name> perform' pattern", () => {
    const r = parseIntent("How did Cart Abandonment perform last week?");
    assert.ok(r.journeyId?.includes("Cart"), `Got: ${r.journeyId}`);
  });

  it("does not emit duplicate metrics", () => {
    // 'delivery rate' and 'delivered' both map to 'delivered'
    const r = parseIntent("delivery rate and delivered count");
    const deliveredCount = r.metrics.filter((m) => m === "delivered").length;
    assert.strictEqual(deliveredCount, 1, "Should have exactly one 'delivered' metric");
  });
});


// ===========================================================================
// sumBuckets()
// ===========================================================================

describe("sumBuckets()", () => {
  it("sums all six metric fields across multiple buckets", () => {
    const buckets = [
      { date: "2026-01-01", sent: 100, delivered: 90, bounced: 5, undelivered: 5, opens: 30, clicks: 10 },
      { date: "2026-01-02", sent: 200, delivered: 180, bounced: 10, undelivered: 10, opens: 60, clicks: 20 },
    ];
    const t = sumBuckets(buckets);
    assert.strictEqual(t.sent,        300);
    assert.strictEqual(t.delivered,   270);
    assert.strictEqual(t.bounced,      15);
    assert.strictEqual(t.undelivered,  15);
    assert.strictEqual(t.opens,        90);
    assert.strictEqual(t.clicks,       30);
  });

  it("also provides computed rate fields via computeRates()", () => {
    const buckets = [
      { date: "2026-01-01", sent: 1000, delivered: 900, bounced: 80, undelivered: 20, opens: 360, clicks: 72 },
    ];
    const t = sumBuckets(buckets);
    assert.strictEqual(t.deliveryRate,   90);   // 900/1000
    assert.strictEqual(t.bounceRate,      8);   // 80/1000
    assert.strictEqual(t.undeliveredRate, 2);   // 20/1000
    assert.strictEqual(t.openRate,       40);   // 360/900
    assert.strictEqual(t.ctor,           20);   // 72/360
  });

  it("handles an empty bucket array gracefully (all zeros, no division by zero)", () => {
    const t = sumBuckets([]);
    assert.strictEqual(t.sent,         0);
    assert.strictEqual(t.deliveryRate, 0);
    assert.strictEqual(t.ctor,         0);
  });
});


// ===========================================================================
// formatJourneyResponse()
// ===========================================================================

describe("formatJourneyResponse()", () => {
  const dateRange = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" };

  it("includes the journey name in the response", () => {
    const result = {
      journeyId: "Welcome Series",
      channel: "email",
      groupBy: "day",
      buckets: [{ date: "2026-01-05", sent: 500, delivered: 450, bounced: 30, undelivered: 20, opens: 180, clicks: 45 }],
      sources: ["rest_fallback"],
    };
    const text = formatJourneyResponse(result, dateRange);
    assert.ok(text.includes("Welcome Series"), "Should include journey name");
  });

  it("includes sent, delivery rate, and bounce rate figures", () => {
    const result = {
      journeyId: "J1",
      channel: "email",
      groupBy: "day",
      buckets: [{ date: "2026-01-05", sent: 1000, delivered: 900, bounced: 80, undelivered: 20, opens: 360, clicks: 72 }],
      sources: ["rest_fallback"],
    };
    const text = formatJourneyResponse(result, dateRange);
    assert.ok(text.includes("1,000") || text.includes("1000"), "Should include sent count");
    assert.ok(text.includes("Delivered"), "Should include delivery label");
    assert.ok(text.includes("Bounced"),   "Should include bounce label");
  });

  it("omits opens/clicks for SMS channel", () => {
    const result = {
      journeyId: "SMS Journey",
      channel: "sms",
      groupBy: "day",
      buckets: [{ date: "2026-01-05", sent: 500, delivered: 450, bounced: 10, undelivered: 40, opens: 0, clicks: 0 }],
      sources: ["rest_fallback"],
    };
    const text = formatJourneyResponse(result, dateRange);
    assert.ok(!text.includes("Opens"), "Should not include Opens for SMS");
    assert.ok(!text.includes("Clicks"), "Should not include Clicks for SMS");
  });

  it("returns a 'no data' message when buckets is empty", () => {
    const result = { journeyId: "Empty Journey", channel: "all", groupBy: "day", buckets: [], sources: [] };
    const text = formatJourneyResponse(result, dateRange);
    assert.ok(text.includes("No data"), "Should indicate no data found");
    assert.ok(text.includes("Empty Journey"), "Should include journey name in no-data message");
  });

  it("includes the date range in the output", () => {
    const result = {
      journeyId: "J2",
      channel: "all",
      groupBy: "day",
      buckets: [{ date: "2026-01-05", sent: 100, delivered: 90, bounced: 5, undelivered: 5, opens: 20, clicks: 5 }],
      sources: ["rest_fallback"],
    };
    const text = formatJourneyResponse(result, dateRange);
    assert.ok(text.includes("2026-01-01"), "Should include start date");
    assert.ok(text.includes("2026-01-31"), "Should include end date");
  });
});


// ===========================================================================
// formatOverviewResponse()
// ===========================================================================

describe("formatOverviewResponse()", () => {
  const dateRange = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" };

  const journeys = [
    {
      id: "Welcome Series",
      name: "Welcome Series",
      channels: ["email"],
      buckets: [{ date: "2026-01-10", sent: 1000, delivered: 950, bounced: 30, undelivered: 20, opens: 380, clicks: 95 }],
    },
    {
      id: "Outage Alert",
      name: "Outage Alert",
      channels: ["sms", "email"],
      buckets: [{ date: "2026-01-12", sent: 2000, delivered: 1800, bounced: 100, undelivered: 100, opens: 0, clicks: 0 }],
    },
  ];

  it("returns a 'no data' message for an empty journey list", () => {
    const text = formatOverviewResponse([], dateRange);
    assert.ok(text.includes("No journey data"), "Should indicate no data found");
  });

  it("includes each journey name in the table", () => {
    const text = formatOverviewResponse(journeys, dateRange);
    assert.ok(text.includes("Welcome Series"), "Should include Welcome Series");
    assert.ok(text.includes("Outage Alert"),   "Should include Outage Alert");
  });

  it("includes markdown table header row", () => {
    const text = formatOverviewResponse(journeys, dateRange);
    assert.ok(text.includes("Journey"), "Should include Journey column header");
    assert.ok(text.includes("Delivery %"), "Should include Delivery % column header");
  });

  it("includes the date range header", () => {
    const text = formatOverviewResponse(journeys, dateRange);
    assert.ok(text.includes("2026-01-01"), "Should include start date");
    assert.ok(text.includes("2026-01-31"), "Should include end date");
  });

  it("sorts journeys by delivery rate descending (highest first)", () => {
    const text = formatOverviewResponse(journeys, dateRange);
    const welcomePos  = text.indexOf("Welcome Series");
    const outagePos   = text.indexOf("Outage Alert");
    // Welcome: 950/1000 = 95%. Outage: 1800/2000 = 90%. Welcome should appear first.
    assert.ok(welcomePos < outagePos, "Welcome Series (95% delivery) should appear before Outage Alert (90%)");
  });
});


// ===========================================================================
// buildJourneyHandoff()
// ===========================================================================

describe("buildJourneyHandoff()", () => {
  const result = {
    journeyId: "Welcome Series",
    channel:   "email",
    groupBy:   "day",
    buckets:   [],
    sources:   ["rest_fallback"],
  };
  const params = {
    dateRange:  { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" },
    drillLevel: "journey",
  };

  it("returns type='handoff_offer'", () => {
    const offer = buildJourneyHandoff(result, params, false);
    assert.strictEqual(offer.type, "handoff_offer");
  });

  it("sets confirmationRequired=true", () => {
    const offer = buildJourneyHandoff(result, params, false);
    assert.strictEqual(offer.confirmationRequired, true);
  });

  it("includes journey name in the message", () => {
    const offer = buildJourneyHandoff(result, params, false);
    assert.ok(offer.message.includes("Welcome Series"), "Handoff message should mention the journey name");
  });

  it("targetState includes journeyId, channel, and dateRange", () => {
    const offer = buildJourneyHandoff(result, params, false);
    assert.strictEqual(offer.targetState.journeyId, "Welcome Series");
    assert.strictEqual(offer.targetState.channel,   "email");
    assert.deepStrictEqual(offer.targetState.dateRange, params.dateRange);
  });

  it("appends drill-correction note to message when drillCorrected=true", () => {
    const offer = buildJourneyHandoff(result, params, true);
    assert.ok(offer.message.includes("journey-level"), "Should mention correction to journey-level");
  });

  it("sets drillLevel='journey' when drillCorrected=true", () => {
    const offer = buildJourneyHandoff(result, params, true);
    assert.strictEqual(offer.targetState.drillLevel, "journey");
  });
});


// ===========================================================================
// buildOverviewHandoff()
// ===========================================================================

describe("buildOverviewHandoff()", () => {
  it("returns type='handoff_offer' with drillLevel='overview'", () => {
    const offer = buildOverviewHandoff({ channel: "all", dateRange: { preset: "last_30d" } });
    assert.strictEqual(offer.type, "handoff_offer");
    assert.strictEqual(offer.targetState.drillLevel, "overview");
  });

  it("sets confirmationRequired=true", () => {
    const offer = buildOverviewHandoff({ channel: "email", dateRange: {} });
    assert.strictEqual(offer.confirmationRequired, true);
  });

  it("carries the channel from viewState into targetState", () => {
    const offer = buildOverviewHandoff({ channel: "sms", dateRange: {} });
    assert.strictEqual(offer.targetState.channel, "sms");
  });

  it("defaults channel to 'all' when viewState.channel is missing", () => {
    const offer = buildOverviewHandoff({});
    assert.strictEqual(offer.targetState.channel, "all");
  });
});


// ===========================================================================
// resolveRange()
// ===========================================================================

describe("resolveRange()", () => {
  it("uses intent.range when a preset key is provided", () => {
    const range = resolveRange({ range: "last_7d", dateRange: null }, {});
    const spanDays = (new Date(range.end) - new Date(range.start)) / 86400000;
    assert.ok(spanDays >= 6.9 && spanDays <= 7.1, `Expected ~7 days, got ${spanDays}`);
  });

  it("uses intent.dateRange when no preset range key is given", () => {
    const dr = { start: "2026-03-01T00:00:00.000Z", end: "2026-03-15T00:00:00.000Z" };
    const range = resolveRange({ range: null, dateRange: dr }, {});
    assert.deepStrictEqual(range, dr);
  });

  it("falls back to viewState.dateRange when intent has no range info", () => {
    const dr = { start: "2026-02-01T00:00:00.000Z", end: "2026-02-28T00:00:00.000Z" };
    const range = resolveRange({ range: null, dateRange: null }, { dateRange: dr });
    assert.deepStrictEqual(range, dr);
  });

  it("defaults to last 30 days when nothing is specified", () => {
    const range = resolveRange({ range: null, dateRange: null }, {});
    const spanDays = (new Date(range.end) - new Date(range.start)) / 86400000;
    assert.ok(spanDays >= 29.9 && spanDays <= 30.1, `Expected ~30 days, got ${spanDays}`);
  });
});


// ===========================================================================
// handleUserMessage() — integration tests with mock MCP tools
// ===========================================================================

describe("handleUserMessage() — integration", () => {
  // Minimal mock MCP tools that return a small synthetic DE response.
  // We inject one 'Delivered' row so normalizeRestRows produces a single bucket.
  function makeMockTools(rows = null) {
    const defaultRows = [
      { values: { SentDate: "1/10/2026 10:00:00 AM", MessageStatus: "Delivered", JourneyName: "Welcome Series", CommunicationType: "Email" } },
      { values: { SentDate: "1/10/2026 10:00:00 AM", MessageStatus: "Bounced",   JourneyName: "Welcome Series", CommunicationType: "Email" } },
    ];
    return {
      sfmc_query_data_extension_rows: async () => ({
        count: (rows ?? defaultRows).length,
        items: rows ?? defaultRows,
      }),
    };
  }

  it("returns a new sessionId when none is provided", async () => {
    const { sessionId } = await handleUserMessage(
      "How did Welcome Series perform last 30 days?",
      null,
      makeMockTools()
    );
    assert.ok(typeof sessionId === "string" && sessionId.length > 0);
  });

  it("echoes back the provided sessionId", async () => {
    const { sessionId } = await handleUserMessage(
      "How did Welcome Series perform last 30 days?",
      "my-session-id",
      makeMockTools()
    );
    assert.strictEqual(sessionId, "my-session-id");
  });

  it("returns a non-empty text string for a valid journey query", async () => {
    const { text } = await handleUserMessage(
      "How did Welcome Series perform last 30 days?",
      null,
      makeMockTools()
    );
    assert.ok(typeof text === "string" && text.length > 0);
  });

  it("includes journey name in response text for a journey query", async () => {
    const { text } = await handleUserMessage(
      `delivery stats for "Welcome Series" last 7 days`,
      null,
      makeMockTools()
    );
    assert.ok(text.includes("Welcome Series"), `Expected journey name in: ${text}`);
  });

  it("includes a handoff offer for a successful journey query", async () => {
    const { handoffOffer } = await handleUserMessage(
      "How did Welcome Series perform last 30 days?",
      null,
      makeMockTools()
    );
    assert.ok(handoffOffer !== null, "Expected a handoffOffer");
    assert.strictEqual(handoffOffer.type, "handoff_offer");
  });

  it("returns null handoffOffer when dashboardActive=true (silent commit)", async () => {
    const { handoffOffer } = await handleUserMessage(
      "How did Welcome Series perform last 30 days?",
      null,
      makeMockTools(),
      { dashboardActive: true }
    );
    assert.strictEqual(handoffOffer, null, "dashboardActive should suppress the handoff offer");
  });

  it("commits a pending handoff on confirm and returns null handoffOffer", async () => {
    const sid = `test-confirm-${Date.now()}`;
    // First call — create a pending handoff
    await handleUserMessage("How did Welcome Series perform last 30 days?", sid, makeMockTools());

    // Second call — confirm the handoff
    const { text, handoffOffer } = await handleUserMessage("yes", sid, makeMockTools(), { confirmHandoff: true });
    assert.ok(text.includes("dashboard"), "Confirmation text should mention the dashboard");
    assert.strictEqual(handoffOffer, null, "Confirmed handoff should return null offer");
    // Pending store should be cleared
    assert.strictEqual(PENDING_HANDOFFS.has(sid), false);
  });

  it("gracefully handles confirmHandoff=true with no pending handoff", async () => {
    const sid = `test-no-pending-${Date.now()}`;
    const { text } = await handleUserMessage("yes", sid, makeMockTools(), { confirmHandoff: true });
    assert.ok(text.includes("no pending"), "Should tell user there is nothing to confirm");
  });

  it("returns helpful text for an unknown/off-topic query", async () => {
    const { text } = await handleUserMessage("Hello!", null, makeMockTools());
    assert.ok(text.includes("deliverability") || text.includes("journey"), "Should suggest what the agent can do");
  });

  it("returns MISSING_JOURNEY guidance when no journey is resolvable", async () => {
    // Empty DE — no rows, no journeyId in message, no inherited state
    const { text } = await handleUserMessage(
      "show me bounce rate last 7 days",
      null,
      makeMockTools([])  // empty DE — journey can't be resolved from query or state
    );
    // parseIntent can't extract a journey name; should hit MISSING_JOURNEY path
    assert.ok(
      text.includes("journey") || text.includes("deliverability"),
      `Expected guidance text, got: ${text}`
    );
  });

  it("overview query returns a markdown table when DE has data", async () => {
    // Provide two journeys via the DE scan strategy
    const rows = [
      { values: { SentDate: "1/5/2026 9:00:00 AM", MessageStatus: "Delivered", JourneyName: "Journey A", CommunicationType: "Email" } },
      { values: { SentDate: "1/6/2026 9:00:00 AM", MessageStatus: "Bounced",   JourneyName: "Journey B", CommunicationType: "SMS"   } },
    ];
    const { text } = await handleUserMessage("show me all journeys last 30 days", null, makeMockTools(rows));
    // Should produce a markdown table or overview text
    assert.ok(
      text.includes("Journey A") || text.includes("overview") || text.includes("|"),
      `Expected overview table, got: ${text}`
    );
  });

  it("journey_query populates messages array in session detail for JourneyScreen table", async () => {
    const sid = `test-messages-${Date.now()}`;
    const rows = [
      { values: { SentDate: "1/10/2026 9:00:00 AM", MessageStatus: "Delivered", JourneyName: "Welcome Series", CommunicationType: "Email", MessageName: "Welcome Email" } },
      { values: { SentDate: "1/10/2026 9:00:00 AM", MessageStatus: "Bounced",   JourneyName: "Welcome Series", CommunicationType: "Email", MessageName: "Reminder Email" } },
    ];
    // Use a session at journey drillLevel so runQueryMessage is called
    const { getSessionState: _get, patchSessionState: _patch } = await import("./Headless_Reporting_Agent_Backend.js");
    await _patch(sid, { drillLevel: "journey" });

    await handleUserMessage(`delivery stats for "Welcome Series" last 30 days`, sid, makeMockTools(rows));

    const { detail } = await _get(sid);
    assert.ok(detail !== null, "detail should be set in session after journey query");
    assert.ok(Array.isArray(detail.messages), "detail.messages should be an array");
    assert.ok(detail.messages.length >= 1, "Should have at least one message entry");
    const names = detail.messages.map((m) => m.name);
    assert.ok(names.some((n) => n === "Welcome Email" || n === "Reminder Email"),
      `Expected known message names, got: ${JSON.stringify(names)}`);
  });

});
