/**
 * Deliverability Agent — Conversation Layer
 * ------------------------------------------
 * This is the "brain" that sits between the LLM/Bob context and the backend
 * library. It is responsible for:
 *
 *   1. Parsing a natural-language user message into a structured query intent.
 *   2. Resolving the intent against current session state (fills gaps).
 *   3. Dispatching to runQuery() or runQueryOverview() in the backend.
 *   4. Formatting the NormalizedResponse into a chat-readable answer.
 *   5. Proposing a dashboard handoff (spec Section 6) and waiting for
 *      confirmation before calling patchSessionState().
 *
 * Entry point: handleUserMessage(userMessage, sessionId, mcpTools)
 *
 * The agent never silently mutates session state — it always proposes first
 * and only commits on an explicit "yes" (or when the dashboard is already the
 * active surface and the update is in-context, per spec Section 6).
 *
 * --- HOW TO USE FROM A BOB TOOL / PROMPT ---
 *
 *   import { handleUserMessage } from './Headless_Reporting_Agent.js';
 *
 *   const { text, handoffOffer, sessionId } = await handleUserMessage(
 *     userMessage,      // string from the user
 *     currentSessionId, // string | null — null creates a new session
 *     {                 // MCP tools available in the agent context
 *       sfmc_query_data_extension_rows,
 *       sfmc_get_journeys,        // optional — used for overview journey list
 *     }
 *   );
 *
 *   // 1. Reply to user with `text`
 *   // 2. If `handoffOffer` is non-null, show it and await a second call with
 *   //    confirmHandoff: true to commit the state patch.
 *
 * To confirm a pending handoff:
 *
 *   const { text } = await handleUserMessage(
 *     "yes",
 *     sessionId,
 *     mcpTools,
 *     { confirmHandoff: true }
 *   );
 */

import {
  runQuery,
  runQueryMessage,
  runQueryOverview,
  getSessionState,
  patchSessionState,
  setSessionDetail,
  computeRates,
  QueryError,
  COMMS_DE_KEY,
} from "./Headless_Reporting_Agent_Backend.js";

// ---------------------------------------------------------------------------
// 1. INTENT PARSER
// Turns a natural-language message into a structured IntentResult.
// This does lightweight heuristic extraction — the LLM has already interpreted
// the user's intent before calling handleUserMessage, so we work with the
// text it produces or pass through as-is.
//
// The parser returns null on intents it cannot classify (greetings, off-topic
// questions, etc.) so the caller can fall through to a generic LLM response.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Intent
 * @property {"journey_query"|"overview_query"|"confirm_handoff"|"unknown"} type
 * @property {string|null}   journeyId    - JourneyName string, or null for overview
 * @property {string}        channel      - "email"|"sms"|"push"|"all"
 * @property {string|null}   range        - preset key from RELATIVE_RANGES, or null
 * @property {{start,end}|null} dateRange - explicit date range, or null
 * @property {string[]}      metrics      - e.g. ["bounced","delivered"], or [] for all
 * @property {boolean}       wantsOverview
 */

const CHANNEL_ALIASES = {
  email: "email", emails: "email", "e-mail": "email",
  sms:   "sms",   text:   "sms",   texts:    "sms", "text messages": "sms",
  push:  "push",  "push notifications": "push",
};

const RANGE_ALIASES = {
  today: "today",
  yesterday: "yesterday",
  "last week": "last_7d",  "past week": "last_7d",  "7 days": "last_7d",  "7d": "last_7d",
  "last 7 days": "last_7d", "past 7 days": "last_7d",
  "last 14 days": "last_14d", "past 14 days": "last_14d", "14 days": "last_14d",
  "last month": "last_30d", "past month": "last_30d",
  "last 30 days": "last_30d", "past 30 days": "last_30d", "30 days": "last_30d",
  "this month": "this_month",
};

const METRIC_ALIASES = {
  sent: "sent", sends: "sent",
  delivered: "delivered", delivery: "delivered", deliveries: "delivered",
  "delivery rate": "delivered",
  bounced: "bounced", bounces: "bounced", bounce: "bounced",
  "bounce rate": "bounced",
  undelivered: "undelivered", "undelivery rate": "undelivered",
  opened: "opens", opens: "opens", open: "opens", "open rate": "opens",
  clicked: "clicks", clicks: "clicks", click: "clicks", "click rate": "clicks",
  ctor: "clicks",
};

const OVERVIEW_SIGNALS = [
  /\ball journeys?\b/i,
  /\bcompare\b/i,
  /\bworst\b/i,
  /\bbest\b/i,
  /\bleaderboard\b/i,
  /\branking\b/i,
  /\boverview\b/i,
  /\bsummary\b/i,
  /which journey/i,
];

/**
 * Lightweight NL intent parser. Extracts channel, range, journey name, and
 * metric hints from free-form text using keyword matching.
 *
 * @param {string} text
 * @returns {Intent}
 */
function parseIntent(text) {
  const lower = text.toLowerCase();

  // Detect explicit confirmation of a pending handoff
  if (/^\s*(yes|yeah|sure|ok|okay|go ahead|show me|open it|confirm|do it)\s*[.!]?\s*$/i.test(text)) {
    return { type: "confirm_handoff", journeyId: null, channel: "all", range: null, dateRange: null, metrics: [], wantsOverview: false };
  }

  // Detect overview / multi-journey intent
  const wantsOverview = OVERVIEW_SIGNALS.some((re) => re.test(lower));

  // Extract channel
  let channel = "all";
  for (const [alias, mapped] of Object.entries(CHANNEL_ALIASES)) {
    if (lower.includes(alias)) { channel = mapped; break; }
  }

  // Extract date range
  let range = null;
  for (const [alias, key] of Object.entries(RANGE_ALIASES)) {
    if (lower.includes(alias)) { range = key; break; }
  }

  // Extract metric hints
  const metrics = [];
  for (const [alias, key] of Object.entries(METRIC_ALIASES)) {
    if (lower.includes(alias) && !metrics.includes(key)) metrics.push(key);
  }

  // Extract journey name — look for quoted names or "for <JourneyName>" / "<Name> journey"
  // This regex handles: 'Welcome Journey', "Welcome Journey", Welcome journey (title-case)
  let journeyId = null;
  const quotedMatch = text.match(/['"]([^'"]{3,80})['"]/);
  if (quotedMatch) {
    journeyId = quotedMatch[1];
  } else {
    const forMatch = text.match(/\bfor\s+((?:[A-Z][A-Za-z0-9_\- ]{2,60}?))\s*(?:journey|campaign|in|last|this|over|$)/i);
    if (forMatch) journeyId = forMatch[1].trim();

    const howMatch = text.match(/\bhow\s+(?:did|has|is)\s+((?:[A-Z][A-Za-z0-9_\- ]{2,60}?))\s+(?:perform|do)\b/i);
    if (!journeyId && howMatch) journeyId = howMatch[1].trim();

    const namedJourneyMatch = text.match(/((?:[A-Z][A-Za-z0-9_\- ]{2,60}?))\s+journey\b/i);
    if (!journeyId && namedJourneyMatch) journeyId = namedJourneyMatch[1].trim();
  }

  const type = wantsOverview ? "overview_query"
    : journeyId            ? "journey_query"
    : "unknown";

  return { type, journeyId, channel, range, dateRange: null, metrics, wantsOverview };
}


// ---------------------------------------------------------------------------
// 2. RESPONSE FORMATTER
// Turns a NormalizedResponse into readable chat text.
// ---------------------------------------------------------------------------

/**
 * Sums all buckets in a NormalizedResponse into a single totals object,
 * then applies computeRates() so all six rate fields are present.
 *
 * @param {import("./Headless_Reporting_Agent_Backend.js").MetricBucket[]} buckets
 * @returns {import("./Headless_Reporting_Agent_Backend.js").MetricBucket}
 */
function sumBuckets(buckets) {
  const totals = { date: "total", sent: 0, delivered: 0, bounced: 0, undelivered: 0, opens: 0, clicks: 0 };
  for (const b of buckets) {
    totals.sent        += b.sent;
    totals.delivered   += b.delivered;
    totals.bounced     += b.bounced;
    totals.undelivered += b.undelivered;
    totals.opens       += b.opens;
    totals.clicks      += b.clicks;
  }
  return computeRates(totals);
}

/**
 * Formats a single MetricBucket as a bullet-point string for chat display.
 *
 * @param {Object} t - totals from sumBuckets()
 * @param {string} channel
 * @returns {string}
 */
function formatTotals(t, channel) {
  const pct = (n) => `${n.toFixed(1)}%`;
  const num = (n) => n.toLocaleString("en-US");

  const lines = [
    `**Sent:** ${num(t.sent)}`,
    `**Delivered:** ${num(t.delivered)} (${pct(t.deliveryRate)})`,
    `**Bounced:** ${num(t.bounced)} (${pct(t.bounceRate)})`,
    `**Undelivered:** ${num(t.undelivered)} (${pct(t.undeliveredRate)})`,
  ];

  // Opens and clicks are relevant for email and push; less so for SMS
  if (channel !== "sms") {
    lines.push(`**Opens:** ${num(t.opens)} (${pct(t.openRate)} of delivered)`);
    lines.push(`**Clicks:** ${num(t.clicks)} (${pct(t.clickRate)} of delivered)`);
    if (t.opens > 0) {
      lines.push(`**Click-to-open rate:** ${pct(t.ctor)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Formats the chat response text for a single journey query.
 *
 * @param {import("./Headless_Reporting_Agent_Backend.js").NormalizedResponse} result
 * @param {{start:string,end:string}} dateRange
 * @returns {string}
 */
function formatJourneyResponse(result, dateRange) {
  if (!result.buckets.length) {
    return `No data found for **${result.journeyId}** in the requested date range.`;
  }

  const totals = sumBuckets(result.buckets);
  const fromDate = dateRange.start.slice(0, 10);
  const toDate   = dateRange.end.slice(0, 10);
  const channelLabel = result.channel === "all" ? "all channels" : result.channel.toUpperCase();

  return [
    `**${result.journeyId}** — ${channelLabel} · ${fromDate} to ${toDate}`,
    "",
    formatTotals(totals, result.channel),
  ].join("\n");
}

/**
 * Formats the chat response text for an overview (multi-journey) query.
 * Renders a summary table sorted by delivery rate descending.
 *
 * @param {import("./Headless_Reporting_Agent_Backend.js").JourneyEntry[]} journeys
 * @param {{start:string,end:string}} dateRange
 * @returns {string}
 */
function formatOverviewResponse(journeys, dateRange) {
  if (!journeys.length) {
    return "No journey data found for the requested date range.";
  }

  const fromDate = dateRange.start.slice(0, 10);
  const toDate   = dateRange.end.slice(0, 10);

  // Build summary rows: sum each journey's buckets, apply rates
  const rows = journeys.map((j) => {
    const t = sumBuckets(j.buckets);
    return { name: j.name, channels: j.channels.join("/"), ...t };
  });

  // Sort by delivery rate descending (best first)
  rows.sort((a, b) => b.deliveryRate - a.deliveryRate);

  const header = `**Journey delivery overview** — ${fromDate} to ${toDate}\n`;

  // Markdown table
  const tableHeader = "| Journey | Channels | Sent | Delivery % | Bounce % | Open % | Click % |";
  const tableSep    = "|---|---|---:|---:|---:|---:|---:|";
  const tableRows   = rows.map((r) =>
    `| ${r.name} | ${r.channels} | ${r.sent.toLocaleString("en-US")} | ${r.deliveryRate.toFixed(1)}% | ${r.bounceRate.toFixed(1)}% | ${r.openRate.toFixed(1)}% | ${r.clickRate.toFixed(1)}% |`
  );

  return [header, tableHeader, tableSep, ...tableRows].join("\n");
}


// ---------------------------------------------------------------------------
// 3. HANDOFF OFFER BUILDER
// Constructs the handoff_offer object from spec Section 6.
// The agent returns this to the caller without committing any state change —
// the caller shows it to the user and calls back with confirmHandoff: true.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HandoffOffer
 * @property {"handoff_offer"} type
 * @property {"user_confirmed"|"auto_suggested"} trigger
 * @property {string} message           - human-readable proposal
 * @property {Object} targetState       - partial viewState to patch on confirmation
 * @property {boolean} confirmationRequired
 */

/**
 * Builds a handoff offer for a journey-level result.
 *
 * @param {import("./Headless_Reporting_Agent_Backend.js").NormalizedResponse} result
 * @param {Object} params - parsed query params
 * @param {boolean} drillCorrected - true if drill level was auto-corrected
 * @returns {HandoffOffer}
 */
function buildJourneyHandoff(result, params, drillCorrected) {
  const channelLabel = result.channel === "all" ? "" : ` filtered to ${result.channel.toUpperCase()}`;
  const dateLabel = params.dateRange
    ? `${params.dateRange.start.slice(0, 10)} to ${params.dateRange.end.slice(0, 10)}`
    : "the current date range";

  let message = `Want to see this in the dashboard? I can pull up **${result.journeyId}**${channelLabel}, ${dateLabel}.`;
  if (drillCorrected) {
    message += ` That's a wide date range, so I'll show journey-level trends rather than individual sends.`;
  }

  return {
    type: "handoff_offer",
    trigger: "auto_suggested",
    message,
    targetState: {
      journeyId:  result.journeyId,
      channel:    result.channel,
      dateRange:  params.dateRange,
      drillLevel: drillCorrected ? "journey" : params.drillLevel ?? "journey",
    },
    confirmationRequired: true,
  };
}

/**
 * Builds a handoff offer for an overview result.
 *
 * @param {Object} viewState - current session viewState
 * @returns {HandoffOffer}
 */
function buildOverviewHandoff(viewState) {
  return {
    type: "handoff_offer",
    trigger: "auto_suggested",
    message: `Want to see this in the dashboard? I can open the deliverability overview for all journeys.`,
    targetState: {
      journeyId:  null,
      channel:    viewState.channel ?? "all",
      dateRange:  viewState.dateRange,
      drillLevel: "overview",
    },
    confirmationRequired: true,
  };
}


// ---------------------------------------------------------------------------
// 4. PENDING HANDOFF STORE
// Holds the most recent unconfirmed handoff per session so confirmHandoff:true
// can commit it without the user re-stating their intent.
// In-memory — acceptable for a prototype (matches SESSION_STORE approach).
// ---------------------------------------------------------------------------

/** @type {Map<string, HandoffOffer>} sessionId → pending HandoffOffer */
const PENDING_HANDOFFS = new Map();


// ---------------------------------------------------------------------------
// 5. MAIN ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AgentResponse
 * @property {string}           text          - message to display in chat
 * @property {HandoffOffer|null} handoffOffer  - non-null when a handoff is being proposed
 * @property {string}           sessionId     - session ID (pass back on next call)
 */

/**
 * Handles a single user message in the deliverability agent conversation.
 *
 * @param {string}  userMessage         - raw text from the user
 * @param {string|null} sessionId       - existing session ID, or null to create a new one
 * @param {Object}  mcpTools            - MCP callables: { sfmc_query_data_extension_rows, sfmc_get_journeys? }
 * @param {Object}  [options]
 * @param {boolean} [options.confirmHandoff=false]  - true when the user just confirmed a pending handoff
 * @param {boolean} [options.dashboardActive=false] - true when the dashboard is the active surface;
 *                                                    skips confirmation for in-context updates (spec §6)
 * @returns {Promise<AgentResponse>}
 */
export async function handleUserMessage(
  userMessage,
  sessionId,
  mcpTools,
  { confirmHandoff = false, dashboardActive = false } = {}
) {
  // Assign or mint a session ID
  const sid = sessionId ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ── A. Confirm a pending handoff ──────────────────────────────────────────
  if (confirmHandoff || parseIntent(userMessage).type === "confirm_handoff") {
    const pending = PENDING_HANDOFFS.get(sid);
    if (!pending) {
      return {
        text: "There's no pending dashboard handoff to confirm. Ask me for some metrics first.",
        handoffOffer: null,
        sessionId: sid,
      };
    }
    PENDING_HANDOFFS.delete(sid);
    await patchSessionState(sid, pending.targetState, "agent");
    return {
      text: "Done — the dashboard has been updated. You can now explore the data visually.",
      handoffOffer: null,
      sessionId: sid,
    };
  }

  // ── B. Parse intent and load current session state ────────────────────────
  const intent = parseIntent(userMessage);
  const { viewState } = await getSessionState(sid);

  // ── C. Unknown / off-topic intent ─────────────────────────────────────────
  if (intent.type === "unknown") {
    return {
      text: [
        "I can help you query deliverability metrics for your SFMC journeys.",
        "Try asking something like:",
        '- "How did the Welcome Journey perform last 30 days?"',
        '- "SMS bounce rate for Outage Alert last week"',
        '- "Compare all journeys this month"',
      ].join("\n"),
      handoffOffer: null,
      sessionId: sid,
    };
  }

  // ── D. Overview query — all known journeys ────────────────────────────────
  if (intent.type === "overview_query") {
    try {
      // Resolve the list of journeys to query.
      // Prefer the caller supplying a channelMap; otherwise attempt to fetch
      // from Journey Builder if sfmc_get_journeys is available in mcpTools.
      const journeyNames = await resolveJourneyNames(viewState, mcpTools);

      if (!journeyNames.length) {
        return {
          text: "I couldn't find any journeys to summarise. Pass a list of journey names or make sure the SFMC Journey Builder connection is active.",
          handoffOffer: null,
          sessionId: sid,
        };
      }

      const overviewDateRange = resolveRange(intent, viewState);
      // Patch the session with the new date range before querying so
      // runQueryOverview picks up the right window from viewState.
      await patchSessionState(sid, { channel: intent.channel, dateRange: overviewDateRange }, "agent");

      const journeys = await runQueryOverview(sid, journeyNames, mcpTools);

      const text = formatOverviewResponse(journeys, overviewDateRange);
      const handoffOffer = buildOverviewHandoff({ ...viewState, channel: intent.channel, dateRange: overviewDateRange });

      // If dashboard is already active, skip confirmation and patch immediately
      if (dashboardActive) {
        PENDING_HANDOFFS.delete(sid);
        await patchSessionState(sid, { ...handoffOffer.targetState }, "agent");
        return { text, handoffOffer: null, sessionId: sid };
      }

      PENDING_HANDOFFS.set(sid, handoffOffer);
      return { text, handoffOffer, sessionId: sid };

    } catch (err) {
      return formatError(err, sid);
    }
  }

  // ── E. Single-journey query ───────────────────────────────────────────────
  if (intent.type === "journey_query") {
    try {
      const rawQuery = {
        journeyId: intent.journeyId,
        channel:   intent.channel,
        range:     intent.range ?? undefined,
        metrics:   intent.metrics.length ? intent.metrics : undefined,
      };

      // Use runQueryMessage for journey/message drill levels so the JourneyScreen
      // table gets a populated `messages` array. For overview-level queries, the
      // lighter runQuery (no per-message grouping) is sufficient.
      const isJourneyDrill = !viewState.drillLevel || viewState.drillLevel !== "overview";
      const result = isJourneyDrill
        ? await runQueryMessage(rawQuery, viewState, mcpTools)
        : await runQuery(rawQuery, viewState, mcpTools);

      // Detect if drill-level was auto-corrected (span > 30 days at message level)
      const spanDays = (new Date(result.buckets.at(-1)?.date ?? viewState.dateRange?.end)
        - new Date(result.buckets[0]?.date ?? viewState.dateRange?.start)) / 86400000;
      const drillCorrected = viewState.drillLevel === "message" && spanDays > 30;

      // Store detail in session for the dashboard to render
      await setSessionDetail(sid, result);

      const resolvedParams = {
        dateRange: resolveRange(intent, viewState),
        drillLevel: drillCorrected ? "journey" : (viewState.drillLevel ?? "journey"),
      };

      const text = formatJourneyResponse(result, resolvedParams.dateRange);
      const handoffOffer = buildJourneyHandoff(result, resolvedParams, drillCorrected);

      // If dashboard is already active, commit without confirmation
      if (dashboardActive) {
        PENDING_HANDOFFS.delete(sid);
        await patchSessionState(sid, { ...handoffOffer.targetState }, "agent");
        return { text, handoffOffer: null, sessionId: sid };
      }

      PENDING_HANDOFFS.set(sid, handoffOffer);
      return { text, handoffOffer, sessionId: sid };

    } catch (err) {
      return formatError(err, sid);
    }
  }

  // Should not reach here
  return { text: "Unexpected agent state — please try again.", handoffOffer: null, sessionId: sid };
}


// ---------------------------------------------------------------------------
// 6. HELPERS
// ---------------------------------------------------------------------------

/**
 * Resolves the effective date range from an intent + inherited viewState.
 * Returns a {start, end} ISO object.
 */
function resolveRange(intent, viewState) {
  const RELATIVE_RANGES = {
    today:      () => daysAgo(1),
    yesterday:  () => ({ start: daysAgo(2).start, end: daysAgo(1).start }),
    last_7d:    () => daysAgo(7),
    last_14d:   () => daysAgo(14),
    last_30d:   () => daysAgo(30),
    this_month: () => monthToDate(),
  };

  if (intent.range && RELATIVE_RANGES[intent.range]) return RELATIVE_RANGES[intent.range]();
  if (intent.dateRange?.start) return intent.dateRange;
  if (viewState.dateRange?.start) return viewState.dateRange;
  return daysAgo(30);
}

function daysAgo(n) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - n);
  return { start: start.toISOString(), end: end.toISOString() };
}

function monthToDate() {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Resolves the list of journey names to use for an overview query.
 *
 * Three strategies tried in order — first non-empty result wins:
 *
 *   1. Journey Builder API (sfmc_get_journeys) — authoritative source of published
 *      journey names. Requires the MCP connection to be active. Because JourneyName
 *      in the Comm_Log DE is confirmed to match Journey Builder names exactly, the
 *      names returned here can be used directly as DE filter values.
 *
 *   2. Comm_Log DE distinct scan — fetches JourneyName-only rows over the last 90
 *      days and deduplicates client-side. Works without a Journey Builder connection
 *      and only returns journeys that have actual data in the DE (no phantom entries).
 *      Uses a single page of 2500 rows; if the DE has more than 2500 distinct
 *      journeys in 90 days that is unexpected and the caller will get a partial list.
 *
 *   3. Session store — whatever was last written by a previous runQueryOverview()
 *      call. Stale but better than nothing for a re-query in the same session.
 *
 * Returns string[] of JourneyName values (matching the DE's JourneyName column).
 *
 * @param {Object} viewState
 * @param {Object} mcpTools  - must include sfmc_query_data_extension_rows;
 *                             sfmc_get_journeys is optional
 * @returns {Promise<string[]>}
 */
async function resolveJourneyNames(viewState, mcpTools) {
  // ── Strategy 1: Journey Builder API ────────────────────────────────────────
  if (typeof mcpTools.sfmc_get_journeys === "function") {
    try {
      const response = await mcpTools.sfmc_get_journeys({
        status: "Published",
        mostRecentVersionOnly: true,
        page_size: 50,
      });
      // sfmc_get_journeys returns { items: [{ name, key, ... }] }
      const items = response?.items ?? [];
      const names = items.map((j) => j.name).filter(Boolean);
      if (names.length) return names;
    } catch {
      // MCP unavailable — fall through to DE scan
    }
  }

  // ── Strategy 2: Comm_Log DE distinct JourneyName scan ──────────────────────
  // Fetches only the JourneyName field over the last 90 days and deduplicates.
  // 90 days is wide enough to catch journeys that run infrequently, and narrow
  // enough to keep the query cheap relative to the full DE history.
  if (typeof mcpTools.sfmc_query_data_extension_rows === "function") {
    try {
      const window90 = (() => {
        const end   = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 90);
        return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
      })();

      const response = await mcpTools.sfmc_query_data_extension_rows({
        key:       COMMS_DE_KEY,
        filter:    `SentDate gte '${window90.start}' and SentDate lte '${window90.end}'`,
        fields:    "JourneyName",
        page:      1,
        page_size: 2500,
      });

      const rows = (response.items ?? []).map((item) => item.values ?? item);
      const names = [...new Set(
        rows.map((r) => r.JourneyName).filter(Boolean)
      )].sort();

      if (names.length) return names;
    } catch {
      // DE query failed — fall through to session store
    }
  }

  // ── Strategy 3: Session store ───────────────────────────────────────────────
  // Stale but available immediately without any network call.
  try {
    const { journeys = [] } = await getSessionState(viewState.sessionId ?? "");
    return journeys.map((j) => j.name).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Formats an error (QueryError or unexpected) into an AgentResponse.
 *
 * @param {Error} err
 * @param {string} sid
 * @returns {AgentResponse}
 */
function formatError(err, sid) {
  if (err?.code === "MISSING_JOURNEY") {
    return {
      text: "Which journey would you like to look at? Please include the journey name in your question.",
      handoffOffer: null,
      sessionId: sid,
    };
  }
  // Generic fallback — never expose internal stack traces to the user (security rule §10)
  console.error("[DeliverabilityAgent] Unexpected error:", err);
  return {
    text: "Something went wrong fetching the data. Please try again.",
    handoffOffer: null,
    sessionId: sid,
  };
}


// ---------------------------------------------------------------------------
// 7. NAMED EXPORTS
// ---------------------------------------------------------------------------

export {
  parseIntent,
  sumBuckets,
  formatJourneyResponse,
  formatOverviewResponse,
  buildJourneyHandoff,
  buildOverviewHandoff,
  resolveRange,
  PENDING_HANDOFFS,    // exported for testing only
};
