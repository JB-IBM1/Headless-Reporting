# SFMC Deliverability Reporting & Analytics Agent — Spec

## 1. Overview

A headless agent for querying Salesforce Marketing Cloud (SFMC) deliverability data, paired with an interactive dashboard. Users interact conversationally (chat) or visually (dashboard), and the two surfaces share state so either can hand off to the other mid-task.

**Core use case:** user asks for delivery metrics on a journey (email/SMS), with a date range, and either gets an answer in chat or drills into a dashboard.

---

## 2. Data Layer

- **Source of truth:** centralized comms Data Extension (DE) in SFMC — holds message name, channel, status, and related fields, refreshed hourly.
- **Primary access:** MCP server connection to SFMC, for anything MCP supports (Journey Builder / Email Studio sends, opens, clicks, bounces, unsubscribes).
- **Fallback access:** SFMC REST/SOAP API directly against the DE, for anything MCP doesn't cover — notably **SMS delivery data**, which MCP does not support.
- **Aggregation recommendation:** use an SQL Query Activity (scheduled hourly, matching the DE refresh) to build rollup DEs (journey × channel × day) for fast dashboard queries. Reserve raw DE row-level access for deep drill-down only (individual sends/messages), since querying millions of raw rows live is slow and expensive.
- **Capability map:** maintain an explicit metric→source mapping so the agent knows upfront whether to route a request to MCP or the REST fallback, rather than trying MCP first and failing over reactively.

---

## 3. Conversational Agent

Users ask in natural language; the agent extracts: journey/campaign, channel, metric(s), date range. Common query shapes to support:

- Single journey, full metric set, relative date range ("How did Welcome perform last week?")
- Single metric, single channel ("SMS bounce rate for X in March")
- Multi-channel comparison ("Compare email vs SMS for X this month")
- Ranking/leaderboard, no journey specified ("Which journeys had the worst delivery rate last 30 days?")

The agent should offer to open matching context in the dashboard rather than only answering in text, using the handoff mechanism below (Section 5).

---

## 4. Dashboard — Drill-Down Structure

**Persistent filters across all screens:** date range, channel (email/SMS/push/all), status.

### Screen 1 — Overview
- KPI tiles: total sent, overall delivery rate, overall bounce rate, trend vs. previous period
- Sortable journey/campaign table: name, channel(s), sent, delivered %, open %, click %, bounce %, with a per-row trend sparkline

### Screen 2 — Journey Detail
- Header: journey name, date range, channel toggle/tabs
- Trend chart: selected metric(s) over time (daily, or hourly for short ranges)
- Status breakdown (delivered/bounced/failed/pending) as stacked bar or donut
- Table of individual messages within the journey, same sortable columns as Screen 1

### Screen 3 — Message Detail
- Send-level or hourly-bucketed trend (matches the DE's hourly refresh)
- Full status breakdown for that message
- Optional on-demand raw/recipient-level send list (paginated, not loaded by default)

**Cross-cutting:** breadcrumb navigation (Overview > Journey > Message); export/share (CSV or link) on any view.

---

## 5. Chat ↔ Dashboard State Sharing

### 5.1 Canonical state object

```json
{
  "sessionId": "sess_8f2a...",
  "viewState": {
    "journeyId": "jrny_4471" | null,
    "channel": "email" | "sms" | "push" | "all",
    "dateRange": { "start": "ISO8601", "end": "ISO8601", "preset": "last_30d" | "custom" },
    "status": "all" | "delivered" | "bounced" | "undelivered" | "opened" | "clicked",
    "drillLevel": "overview" | "journey" | "message",
    "messageId": "msg_9012" | null,
    "sortBy": "deliveryRate" | "sent" | "bounceRate",
    "updatedBy": "agent" | "dashboard",
    "updatedAt": "ISO8601"
  }
}
```

### 5.2 Endpoints
- `GET /session/{sessionId}/state` — read current state
- `PATCH /session/{sessionId}/state` — partial update; unspecified fields inherited
- `POST /session/{sessionId}/state/subscribe` (WebSocket/SSE) — dashboard subscribes for live agent-driven updates

### 5.3 Agent → Dashboard flow
1. User asks a question in chat.
2. Agent resolves parameters, filling gaps from current `viewState`.
3. Agent answers in chat, then offers a handoff (see Section 6) rather than silently updating state.
4. On confirmation, agent `PATCH`es state; subscribed dashboard navigates directly to the right drill level — no reload, no re-clicking.

### 5.4 Dashboard → Agent flow
1. User changes filters/drills down in the dashboard; dashboard `PATCH`es state.
2. User asks a follow-up in chat (e.g., "why did this drop?").
3. Agent's first action is `GET /session/{id}/state` to pull current context before answering — no re-prompting the user for what "this" means.

### 5.5 Precedence & validation rules
- Last-write-wins between surfaces (no real concurrency in practice — user is either typing or clicking).
- **Explicit user input always overrides inherited state** — e.g., typing "show me email" changes `channel` only; journey and date range persist.
- **Drill-level/date-range mismatch guard:** if a requested date range is too coarse for the current `drillLevel` (e.g., 3 months at message-level), the PATCH handler auto-corrects `drillLevel` up (toward `journey`/`overview`) and returns the corrected state so the calling surface can inform the user.

---

## 6. Agent Handoff Message Schema

```json
{
  "type": "handoff_offer",
  "trigger": "user_confirmed" | "auto_suggested",
  "message": "Want to see this in the dashboard? I can pull up the Welcome journey filtered to SMS, last 30 days.",
  "targetState": {
    "journeyId": "jrny_4471",
    "channel": "sms",
    "dateRange": { "preset": "last_30d" },
    "drillLevel": "journey"
  },
  "confirmationRequired": true
}
```

- Agent proposes in plain language and waits for confirmation before the first PATCH of a conversation — it shouldn't silently change what's on someone's screen.
- If the drill-level auto-correction fires, the handoff message states the adjustment explicitly (e.g., "That's a 3-month range, so I'll show journey-level trends rather than individual sends.").
- If the dashboard is already the active surface and the user's message is an obvious in-context update (e.g., "actually check October instead"), skip confirmation and PATCH directly.

---

## 7. Dashboard Subscribe/Reconnect Behavior

- **Initial load:** one-time `GET` to hydrate, then open SSE/WebSocket subscription for live updates. Don't rely on the socket alone for first paint.
- **Dropped connection:** show a small non-blocking "reconnecting" indicator; retry with backoff (1s, 2s, 5s), then fall back to polling every 15s.
- **Reconnect:** re-`GET` state immediately rather than trusting the socket didn't miss an update while disconnected.
- **Staleness guard:** every state object carries `updatedAt`; if local state is older than the freshly fetched state on reconnect, re-render from the fetched state rather than merging.
- **Multi-tab:** both tabs subscribe independently; last-write-wins is sufficient for v1 — no special conflict warning needed.

---

## 8. Open Items / Next Steps

### Resolved
- ✅ Comm_Log DE field names and types confirmed from `Comm_Log_Schema.csv`.
- ✅ `MessageStatus` confirmed exhaustive set: `Sent`, `Delivered`, `Opened`, `Clicked`, `Bounced`, `Undelivered` — no `Failed` value exists.
- ✅ Metric derivation: one row per event; metrics counted by `MessageStatus` membership in named sets (see `MESSAGE_STATUS` in backend).
- ✅ Channel identified via `CommunicationType`; journey via `JourneyName`; date via `SentDate`.
- ✅ `SentDate` REST format confirmed as `M/D/YYYY h:mm:ss AM/PM` — explicit parser implemented in backend.
- ✅ SQL Query Activity that populates the Comm_Log DE is already built and running.
- ✅ All metrics (including opens/clicks) route to the Comm_Log DE via REST fallback — no MCP split needed.
- ✅ `fetchFromRestFallback()` implemented — uses `sfmc_query_data_extension_rows` MCP tool with paginated filter query.
- ✅ Session state store implemented (`getSessionState`, `patchSessionState`) — in-memory `Map` with drill-level mismatch guard; `GET/PATCH /session/{id}/state` endpoints wired in HTTP handler.
- ✅ `viewState.status` updated to `all | delivered | bounced | undelivered | opened | clicked` — aligned to confirmed `MessageStatus` DE values, `pending` removed.
- ✅ **Metric formulas confirmed** — denominators locked in (`computeRates()` in backend, all six `sortBy` keys in dashboard):
  - `deliveryRate`    = `delivered / sent`   × 100
  - `bounceRate`      = `bounced / sent`      × 100
  - `undeliveredRate` = `undelivered / sent`  × 100  *(the three delivery-side rates sum to 100%)*
  - `openRate`        = `opens / delivered`   × 100  *(reachable audience denominator)*
  - `clickRate`       = `clicks / delivered`  × 100
  - `ctor`            = `clicks / opens`      × 100  *(click-to-open rate, drill-down only)*

- ✅ **Dashboard `status` filter pill** — `FilterPill` group for `all / delivered / bounced / undelivered / opened / clicked` rendered in the global filter bar; wired to `status` state via `filterByStatus()` helper which masks MetricBucket series before `sumSeries()` aggregation. Applied consistently on Overview, Journey, and Message screens.

### Still Open
- **Dashboard hosting:** decide standalone web app vs. embed (affects URL param strategy).
- ~~**SSE / WebSocket endpoint**~~ — **dropped**. The original spec assumed a standalone backend with a persistent HTTP connection to a browser tab. The actual architecture is different: the backend runs entirely inside the Bob agent context; MCP tools (`sfmc_query_data_extension_rows`) are callable functions, not HTTP services. There is no persistent process to push from, and no scenario where chat and dashboard are simultaneously live in a way that requires server push. State sharing works without SSE: the agent calls `patchSessionState()` after answering; the dashboard calls `getSessionState()` when opened. Section 7 (subscribe/reconnect spec) is superseded by this model and can be ignored for implementation.
- ✅ **Dashboard real-data layer:** dashboard is fully connected to the live backend. `runQueryOverview()` populates the journeys index in `SESSION_STORE`; all three screens (Overview, Journey, Message) consume live `NormalizedResponse` buckets from the backend API. No mock or seeded data is used.