/**
 * Deliverability Agent — Backend Layer
 * ------------------------------------
 * This is the bridge between SFMC (via MCP + REST fallback) and the two
 * consumer surfaces (chat agent, dashboard). Deploy as a serverless function
 * (Vercel/Netlify/Cloudflare Workers) or a small Node/Express service.
 *
 * Three parts:
 *   1. Query parser      — turns a natural-language-ish request into structured params
 *   2. Capability router — decides MCP vs REST fallback per metric/channel
 *   3. Normalizer        — maps raw SFMC responses into one canonical schema
 *
 * Nothing here calls real SFMC endpoints yet — the MCP/REST client functions
 * are stubbed with clear TODOs for where your actual credentials/calls go.
 *
 * --- DE SCHEMA NOTES (Comm_Log_Schema.csv) ---
 * The source DE is a raw event log — one row per communication event.
 * Metrics are derived by counting rows grouped by MessageStatus value.
 *
 * Confirmed field names:
 *   SubscriberKey, JobID, BatchID, Email, Mobile, CommunicationType,
 *   MessageName, MessageStatus, AffectedCustomerId, IncidentId, NMI,
 *   MarketIdentifier, LifeSupportCustomer, SentDate, ModifiedDate,
 *   JourneyName, JourneyVersion, TriggeredSendID, IncidentType,
 *   MessageText, CommunicationCategory, smsUndeliveredStatus,
 *   smsUndeliveredReason, MailingStreet, ApplicationId, MailingCity,
 *   MailingState, MailingPostcode, Addressee, RpTrackingNumber,
 *   MailingAddress, CaseId, ProjectId, view_email_url
 *
 * Key derivation rules:
 *   - Channel filter : CommunicationType  (e.g. "Email", "SMS")
 *   - Journey filter : JourneyName        (string, not a GUID)
 *   - Date filter    : SentDate           (SFMC Date — REST returns "M/D/YYYY h:mm:ss AM/PM")
 *   - sent           : COUNT(*) where MessageStatus IN MESSAGE_STATUS.SENT
 *   - delivered      : COUNT(*) where MessageStatus IN MESSAGE_STATUS.DELIVERED
 *   - bounced        : COUNT(*) where MessageStatus IN MESSAGE_STATUS.BOUNCED
 *   - undelivered         : COUNT(*) where MessageStatus IN MESSAGE_STATUS.UNDELIVERED
 *   - opens          : COUNT(*) where MessageStatus IN MESSAGE_STATUS.OPENS
 *   - clicks         : COUNT(*) where MessageStatus IN MESSAGE_STATUS.CLICKS
 *
 * Note: all six metric categories live in the same MessageStatus column —
 * opens and clicks are status values, not separate tracking columns.
 */

// ---------------------------------------------------------------------------
// 1. CANONICAL SCHEMA
// Every response — from MCP, from REST, for chat, for dashboard — ends up here.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MetricBucket
 * @property {string} date           - ISO date (day-level) or ISO datetime (hour-level)
 * @property {number} sent
 * @property {number} delivered
 * @property {number} bounced
 * @property {number} undelivered
 * @property {number} opens
 * @property {number} clicks
 * // Derived rates — added by computeRates(); not present on raw buckets from normalizeRestRows()
 * @property {number} [deliveryRate]    - delivered / sent           (0–100)
 * @property {number} [bounceRate]      - bounced / sent             (0–100)
 * @property {number} [undeliveredRate] - undelivered / sent         (0–100)
 * @property {number} [openRate]        - opens / delivered          (0–100)
 * @property {number} [clickRate]       - clicks / delivered         (0–100)
 * @property {number} [ctor]            - clicks / opens (click-to-open rate) (0–100)
 */

/**
 * @typedef {Object} NormalizedResponse
 * @property {string} journeyId
 * @property {string} channel        - "email" | "sms" | "push"
 * @property {string} groupBy        - "day" | "hour"
 * @property {MetricBucket[]} buckets
 * @property {string[]} sources      - which backends were used, e.g. ["mcp"] or ["mcp","rest_fallback"]
 */

/**
 * @typedef {Object} JourneyEntry
 * Overview-level summary for one journey, stored in SESSION_STORE.journeys[].
 * @property {string}           id        - JourneyName value from the DE (used as identifier)
 * @property {string}           name      - display name (same as id for now)
 * @property {string[]}         channels  - unique CommunicationType values seen for this journey
 * @property {MetricBucket[]}   buckets   - daily buckets across all channels (for sparklines + sorting)
 */

/**
 * @typedef {Object} SessionData
 * Full object stored per session in SESSION_STORE.
 * @property {Object}         viewState  - canonical viewState from spec Section 5.1
 * @property {JourneyEntry[]} journeys   - populated by runQueryOverview(); [] until first agent query
 * @property {Object|null}    detail     - last NormalizedResponse from a journey/message drill query
 */


// ---------------------------------------------------------------------------
// 2. CAPABILITY MAP
// Single source of truth for "which backend serves this metric/channel".
// Extend this as you confirm what MCP actually supports in your org.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MessageStatus value sets — confirmed permutations from the Comm_Log DE.
// Each metric is derived by counting rows whose MessageStatus falls in the
// corresponding set. Add/remove values here as you confirm them from real data.
// ---------------------------------------------------------------------------

const MESSAGE_STATUS = {
  // All six confirmed MessageStatus values in the Comm_Log DE.
  // SENT is the superset — every row counts as a send regardless of outcome.
  SENT:        ["Sent", "Delivered", "Opened", "Clicked", "Bounced", "Undelivered"],
  DELIVERED:   ["Delivered", "Opened", "Clicked"],
  BOUNCED:     ["Bounced"],
  UNDELIVERED: ["Undelivered"],
  OPENS:       ["Opened"],
  CLICKS:      ["Clicked"],
};

// ---------------------------------------------------------------------------
// All metrics now route to rest_fallback (the Comm_Log DE) because:
//   - Email: opens/clicks ARE in the DE via MessageStatus, so DE is authoritative
//     for all six metrics and avoids a split query.
//   - SMS:   MCP never supported SMS delivery data.
//   - Push:  routed to DE for consistency; update to "mcp" if MCP push data
//             proves more complete for your org.
// ---------------------------------------------------------------------------

const CAPABILITY_MAP = {
  email: {
    sent: "rest_fallback", delivered: "rest_fallback", bounced: "rest_fallback",
    opens: "rest_fallback", clicks: "rest_fallback", undelivered: "rest_fallback",
  },
  sms: {
    sent: "rest_fallback", delivered: "rest_fallback", bounced: "rest_fallback",
    opens: "rest_fallback", clicks: "rest_fallback", undelivered: "rest_fallback",
  },
  push: {
    sent: "rest_fallback", delivered: "rest_fallback", bounced: "rest_fallback",
    opens: "rest_fallback", clicks: "rest_fallback", undelivered: "rest_fallback",
  },
};

function resolveSource(channel, metric) {
  return CAPABILITY_MAP[channel]?.[metric] ?? "rest_fallback";
}

/** Groups requested metrics by which backend needs to serve them. */
function planQuery(channel, metrics) {
  const plan = { mcp: [], rest_fallback: [] };
  for (const metric of metrics) {
    plan[resolveSource(channel, metric)].push(metric);
  }
  return plan;
}


// ---------------------------------------------------------------------------
// 3. QUERY PARSER
// Turns a structured (or loosely structured) request from the agent into
// the params the rest of this pipeline needs. The actual NL parsing (turning
// "SMS bounce rate for Welcome last week" into this object) happens upstream,
// in the conversational agent itself — this function is what the agent's
// output should conform to before hitting the API.
// ---------------------------------------------------------------------------

const DEFAULT_METRICS = ["sent", "delivered", "bounced", "undelivered", "opens", "clicks"];
const RELATIVE_RANGES = {
  today: () => daysAgo(1),
  yesterday: () => ({ start: daysAgo(2).start, end: daysAgo(1).start }),
  last_7d: () => daysAgo(7),
  last_14d: () => daysAgo(14),
  last_30d: () => daysAgo(30),
  this_month: () => monthToDate(),
};

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
 * @param {Object} raw - structured request, e.g.
 *   { journeyId: "jrny_4471", channel: "sms", metrics: ["bounced"], range: "last_30d" }
 * @param {Object} inheritedState - current dashboard viewState, used to fill gaps
 *   (see Section 5 of the spec — agent reads this before parsing so it doesn't
 *   need the user to restate journey/channel/date range every turn)
 */
function parseQuery(raw, inheritedState = {}) {
  const journeyId = raw.journeyId ?? inheritedState.journeyId;
  if (!journeyId) {
    throw new QueryError("MISSING_JOURNEY", "No journey specified and none active in current view state.");
  }

  const channel = raw.channel ?? inheritedState.channel ?? "all";
  const metrics = raw.metrics?.length ? raw.metrics : DEFAULT_METRICS;

  let dateRange;
  if (raw.range && RELATIVE_RANGES[raw.range]) {
    dateRange = RELATIVE_RANGES[raw.range]();
  } else if (raw.dateRange?.start || raw.dateRange?.end) {
    // Partial ranges are valid: one null bound means open-ended on that side.
    // Plain date strings (YYYY-MM-DD, length 10) are expanded to full timestamps
    // so that server-side and in-memory date filters both behave correctly.
    // Without this, a single-day query where start === end === "2026-08-25" sends
    // sentdate lte '2026-08-25' to the DE endpoint, which excludes every row on
    // that day because their timestamps are after midnight on that date.
    const expandStart = (s) => (s && s.length === 10 ? s + "T00:00:00" : s);
    const expandEnd   = (s) => (s && s.length === 10 ? s + "T23:59:59" : s);
    dateRange = {
      start: expandStart(raw.dateRange.start),
      end:   expandEnd(raw.dateRange.end),
    };
  } else if (raw.dateRange === null) {
    // Explicit null = all-time, no bounds.
    dateRange = null;
  } else if (inheritedState.dateRange?.start || inheritedState.dateRange?.end) {
    dateRange = inheritedState.dateRange;
  } else {
    // No range specified anywhere — default to all-time (no filtering).
    dateRange = null;
  }

  // Drill-level mismatch guard (Section 5.5 of the spec).
  // When dateRange is null (all-time), treat as a wide span → day grouping.
  const spanDays = dateRange?.start && dateRange?.end
    ? (new Date(dateRange.end) - new Date(dateRange.start)) / 86400000
    : Infinity;
  const groupBy = spanDays > 3 ? "day" : "hour";
  let drillLevel = inheritedState.drillLevel ?? "journey";
  if (drillLevel === "message" && spanDays > 30) {
    drillLevel = "journey"; // too coarse for message-level hourly view
  }

  return { journeyId, channel, metrics, dateRange, groupBy, drillLevel };
}

class QueryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}


// ---------------------------------------------------------------------------
// 4. SOURCE CLIENTS
// ---------------------------------------------------------------------------

// External key of the Comm_Log Data Extension.
// Set this to the CustomerKey shown in SFMC for the Comm_Log DE.
const COMMS_DE_KEY = process.env.COMMS_DE_KEY ?? "69C7427F-DC32-4114-ADB3-5D73DE282B8B";

// Maximum rows to fetch per page. SFMC caps at 2500 for this endpoint.
const DE_PAGE_SIZE = 2500;

// Exact CommunicationType values stored in the Comm_Log DE.
// "email" → "Email", "sms" → "SMS", "push" → "Push"
const CHANNEL_DE_VALUE = { email: "Email", sms: "SMS", push: "Push" };

/**
 * Strips a trailing _Email / _SMS / _Push suffix (case-insensitive) from a
 * MessageName to derive the journey display stem.
 * e.g. "UOM_ETA_Lapsed_SMS" → "UOM_ETA_Lapsed"
 *      "Welcome_Series_Email" → "Welcome_Series"
 *      "Planned_Outage"       → "Planned_Outage"  (no suffix — returned as-is)
 */
function messageNameStem(name) {
  return (name ?? "").replace(/[_ ](email|sms|push)$/i, "").trim() || (name ?? "");
}

/**
 * Builds the filter string for sfmc_query_data_extension_rows / the SFMC
 * /data/v1/customobjectdata rowset endpoint.
 *
 * NOTE: The rowset endpoint silently ignores sentdate filters (the column is
 * a Date type and gt/lt comparisons against ISO strings are not applied).
 * Date range filtering is therefore done in-memory in normalizeRestRows().
 *
 * Rows are grouped by MessageName stem (not JourneyName) because SMS rows
 * do not populate JourneyName in this DE.
 *
 * @param {string} stem     - normalised MessageName stem (from messageNameStem())
 * @param {string} channel  - "email" | "sms" | "push" | "all"
 * @param {{start: string, end: string}|null} dateRange - ISO8601 boundary strings; pushed to SFMC filter when present
 */
function buildDeFilter(stem, channel, dateRange) {
  // Match all MessageName values whose stem equals this journey stem.
  // We can't do a server-side stem computation, so we match both known suffixed
  // variants and the bare stem name, joined with OR.
  const suffixes = ["_Email", "_SMS", "_Push", " Email", " SMS", " Push", ""];
  const nameClauses = suffixes.map((s) => `messagename eq '${stem}${s}'`);
  const parts = [`(${nameClauses.join(" or ")})`];

  if (channel !== "all") {
    const channelValue = CHANNEL_DE_VALUE[channel] ?? (channel.charAt(0).toUpperCase() + channel.slice(1));
    parts.push(`communicationtype eq '${channelValue}'`);
  }

  // Push date bounds to the server so SFMC pages only the relevant rows.
  // normalizeRestRows also applies these bounds in-memory as a safety net.
  //
  // Send the full timestamp rather than slicing to date-only. Sending only
  // "YYYY-MM-DD" causes SFMC to treat the bound as midnight on that day, which
  // excludes every row timestamped after 00:00 — making single-day queries
  // return zero results. Full timestamps (e.g. "2026-08-25T23:59:59") ensure
  // the entire day is included.
  //
  // parseQuery expands plain date strings to T00:00:00 / T23:59:59 before
  // they reach here, so dateRange.start and dateRange.end always carry a time
  // component when coming from an explicit dateRange in the request body.
  // For relative ranges (last_7d etc.) daysAgo() already produces full ISO
  // strings, so no special handling is needed there either.
  if (dateRange?.start) {
    parts.push(`sentdate gte '${dateRange.start}'`);
  }
  if (dateRange?.end) {
    parts.push(`sentdate lte '${dateRange.end}'`);
  }

  return parts.join(" and ");
}

/**
 * Fetches all matching rows from the Comm_Log DE via the MCP
 * sfmc_query_data_extension_rows tool, paging through the full result set.
 *
 * The backend runs inside the Bob agent context, so MCP tools are available
 * as injected async functions. sfmc_query_data_extension_rows is passed in
 * via the `mcpTools` argument so this module stays testable without a live
 * MCP connection.
 *
 * @param {Object} params         - parsed query params from parseQuery()
 * @param {Object} mcpTools       - MCP tool callables, e.g. { sfmc_query_data_extension_rows }
 * @returns {Promise<Object[]>}   - raw DE row objects (values keyed by DE field name)
 */
async function fetchFromRestFallback(params, mcpTools) {
  const { journeyId: stem, channel, dateRange, fieldsOverride } = params;
  const { sfmc_query_data_extension_rows } = mcpTools;

  const filter = buildDeFilter(stem, channel, dateRange);

  // Only fetch the fields the normalizer actually reads — reduces payload size.
  // MessageName replaces JourneyName as the grouping key (SMS rows don't populate JourneyName).
  // Callers may pass fieldsOverride to request a different column set (e.g. channel discovery).
  const fields = fieldsOverride ?? "MessageName,CommunicationType,MessageStatus,SentDate";

  const allRows = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await sfmc_query_data_extension_rows({
      key:       COMMS_DE_KEY,
      filter,
      fields,
      page,
      page_size: DE_PAGE_SIZE,
    });

    // sfmc_query_data_extension_rows returns { count, page, pageSize, items, links }
    // Each item has { keys: {}, values: { FieldName: value, ... } }
    const rows = (response.items ?? []).map(item => item.values ?? item);
    allRows.push(...rows);

    // Continue paging if we received a full page
    hasMore = rows.length === DE_PAGE_SIZE;
    page += 1;
  }

  return allRows;
}

/**
 * MCP client — retained for forward-compatibility.
 * Not called under the current routing plan (all metrics route to fetchFromRestFallback).
 */
async function fetchFromMCP({ journeyId, channel, metrics, dateRange, groupBy }) {
  throw new Error("fetchFromMCP not yet implemented — wire up MCP tool call here if needed");
}


// ---------------------------------------------------------------------------
// 5. NORMALIZER
// The Comm_Log DE is a raw event log — one row per communication event.
// The REST fallback fetches all rows matching the query filters, then this
// normalizer groups them by date bucket and derives metric counts from
// MessageStatus values.
// ---------------------------------------------------------------------------

/**
 * Parses an SFMC Date field as returned by the REST API.
 * SFMC REST returns Date columns as "M/D/YYYY h:mm:ss AM/PM" (US locale).
 * Example: "3/24/2025 11:45:00 AM"
 *
 * We extract the date portion only (for day-level grouping) or the full
 * datetime (for hour-level grouping). Uses explicit string parsing — never
 * relies on Date() to guess the format, which was the confirmed bug.
 *
 * @param {string} raw  - raw SFMC date string
 * @param {"day"|"hour"} groupBy
 * @returns {string} ISO key suitable for use as a bucket key
 */
function parseSfmcDate(raw, groupBy = "day") {
  if (!raw) return null;

  // Format 1 (Email rows): "M/D/YYYY h:mm:ss AM/PM"  e.g. "3/24/2025 11:45:00 AM"
  const matchUs = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i
  );
  if (matchUs) {
    let [, month, day, year, hour, , , ampm] = matchUs;
    hour = parseInt(hour, 10);
    if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
    if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const hh = String(hour).padStart(2, "0");
    return groupBy === "day" ? `${year}-${mm}-${dd}` : `${year}-${mm}-${dd}T${hh}`;
  }

  // Format 2 (SMS rows): "DD/MM/YYYY, h:mm am/pm"  e.g. "22/08/2026, 5:03 am"
  const matchAu = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i
  );
  if (matchAu) {
    let [, day, month, year, hour, , ampm] = matchAu;
    hour = parseInt(hour, 10);
    if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
    if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const hh = String(hour).padStart(2, "0");
    return groupBy === "day" ? `${year}-${mm}-${dd}` : `${year}-${mm}-${dd}T${hh}`;
  }

  // Fallback: already ISO (e.g. from a future API version)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return groupBy === "day" ? raw.slice(0, 10) : raw.slice(0, 13);

  return null;
}

/**
 * Checks whether a MessageStatus value belongs to a given metric set.
 */
function statusIn(status, set) {
  return set.includes(status);
}

/**
 * Groups raw Comm_Log DE rows into MetricBuckets.
 * Each row contributes a count of 1 to whichever MessageStatus categories it matches.
 *
 * @param {Object[]} rows          - raw rows from the Comm_Log DE (REST response items)
 * @param {"day"|"hour"} groupBy
 * @param {Object} [dateRange]     - optional { start, end } ISO8601 strings for in-memory
 *                                   date filtering (the DE endpoint ignores sentdate filters)
 * @returns {MetricBucket[]}
 */
function normalizeRestRows(rows, groupBy = "day", dateRange = null) {
  const map = new Map();

  // Pre-compute boundary ISO date strings for in-memory date range filtering.
  // The rowset endpoint ignores sentdate filters, so we apply the range here.
  // dateKey from parseSfmcDate is "YYYY-MM-DD" (day) or "YYYY-MM-DDTHH" (hour).
  // Slice the ISO boundary strings to the same length for string comparison.
  // When groupBy==="hour" and the boundary is a plain date ("YYYY-MM-DD", length 10),
  // pad endKey to "YYYY-MM-DDT23" so all hours of the last day pass the filter.
  const keyLen   = groupBy === "hour" ? 13 : 10;
  const startKey = dateRange ? dateRange.start.slice(0, keyLen) : null;
  const endKeyRaw = dateRange ? dateRange.end.slice(0, keyLen) : null;
  const endKey = (groupBy === "hour" && endKeyRaw && endKeyRaw.length === 10)
    ? endKeyRaw + "T23"
    : endKeyRaw;

  for (const row of rows) {
    // The SFMC REST API returns field names lowercased in the values object.
    // Support both casings so the normalizer works whether called from the
    // standalone server (lowercase) or a future MCP path (any casing).
    const dateKey = parseSfmcDate(row.SentDate ?? row.sentdate, groupBy);
    if (!dateKey) continue;

    // In-memory date range filter
    if (startKey && dateKey < startKey) continue;
    if (endKey   && dateKey > endKey)   continue;

    const status = row.MessageStatus ?? row.messagestatus ?? "";

    if (!map.has(dateKey)) {
      map.set(dateKey, { date: dateKey, sent: 0, delivered: 0, bounced: 0, undelivered: 0, opens: 0, clicks: 0 });
    }
    const bucket = map.get(dateKey);

    if (statusIn(status, MESSAGE_STATUS.SENT))        bucket.sent        += 1;
    if (statusIn(status, MESSAGE_STATUS.DELIVERED))   bucket.delivered   += 1;
    if (statusIn(status, MESSAGE_STATUS.BOUNCED))     bucket.bounced     += 1;
    if (statusIn(status, MESSAGE_STATUS.UNDELIVERED)) bucket.undelivered += 1;
    if (statusIn(status, MESSAGE_STATUS.OPENS))       bucket.opens       += 1;
    if (statusIn(status, MESSAGE_STATUS.CLICKS))      bucket.clicks      += 1;
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// normalizeMcpRow is retained for forward-compatibility if MCP support is
// added later, but is not called by the current routing plan.
function normalizeMcpRow(row) {
  return {
    date:        parseSfmcDate(row.SentDate ?? row.eventDate, "day"),
    sent:        statusIn(row.MessageStatus, MESSAGE_STATUS.SENT)        ? 1 : 0,
    delivered:   statusIn(row.MessageStatus, MESSAGE_STATUS.DELIVERED)   ? 1 : 0,
    bounced:     statusIn(row.MessageStatus, MESSAGE_STATUS.BOUNCED)     ? 1 : 0,
    undelivered: statusIn(row.MessageStatus, MESSAGE_STATUS.UNDELIVERED) ? 1 : 0,
    opens:       statusIn(row.MessageStatus, MESSAGE_STATUS.OPENS)       ? 1 : 0,
    clicks:      statusIn(row.MessageStatus, MESSAGE_STATUS.CLICKS)      ? 1 : 0,
  };
}

function mergeBucketsByDate(rowSets) {
  const map = new Map();
  for (const rows of rowSets) {
    for (const r of rows) {
      const existing = map.get(r.date) ?? { date: r.date, sent: 0, delivered: 0, bounced: 0, undelivered: 0, opens: 0, clicks: 0 };
      existing.sent += r.sent;
      existing.delivered += r.delivered;
      existing.bounced += r.bounced;
      existing.undelivered += r.undelivered;
      existing.opens += r.opens;
      existing.clicks += r.clicks;
      map.set(r.date, existing);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}


// ---------------------------------------------------------------------------
// 5b. RATE COMPUTATION
// Adds derived rate fields to an array of MetricBuckets (or a single bucket).
// Always call this on the way out — rates are never stored in raw buckets.
//
// Denominator rules (confirmed):
//   deliveryRate, bounceRate, undeliveredRate  → / sent
//   openRate, clickRate                        → / delivered  (reachable audience)
//   ctor (click-to-open rate)                  → / opens
//
// All returned rates are 0–100 (percentage points), not 0–1 fractions.
// Division-by-zero → 0 (not NaN).
// ---------------------------------------------------------------------------

/**
 * Derives the six rate fields from the raw counts on a single MetricBucket.
 * Returns a new object — does not mutate the input.
 *
 * @param {MetricBucket} bucket
 * @returns {MetricBucket}
 */
function computeRates(bucket) {
  const safe = (n, d) => (d > 0 ? (n / d) * 100 : 0);
  return {
    ...bucket,
    deliveryRate:    safe(bucket.delivered,   bucket.sent),
    bounceRate:      safe(bucket.bounced,     bucket.sent),
    undeliveredRate: safe(bucket.undelivered, bucket.sent),
    openRate:        safe(bucket.opens,       bucket.delivered),
    clickRate:       safe(bucket.clicks,      bucket.delivered),
    ctor:            safe(bucket.clicks,      bucket.opens),
  };
}

// ---------------------------------------------------------------------------
// 5c. STATUS FILTER
// Masks a MetricBucket[] so only the selected status column contributes to
// aggregation (KPI tiles, charts, table). `sent` is always preserved as the
// denominator. Used by both the dashboard and any server-side aggregation.
// ---------------------------------------------------------------------------

/**
 * Maps each status filter key to the MetricBucket field it isolates.
 * `null` means no masking (pass-through).
 */
const STATUS_METRIC = {
  all:         null,
  delivered:   "delivered",
  bounced:     "bounced",
  undelivered: "undelivered",
  opened:      "opens",
  clicked:     "clicks",
};

/**
 * Masks a MetricBucket[] so only the selected status column contributes to
 * aggregation. `sent` is preserved as denominator. Returns rows unchanged
 * when status is "all".
 *
 * @param {Object[]} rows  - MetricBucket[]
 * @param {string}   status - one of the STATUS_METRIC keys
 * @returns {Object[]}
 */
function filterByStatus(rows, status) {
  const field = STATUS_METRIC[status];
  if (!field) return rows;
  return rows.map((r) => ({
    ...r,
    delivered:   field === "delivered"   ? r.delivered   : 0,
    bounced:     field === "bounced"     ? r.bounced     : 0,
    undelivered: field === "undelivered" ? r.undelivered : 0,
    opens:       field === "opens"       ? r.opens       : 0,
    clicks:      field === "clicks"      ? r.clicks      : 0,
  }));
}

// ---------------------------------------------------------------------------
// 6. ORCHESTRATOR — ties it all together, this is what the agent calls
// ---------------------------------------------------------------------------

/**
 * @param {Object} rawQuery       - structured query from the agent
 * @param {Object} inheritedState - current viewState from the session store
 * @param {Object} mcpTools       - MCP tool callables injected by the agent context,
 *                                  must include { sfmc_query_data_extension_rows }
 */
async function getNormalizedMetrics(rawQuery, inheritedState, mcpTools) {
  const params = parseQuery(rawQuery, inheritedState);
  const plan = planQuery(params.channel, params.metrics);

  const sources = [];
  let allRows = [];

  if (plan.mcp.length > 0) {
    const raw = await fetchFromMCP(params);
    allRows = allRows.concat(raw);
    sources.push("mcp");
  }
  if (plan.rest_fallback.length > 0) {
    const raw = await fetchFromRestFallback(params, mcpTools);
    allRows = allRows.concat(raw);
    sources.push("rest_fallback");
  }

  // normalizeRestRows handles grouping, in-memory date filtering, and counting.
  // computeRates() adds the six derived rate fields to every bucket before returning.
  const buckets = normalizeRestRows(allRows, params.groupBy, params.dateRange).map(computeRates);

  /** @type {NormalizedResponse} */
  return {
    journeyId: params.journeyId,
    channel: params.channel,
    groupBy: params.groupBy,
    buckets,
    sources,
  };
}


// ---------------------------------------------------------------------------
// 6b. MESSAGE-LEVEL METRICS
// Groups raw Comm_Log rows by MessageName (within a journey), producing one
// "message entry" per distinct MessageName — each with its own bucket series.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MessageEntry
 * A single named message within a journey, with its own MetricBucket series.
 * @property {string}           id       - same as name (MessageName DE value)
 * @property {string}           name     - human-readable message name
 * @property {string}           channel  - CommunicationType value for this message (lower-cased)
 * @property {MetricBucket[]}   buckets  - daily/hourly buckets with computeRates() applied
 */

/**
 * Groups raw Comm_Log rows by MessageName, building a MessageEntry[] where
 * each entry has its own MetricBucket series.
 *
 * @param {Object[]} rows      - raw rows from fetchFromRestFallback()
 * @param {"day"|"hour"} groupBy
 * @returns {MessageEntry[]}   - sorted by total sent descending (busiest message first)
 */
function normalizeMessageRows(rows, groupBy = "day", dateRange = null) {
  // Group rows by MessageName
  const byMessage = new Map();

  for (const row of rows) {
    // Support both PascalCase and lowercase field names from the REST API
    const msgName = row.MessageName ?? row.messagename ?? "(unnamed)";
    if (!byMessage.has(msgName)) {
      byMessage.set(msgName, { channel: (row.CommunicationType ?? row.communicationtype ?? "").toLowerCase(), rows: [] });
    }
    byMessage.get(msgName).rows.push(row);
  }

  // For each message, normalise its rows into buckets (with date range filter)
  return Array.from(byMessage.entries())
    .map(([name, { channel, rows: msgRows }]) => ({
      id:      name,
      name,
      channel,
      buckets: normalizeRestRows(msgRows, groupBy, dateRange).map(computeRates),
    }))
    // Sort by total sent descending so the most-active message appears first
    .sort((a, b) => {
      const sumA = a.buckets.reduce((s, bkt) => s + bkt.sent, 0);
      const sumB = b.buckets.reduce((s, bkt) => s + bkt.sent, 0);
      return sumB - sumA;
    });
}

/**
 * Fetches all rows for a journey and returns a NormalizedResponse that
 * additionally includes a `messages` array (one MessageEntry per distinct
 * MessageName in the DE).
 *
 * The top-level `buckets` are the journey-level daily/hourly aggregates
 * (same as getNormalizedMetrics). The `messages` array is the per-message
 * breakdown the JourneyScreen table renders.
 *
 * @param {Object} rawQuery       - same shape as getNormalizedMetrics
 * @param {Object} inheritedState
 * @param {Object} mcpTools
 * @returns {Promise<NormalizedResponse & { messages: MessageEntry[] }>}
 */
async function getNormalizedMetricsByMessage(rawQuery, inheritedState, mcpTools) {
  const params = parseQuery(rawQuery, inheritedState);

  const allRows = await fetchFromRestFallback(params, mcpTools);

  const buckets  = normalizeRestRows(allRows, params.groupBy, params.dateRange).map(computeRates);
  const messages = normalizeMessageRows(allRows, params.groupBy, params.dateRange);

  return {
    journeyId: params.journeyId,
    channel:   params.channel,
    groupBy:   params.groupBy,
    buckets,
    messages,
    sources: ["rest_fallback"],
  };
}


// ---------------------------------------------------------------------------
// 7. AGENT ENTRY POINT
// The agent calls runQuery() directly, passing its available MCP tools.
// The HTTP handler below is retained for future standalone-service deployment.
// ---------------------------------------------------------------------------

/**
 * Primary entry point when running inside the Bob agent context.
 *
 * Usage:
 *   import { runQuery } from './Headless_Reporting_Agent_Backend.js';
 *
 *   const result = await runQuery(
 *     { journeyId: "Welcome Journey", channel: "email", range: "last_30d" },
 *     currentViewState,
 *     { sfmc_query_data_extension_rows }   // MCP tools available in agent context
 *   );
 *
 * @param {Object} rawQuery
 * @param {Object} inheritedState
 * @param {Object} mcpTools
 * @returns {Promise<NormalizedResponse>}
 */
async function runQuery(rawQuery, inheritedState, mcpTools) {
  return getNormalizedMetrics(rawQuery, inheritedState, mcpTools);
}

/**
 * Message-level entry point — same as runQuery() but includes a `messages`
 * array of per-MessageName breakdowns for the JourneyScreen drill table.
 *
 * @param {Object} rawQuery
 * @param {Object} inheritedState
 * @param {Object} mcpTools
 * @returns {Promise<NormalizedResponse & { messages: MessageEntry[] }>}
 */
async function runQueryMessage(rawQuery, inheritedState, mcpTools) {
  return getNormalizedMetricsByMessage(rawQuery, inheritedState, mcpTools);
}

// ---------------------------------------------------------------------------
// 8. SESSION STATE STORE
// In-memory store for prototype. Each session holds a SessionData object:
//   { viewState, journeys, detail }
// Replace the Map with Redis / an SFMC DE for production.
// ---------------------------------------------------------------------------

/** @type {Map<string, SessionData>} sessionId → SessionData */
const SESSION_STORE = new Map();

const DEFAULT_VIEW_STATE = {
  journeyId:  null,
  channel:    "all",
  dateRange:  null,   // null = all-time; set when user applies a date range
  status:     "all",
  drillLevel: "overview",
  messageId:  null,
  sortBy:     "deliveryRate",
  updatedBy:  null,
  updatedAt:  null,
};

/** @returns {SessionData} */
function defaultSession() {
  return { viewState: { ...DEFAULT_VIEW_STATE }, journeys: [], detail: null };
}

/**
 * Returns the full SessionData for a session, initialising with defaults on
 * first access. Callers that only need viewState should destructure:
 *   const { viewState } = await getSessionState(sessionId);
 */
async function getSessionState(sessionId) {
  if (!sessionId) return defaultSession();
  if (!SESSION_STORE.has(sessionId)) {
    SESSION_STORE.set(sessionId, defaultSession());
  }
  return SESSION_STORE.get(sessionId);
}

/**
 * Applies a partial viewState patch and returns the resulting full SessionData.
 * Enforces the drill-level/date-range mismatch guard from spec Section 5.5.
 *
 * @param {string} sessionId
 * @param {Partial<Object>} patch        - viewState fields to update
 * @param {"agent"|"dashboard"} updatedBy
 * @returns {{ session: SessionData, corrected: boolean }}
 */
async function patchSessionState(sessionId, patch, updatedBy = "agent") {
  const session = await getSessionState(sessionId);
  const current = session.viewState;

  // Merge patch over current viewState (last-write-wins, partial update)
  const next = { ...current, ...patch, updatedBy, updatedAt: new Date().toISOString() };

  // Drill-level mismatch guard (spec Section 5.5)
  // If the resulting date range is > 30 days, message-level drill is too granular.
  let corrected = false;
  if (next.drillLevel === "message" && next.dateRange?.start && next.dateRange?.end) {
    const spanDays = (new Date(next.dateRange.end) - new Date(next.dateRange.start)) / 86400000;
    if (spanDays > 30) {
      next.drillLevel = "journey";
      corrected = true;
    }
  }

  session.viewState = next;
  SESSION_STORE.set(sessionId, session);
  return { session, corrected };
}

/**
 * Stores a NormalizedResponse as the active drill detail for a session.
 * The dashboard JourneyScreen / MessageScreen reads this to render real data.
 *
 * @param {string} sessionId
 * @param {NormalizedResponse} result
 */
async function setSessionDetail(sessionId, result) {
  const session = await getSessionState(sessionId);
  session.detail = result;
  SESSION_STORE.set(sessionId, session);
}

// ---------------------------------------------------------------------------
// 9. OVERVIEW QUERY
// Queries every known journey in parallel and writes the JourneyEntry[] index
// into SESSION_STORE so the dashboard Overview screen has real data to render.
//
// The agent calls this when the user asks for a top-level summary (e.g.
// "show me all journeys" / "overview"). Individual journey/message drills
// use runQuery() + setSessionDetail() instead.
//
// journeyNames must be supplied by the agent from known DE values — there is
// no "list all journeys" endpoint in the Comm_Log DE itself.
// ---------------------------------------------------------------------------

/**
 * Queries the Comm_Log DE to find the distinct CommunicationType values for a
 * single journey. Uses the supplied dateRange so channel discovery covers the
 * same window as the overview query — avoids silently dropping channels (e.g.
 * SMS) that sent outside a narrower lookback period.
 *
 * CommunicationType values in the DE: "Email", "SMS" (and "Push" if applicable).
 * Returned as lower-case strings to match the dashboard's channel key convention.
 *
 * @param {string}   journeyName
 * @param {Object}   mcpTools   - must include { sfmc_query_data_extension_rows }
 * @param {Object}   [dateRange] - { start, end } ISO8601; defaults to last 30 days
 * @returns {Promise<string[]>}  e.g. ["email", "sms"]
 */
async function fetchJourneyChannels(stem, mcpTools, dateRange) {
  const range = dateRange ?? daysAgo(30);
  const rows = await fetchFromRestFallback(
    { journeyId: stem, channel: "all", dateRange: range, fieldsOverride: "CommunicationType" },
    mcpTools
  );

  const seen = new Set(
    rows
      .map((r) => (r.CommunicationType ?? r.communicationtype ?? "").toLowerCase())
      .filter(Boolean)
  );

  // Return only channels confirmed present in the DE. An empty array means
  // no rows were found for this stem in the given date window — callers should
  // treat this as "no data" rather than assuming all channels are active.
  return Array.from(seen);
}

/**
 * Queries the Comm_Log DE for every journey stem in journeyNames, builds the
 * JourneyEntry[] index, and writes it to the session store.
 *
 * @param {string}   sessionId
 * @param {string[]} journeyNames  - MessageName stem values (from discoverJourneyNames)
 * @param {Object}   mcpTools      - must include { sfmc_query_data_extension_rows }
 * @param {Object}   [channelMap]  - optional map of stem → string[] of known channels
 * @returns {Promise<JourneyEntry[]>}
 */
async function runQueryOverview(sessionId, journeyNames, mcpTools, channelMap = {}) {
  const session = await getSessionState(sessionId);
  const { viewState } = session;

  // Run all journey metric queries in parallel — one NormalizedResponse per stem.
  const results = await Promise.all(
    journeyNames.map((name) =>
      getNormalizedMetrics(
        { journeyId: name, channel: "all", dateRange: viewState.dateRange, metrics: DEFAULT_METRICS },
        viewState,
        mcpTools
      )
    )
  );

  // Derive distinct channels for each stem from the same date window as the metrics query.
  const channelResults = await Promise.all(
    journeyNames.map((name) =>
      channelMap[name]
        ? Promise.resolve(channelMap[name])
        : fetchJourneyChannels(name, mcpTools, viewState.dateRange)
    )
  );

  // Build the JourneyEntry index. The stem is both the id and the display name.
  const journeys = results.map((r, i) => ({
    id:       r.journeyId,
    name:     r.journeyId,
    channels: channelResults[i],
    buckets:  r.buckets,
  }));

  session.journeys = journeys;
  SESSION_STORE.set(sessionId, session);
  return journeys;
}

// ---------------------------------------------------------------------------
// 9b. JOURNEY DISCOVERY
// Discovers distinct journey "stems" by reading MessageName from the DE and
// stripping _Email / _SMS / _Push suffixes. This works for all channel types
// including SMS, which does not populate JourneyName in this DE.
//
// Strategy: page through MessageName values, derive stems, deduplicate.
// Capped at 100 distinct stems to avoid runaway iteration on very large DEs.
// ---------------------------------------------------------------------------

/**
 * Queries the Comm_Log DE for distinct MessageName stems (i.e. journey display
 * names with channel suffixes stripped). Works for all channels including SMS,
 * which does not populate the JourneyName field.
 *
 * @param {Object} mcpTools  - must include { sfmc_query_data_extension_rows }
 * @returns {Promise<string[]>}  - unique stems, alpha-sorted
 */
async function discoverJourneyNames(mcpTools) {
  const fields = "MessageName";
  const seen   = new Set();
  let page     = 1;

  while (seen.size < 100) {
    const response = await mcpTools.sfmc_query_data_extension_rows({
      key:       COMMS_DE_KEY,
      fields,
      page,
      page_size: DE_PAGE_SIZE,
    });

    const rows = (response.items ?? []).map(item => item.values ?? item);
    for (const row of rows) {
      const raw = row.MessageName ?? row.messagename ?? "";
      const stem = messageNameStem(raw);
      if (stem) seen.add(stem);
      if (seen.size >= 100) break;
    }

    // Stop when we hit the cap or receive a partial page (no more rows)
    if (seen.size >= 100) break;
    if (rows.length < DE_PAGE_SIZE) break;
    page += 1;
  }

  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}


// ---------------------------------------------------------------------------
// 9c. FAILURE RECORD QUERY
// Returns individual subscriber-level rows where MessageStatus is Bounced or
// Undelivered (or both, depending on channel). Used by the MessageScreen
// "Bounced / Undelivered Records" investigative panel.
//
// Unlike the metric queries (which aggregate rows into buckets), this returns
// the raw records so operators can see per-subscriber detail and export them.
//
// Fields returned per record (subset of confirmed DE schema):
//   SubscriberKey, Email, Mobile, MessageStatus, SentDate,
//   smsUndeliveredStatus, smsUndeliveredReason, AffectedCustomerId,
//   NMI, JourneyName, MessageName
// ---------------------------------------------------------------------------

/** The DE fields requested for failure record queries. */
const FAILURE_RECORD_FIELDS =
  "SubscriberKey,Email,Mobile,MessageStatus,SentDate," +
  "smsUndeliveredStatus,smsUndeliveredReason," +
  "AffectedCustomerId,NMI,JourneyName,MessageName";

/**
 * @typedef {Object} FailureRecord
 * A single bounced or undelivered subscriber record returned by getFailureRecords().
 * All string fields — empty string means the DE column was empty.
 * @property {string} subscriberKey
 * @property {string} email
 * @property {string} mobile
 * @property {string} messageStatus   - "Bounced" | "Undelivered"
 * @property {string} sentDate        - raw SFMC date string from the DE
 * @property {string} undeliveredStatus  - smsUndeliveredStatus value (SMS only)
 * @property {string} undeliveredReason  - smsUndeliveredReason value (SMS only)
 * @property {string} affectedCustomerId
 * @property {string} nmi
 * @property {string} journeyName
 * @property {string} messageName
 */

/**
 * Fetches all Bounced and Undelivered rows for a specific message name stem
 * and optional date range, returning them as individual FailureRecord objects.
 *
 * @param {string}  stem        - MessageName stem (from messageNameStem())
 * @param {string}  channel     - "email" | "sms" | "push" | "all"
 * @param {Object|null} dateRange - { start, end } ISO8601 or null for all-time
 * @param {Object}  mcpTools    - must include { sfmc_query_data_extension_rows }
 * @returns {Promise<FailureRecord[]>}
 */
async function getFailureRecords(stem, channel, dateRange, mcpTools) {
  const { sfmc_query_data_extension_rows } = mcpTools;

  // Build the standard stem + channel + date filter, then AND on MessageStatus
  const baseFilter = buildDeFilter(stem, channel, dateRange);
  const statusClause = "(messagestatus eq 'Bounced' or messagestatus eq 'Undelivered')";
  const filter = baseFilter ? `${baseFilter} and ${statusClause}` : statusClause;

  const allRows = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await sfmc_query_data_extension_rows({
      key:       COMMS_DE_KEY,
      filter,
      fields:    FAILURE_RECORD_FIELDS,
      page,
      page_size: DE_PAGE_SIZE,
    });

    // sfmc_query_data_extension_rows places the primary-key field(s) in item.keys
    // and all other fields in item.values — merge both so normalisation sees the
    // full row including SubscriberKey (which is the DE primary key).
    const rows = (response.items ?? []).map(item =>
      Object.assign({}, item.keys ?? {}, item.values ?? item)
    );
    allRows.push(...rows);
    hasMore = rows.length === DE_PAGE_SIZE;
    page += 1;
  }

  // Apply in-memory date filter (rowset endpoint ignores sentdate comparisons).
  const keyLen   = 10; // day-level string comparison is sufficient here
  const startKey = dateRange?.start ? dateRange.start.slice(0, keyLen) : null;
  const endKey   = dateRange?.end   ? dateRange.end.slice(0, keyLen)   : null;

  return allRows
    .filter((row) => {
      const dateKey = parseSfmcDate(row.SentDate ?? row.sentdate, "day");
      if (!dateKey) return false;
      if (startKey && dateKey < startKey) return false;
      if (endKey   && dateKey > endKey)   return false;
      return true;
    })
    .map((row) => ({
      subscriberKey:     row.SubscriberKey         ?? row.subscriberKey         ?? row.subscriberkey         ?? "",
      email:             row.Email                 ?? row.email                 ?? "",
      mobile:            row.Mobile                ?? row.mobile                ?? "",
      messageStatus:     row.MessageStatus         ?? row.messagestatus         ?? "",
      sentDate:          row.SentDate              ?? row.sentdate              ?? "",
      undeliveredStatus: row.smsUndeliveredStatus  ?? row.smsundeliveredstatus  ?? "",
      undeliveredReason: row.smsUndeliveredReason  ?? row.smsundeliveredreason  ?? "",
      affectedCustomerId:row.AffectedCustomerId    ?? row.affectedcustomerid    ?? "",
      nmi:               row.NMI                   ?? row.nmi                   ?? "",
      journeyName:       row.JourneyName           ?? row.journeyname           ?? "",
      messageName:       row.MessageName           ?? row.messagename           ?? "",
    }));
}

/** HTTP handler — for future standalone-service deployment. */
export default async function handler(req, res) {
  try {
    const url = req.url ?? "";

    // GET /session/:id/state  or  PATCH /session/:id/state
    const sessionStateMatch = url.match(/^\/session\/([^/]+)\/state$/);
    if (req.method === "GET" && sessionStateMatch) {
      const { viewState, journeys, detail } = await getSessionState(sessionStateMatch[1]);
      return res.status(200).json({ sessionId: sessionStateMatch[1], viewState, journeys, detail });
    }
    if (req.method === "PATCH" && sessionStateMatch) {
      const { patch, updatedBy } = req.body;
      const { session, corrected } = await patchSessionState(sessionStateMatch[1], patch, updatedBy);
      return res.status(200).json({ sessionId: sessionStateMatch[1], viewState: session.viewState, corrected });
    }

    // GET /api/metrics — dashboard poll
    if (req.method === "GET" && url.startsWith("/api/metrics")) {
      const { journeyId, channel, range, sessionId } = req.query;
      const { viewState } = await getSessionState(sessionId);
      // NOTE: mcpTools must be injected at the service layer when deployed standalone
      const result = await getNormalizedMetrics(
        { journeyId, channel, range, metrics: DEFAULT_METRICS },
        viewState,
        req.mcpTools ?? {}
      );
      return res.status(200).json(result);
    }

    // POST /api/overview — discover journey names + run overview metrics + write journeys to session
    if (req.method === "POST" && url.startsWith("/api/overview")) {
      const { sessionId, dateRange, journeyNames: suppliedNames } = req.body;
      const mcpTools = req.mcpTools ?? {};

      // Use supplied names (cached by the dashboard) or discover them from the DE.
      const names = suppliedNames?.length
        ? suppliedNames
        : await discoverJourneyNames(mcpTools);

      // Apply an explicit dateRange from the request body into session state before
      // running metrics so runQueryOverview() picks it up via viewState.dateRange.
      if (dateRange !== undefined) {
        await patchSessionState(sessionId, { dateRange: dateRange ?? null }, "dashboard");
      }

      const journeys = await runQueryOverview(sessionId, names, mcpTools);
      return res.status(200).json({ journeys, journeyNames: names });
    }

    // POST /api/query/failures — individual bounced/undelivered subscriber records
    // Checked before /api/query/message and /api/query (all share the /api/query prefix)
    if (req.method === "POST" && url.startsWith("/api/query/failures")) {
      const { sessionId, messageId, journeyId, dateRange: bodyDateRange } = req.body;
      const { viewState } = await getSessionState(sessionId);
      const mcpTools = req.mcpTools ?? {};

      const stem      = messageId ?? journeyId ?? viewState.journeyId;
      const channel   = viewState.channel ?? "all";
      const dateRange = bodyDateRange !== undefined ? bodyDateRange : viewState.dateRange;

      const records = await getFailureRecords(stem, channel, dateRange, mcpTools);
      return res.status(200).json({ messageId: stem, channel, records });
    }

    // POST /api/query/message — message-level drill (must be checked before /api/query)
    if (req.method === "POST" && url.startsWith("/api/query/message")) {
      const { sessionId, journeyId, messageId, dateRange: bodyDateRange } = req.body;
      const { viewState } = await getSessionState(sessionId);
      const mcpTools = req.mcpTools ?? {};

      // Build a raw query targeting this specific message stem.
      // Include any explicit dateRange from the request body so the dashboard's
      // applied range is respected without relying solely on session state.
      const rawQuery = {
        journeyId: messageId ?? journeyId,
        channel:   viewState.channel,
        ...(bodyDateRange !== undefined && { dateRange: bodyDateRange }),
      };
      const result = await runQueryMessage(rawQuery, viewState, mcpTools);

      // Attach messageId to the result so the dashboard can match it in the staleness check.
      result.messageId = messageId ?? null;
      await setSessionDetail(sessionId, result);
      await patchSessionState(sessionId, { drillLevel: "message", journeyId, messageId: messageId ?? null }, "agent");
      return res.status(200).json(result);
    }

    // POST /api/query — journey-level structured query
    if (req.method === "POST" && url.startsWith("/api/query")) {
      const { sessionId, query, journeyId, dateRange: bodyDateRange } = req.body;
      const { viewState } = await getSessionState(sessionId);
      const mcpTools = req.mcpTools ?? {};

      // Support both { query: {...} } (agent) and flat { journeyId, channel, ... } (dashboard).
      // Include any explicit dateRange from the request body so the dashboard's
      // applied range is respected without relying solely on session state.
      const rawQuery = query ?? {
        journeyId: journeyId ?? viewState.journeyId,
        channel:   viewState.channel,
        ...(bodyDateRange !== undefined && { dateRange: bodyDateRange }),
      };
      const result = await runQuery(rawQuery, viewState, mcpTools);

      await setSessionDetail(sessionId, result);
      await patchSessionState(sessionId, { drillLevel: "journey", journeyId: result.journeyId }, "agent");
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    if (err instanceof QueryError) {
      return res.status(400).json({ code: err.code, message: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal error" });
  }
}


export {
  runQuery,
  runQueryMessage,
  runQueryOverview,
  getFailureRecords,
  discoverJourneyNames,
  COMMS_DE_KEY,
  fetchJourneyChannels,
  parseQuery,
  planQuery,
  resolveSource,
  getNormalizedMetrics,
  getNormalizedMetricsByMessage,
  computeRates,
  filterByStatus,
  STATUS_METRIC,
  buildDeFilter,
  normalizeMcpRow,
  normalizeRestRows,
  normalizeMessageRows,
  parseSfmcDate,
  getSessionState,
  patchSessionState,
  setSessionDetail,
  CAPABILITY_MAP,
  MESSAGE_STATUS,
  DEFAULT_VIEW_STATE,
  QueryError,
};