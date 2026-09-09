# Headless Reporting — Technical & Solution Documentation

> Architecture, component inventory, data model, local dependencies, and productionisation requirements.

| | |
|---|---|
| **Status** | Prototype / Design Artefact |
| **Version** | 1.2 |
| **Audience** | Engineering, Platform, Architecture |
| **Prepared** | July 2025 |
| **Last Updated** | July 2025 (agent test suite completed — 56 tests; test count corrections; E2E demo prep guide; handover summary artefact) |

---

## Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
   - [2a. Component Overview](#2a-component-overview)
   - [2b. Architecture Diagram](#2b-architecture-diagram)
3. [Data Layer](#3-data-layer)
   - [3a. Comm_Log Data Extension Schema](#3a-comm_log-data-extension-schema)
   - [3b. Metric Derivation Rules](#3b-metric-derivation-rules)
   - [3c. Capability Routing Map](#3c-capability-routing-map)
4. [Backend Service](#4-backend-service)
   - [4a. Query Pipeline](#4a-query-pipeline)
   - [4b. Key Functions Reference](#4b-key-functions-reference)
   - [4c. Date Parsing](#4c-date-parsing)
   - [4d. Journey Discovery](#4d-journey-discovery)
   - [4e. Session Store](#4e-session-store)
   - [4f. SFMC Authentication](#4f-sfmc-authentication)
5. [Conversational Agent](#5-conversational-agent)
6. [Dashboard](#6-dashboard)
7. [Session State & Chat↔Dashboard Handoff](#7-session-state--chatdashboard-handoff)
8. [API Reference](#8-api-reference)
9. [Test Suite](#9-test-suite)
10. [Local Dependencies (What Is Not Yet Portable)](#10-local-dependencies-what-is-not-yet-portable)
11. [Productionisation Requirements](#11-productionisation-requirements)
12. [Open Items & Known Gaps](#12-open-items--known-gaps)

---

## 1. Executive Summary

The Headless Reporting solution is an SFMC deliverability analytics system that gives AusNet operators two complementary interfaces to the same data: a natural-language chat agent for ad-hoc queries, and an interactive drill-down dashboard for visual exploration. Both surfaces share a server-side session object so context flows seamlessly between them — a user can ask a question in chat and open the result directly in the dashboard with a single confirmation.

The current codebase is a **functional prototype running locally**. All query logic, metric derivation, session state, and dashboard rendering are implemented. The gaps that remain before this can run in production are hosting, authentication hardening, state persistence, and removal of the local Bob MCP dependency. Those gaps are fully enumerated in Sections 9 and 10.

> **Prototype scope:** The four source files (`Headless_Reporting_Agent_Backend.js`, `Headless_Reporting_Agent.js`, `Headless_Reporting_Dashboard.jsx`, `server.js`) are production-quality in logic and data handling. What is not yet production-ready is *where they run* and *how they are secured*.

---

## 2. System Architecture

### 2a. Component Overview

| File / Component | Role | Language / Runtime | Status |
|---|---|---|---|
| `server.js` | Express HTTP server. Serves the dashboard static files, exposes REST API endpoints for sessions and queries, handles SFMC OAuth2 token caching, and injects the MCP tool shim into every request. | Node.js ≥ 18, ESM | ✅ Implemented |
| `Headless_Reporting_Agent_Backend.js` | Core query pipeline: query parser, capability router, SFMC REST client (`fetchFromRestFallback`), normaliser, metric calculator, session store, journey discovery, and overview aggregator. | Node.js ≥ 18, ESM | ✅ Implemented |
| `Headless_Reporting_Agent.js` | Conversational layer. Parses natural-language intent, orchestrates backend calls, formats chat replies, manages pending dashboard handoff offers, and enforces the confirmation-before-state-mutation rule. | Node.js ≥ 18, ESM | ✅ Implemented |
| `Headless_Reporting_Dashboard.jsx` | React SPA. Three drill levels (Overview → Journey → Message). Polls session state, renders KPI tiles, trend charts (Recharts), sortable tables, status breakdown, sparklines, and CSV export. Global filter bar with date-range picker, channel selector, and status pill group. | React 18, Recharts 2, Lucide icons — delivered via CDN UMD + runtime Babel transpile | ✅ Implemented |
| `index.html` | Entry page. Resolves or creates a session ID (URL param → localStorage → UUID), bootstraps CDN dependencies, fetches and Babel-transpiles the dashboard JSX at runtime, then mounts the React app. | HTML / Vanilla JS | ✅ Implemented |
| `e2e-demo-preparation-guide.html` | End-to-end demo preparation guide. Covers environment checklist (server, .env, SFMC credentials, Bob/MCP), environment variable reference, and a timed 15–20 minute demo script with what to say and what to show at each step. Chat ↔ Dashboard session sharing tip included. | Static HTML artefact | ✅ Implemented |
| `headless-reporting-handover-summary.html` | One-page handover summary for stakeholders. Covers what is real (implemented and passing), what is not yet real (stubs and local dependencies), and next steps for productionisation. | Static HTML artefact | ✅ Implemented |
| SFMC Comm_Log DE | Single source of truth. One row per communication event; refreshed by an existing SQL Query Activity (hourly). Queried via SFMC REST API (`/data/v1/customobjectdata/key/{key}/rowset`). | SFMC Data Extension | ✅ In production in SFMC |
| IBM Bob / SFMC MCP Server | Currently the *only* mechanism the agent uses to call SFMC when running inside the Bob context. The `server.js` MCP shim replicates this for standalone use. | IBM Bob agent platform | ⚠️ Local dependency — see §9 |

### 2b. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        USER SURFACES                                    │
│                                                                         │
│   ┌──────────────────────┐        ┌──────────────────────────────────┐  │
│   │  Chat (IBM Bob UI)   │        │  Dashboard (browser / index.html) │  │
│   │  handleUserMessage() │        │  App { sessionId, baseUrl }       │  │
│   └──────────┬───────────┘        └─────────────────┬────────────────┘  │
│              │  natural-language input               │  GET/POST/PATCH   │
└──────────────┼───────────────────────────────────────┼──────────────────┘
               │                                       │
               ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               server.js  (Express, port 3000, 127.0.0.1)                │
│                                                                         │
│  GET  /session/:id/state          POST /api/overview                    │
│  PATCH /session/:id/state         POST /api/query                       │
│                                   POST /api/query/message               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │          Headless_Reporting_Agent_Backend.js                    │    │
│  │                                                                 │    │
│  │  parseQuery()  ──►  fetchFromRestFallback()  ──►  normalise()  │    │
│  │                           │                                     │    │
│  │  SESSION_STORE (Map)  ◄───┘     computeRates()                 │    │
│  │  getSessionState()  patchSessionState()  setSessionDetail()     │    │
│  │  runQueryOverview()  discoverJourneyNames()                     │    │
│  └────────────────────────────┬────────────────────────────────────┘    │
│                               │                                         │
│  ┌────────────────────────────▼────────────────────────────────────┐    │
│  │   MCP Tool Shim  (server.js sfmc_query_data_extension_rows)     │    │
│  │   → SFMC REST  /data/v1/customobjectdata/key/{key}/rowset       │    │
│  │   → OAuth2 client-credentials token cache (5-min early expiry) │    │
│  └────────────────────────────┬────────────────────────────────────┘    │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │  HTTPS + Bearer token
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Salesforce Marketing Cloud                                 │
│                                                                         │
│   Comm_Log Data Extension  (CustomerKey: 69C7427F-DC32-4114-…)         │
│   Refreshed hourly by existing SQL Query Activity                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**State flow summary:** The chat agent and dashboard never talk to each other directly. Both read and write via the session endpoints on the same Express server. The server's in-memory `SESSION_STORE` (a `Map`) is the single synchronisation point. The dashboard polls `GET /session/:id/state` every 15 seconds and re-renders when `updatedAt` advances.

---

## 3. Data Layer

### 3a. Comm_Log Data Extension Schema

All metrics are derived from a single, flat event-log DE. Every communication event — send, delivery confirmation, open, click, bounce, or undeliverable status — is one row.

| Field | Type | Key Use | Notes |
|---|---|---|---|
| `SubscriberKey` | Text(4000) | Contact identity | Not nullable |
| `JobID` | Text(50) | Send job reference | Not nullable |
| `CommunicationType` | Text(50) | **Channel filter** | Values: `Email`, `SMS`, `Push` |
| `MessageName` | Text(250) | **Journey/message filter** | Includes channel suffix e.g. `_Email`, `_SMS` — stripped to derive stem |
| `MessageStatus` | Text(50) | **All metric counts** | Exhaustive set: `Sent`, `Delivered`, `Opened`, `Clicked`, `Bounced`, `Undelivered` |
| `SentDate` | Date | **Time-series grouping** | REST format: `M/D/YYYY h:mm:ss AM/PM` — explicit parser implemented |
| `JourneyName` | Text(250) | Journey reference | Populated for Email; *not populated for SMS* — use `MessageName` stem instead |
| `Email` | EmailAddress(254) | Recipient (email) | Nullable |
| `Mobile` | Text(50) | Recipient (SMS) | Nullable |
| `smsUndeliveredStatus` | Text(150) | SMS failure reason code | Nullable; drill-down only |
| `smsUndeliveredReason` | Text(250) | SMS failure reason text | Nullable; drill-down only |
| `AffectedCustomerId`, `IncidentId`, `NMI` | Text | Business correlation | Operational context fields — not used in metric aggregation |
| `MailingStreet`, `MailingCity`, `MailingState`, `MailingPostcode` | Text | Postal address | Present for postal/letter channel entries |
| `view_email_url` | Text(300) | Email preview link | Nullable; included in detail screens |

### 3b. Metric Derivation Rules

All six metrics are computed from `COUNT(*)` grouped by which `MessageStatus` values qualify for each set. The `SENT` superset always equals the total row count for the query window.

| Metric | Qualifying MessageStatus values |
|---|---|
| `sent` | Sent, Delivered, Opened, Clicked, Bounced, Undelivered (all rows) |
| `delivered` | Delivered, Opened, Clicked |
| `bounced` | Bounced |
| `undelivered` | Undelivered |
| `opens` | Opened |
| `clicks` | Clicked |

Derived rate formulas (computed in `computeRates()` after aggregation):

| Formula | Expression |
|---|---|
| Delivery Rate | `delivered / sent × 100` |
| Bounce Rate | `bounced / sent × 100` |
| Undelivered Rate | `undelivered / sent × 100` |
| Open Rate | `opens / delivered × 100` |
| Click Rate | `clicks / delivered × 100` |
| CTOR | `clicks / opens × 100` |

The three delivery-side rates (*delivered + bounced + undelivered*) sum to 100% by construction. Open and click rates use the delivered audience as denominator — not total sent — to reflect reachable contacts only.

### 3c. Capability Routing Map

All six metrics for all three channels currently route to `rest_fallback` (the Comm_Log DE via REST API). The `CAPABILITY_MAP` constant in the backend is the single source of truth for routing decisions and can be updated per metric/channel as requirements evolve.

> **Why not MCP for email opens/clicks?** Email opens and clicks are present as `MessageStatus` values in the Comm_Log DE, making the DE authoritative for all six metrics. Using a single source avoids a split query and a merge step, and eliminates any risk of count discrepancy between the two sources.

---

## 4. Backend Service

### 4a. Query Pipeline

Every query — whether originating from the chat agent or a dashboard API call — passes through the same pipeline:

1. **Parse** (`parseQuery()`) — validates and normalises the structured request, resolves relative date presets (defaults to `last_30d` when no range is specified), inherits missing fields from session state, derives `groupBy` (≤ 3 days → `"hour"`, else `"day"`), and applies the drill-level mismatch guard (message-level is auto-corrected to journey-level when span > 30 days).
2. **Route** (`planQuery()`) — consults `CAPABILITY_MAP` and groups metrics by backend. Currently all metrics go to `rest_fallback`.
3. **Fetch** (`fetchFromRestFallback()`) — issues a paginated `GET /data/v1/customobjectdata` query with a SFMC filter expression. Pages through 2,500-row batches until the result set is exhausted. The DE endpoint silently ignores `sentdate` filters, so date-range filtering is applied in-memory in the normaliser.
4. **Normalise** — two normaliser paths depending on query type:
   - `normalizeRestRows()` — groups raw DE rows into time-series `MetricBucket[]` objects keyed by day or hour ISO string. Counts rows per bucket by `MessageStatus` membership. Applies in-memory date range filter.
   - `normalizeMessageRows()` — groups the same raw rows by `MessageName`, producing a `MessageEntry[]` (one entry per distinct message, each with its own `MetricBucket[]`). Used by the Journey Detail screen to populate the message table. Results are sorted by total sent descending.
5. **Status filtering** (`filterByStatus()`) — applied to `MetricBucket[]` after normalisation when the dashboard's status filter pill is not `"all"`. Zeroes all metric columns except the selected status while preserving `sent` as the denominator for rate calculations.
6. **Rate calculation** (`computeRates()`) — adds the six derived rate fields to each bucket. Returns a new object; does not mutate the original.
7. **Session write** — stores the result in `SESSION_STORE` via `setSessionDetail()` and advances `viewState.updatedAt` so the dashboard's staleness guard triggers a re-render.

### 4b. Key Functions Reference

| Function | Signature | Purpose |
|---|---|---|
| `parseQuery(raw, inheritedState)` | → `{journeyId, channel, metrics, dateRange, groupBy, drillLevel}` | Validates and normalises a structured query. Defaults range to `last_30d` if not specified anywhere. |
| `computeRates(bucket)` | `MetricBucket` → `MetricBucket & rates` | Adds six derived rate fields. Returns new object; original is not mutated. Safe on zero denominators. |
| `filterByStatus(buckets, status)` | `(MetricBucket[], string)` → `MetricBucket[]` | Zeroes all columns except the selected status metric while preserving `sent`. Returns new array; original is not mutated. |
| `normalizeRestRows(rows, groupBy, dateRange?)` | `(Object[], string, Object?)` → `MetricBucket[]` | Groups raw DE rows into time-series buckets by day or hour. Applies in-memory date range filter. |
| `normalizeMessageRows(rows, groupBy, dateRange?)` | `(Object[], string, Object?)` → `MessageEntry[]` | Groups raw DE rows by `MessageName`. Each entry has `{id, name, channel, buckets[]}`. Sorted by total sent descending. Buckets include computed rates. |
| `parseSfmcDate(raw, groupBy)` | `(string, string)` → `string \| null` | Explicit SFMC date parser. Handles two confirmed formats — see §4c. |
| `patchSessionState(sessionId, patch, updatedBy?)` | → `{session, corrected}` | Merges patch fields into `viewState`. Applies drill-level mismatch guard. Stamps `updatedBy` and `updatedAt`. Initialises new session on first call. |
| `discoverJourneyNames(mcpTools)` | → `string[]` | Scans `MessageName` values, strips channel suffixes, returns up to 100 distinct stems. |
| `runQueryMessage(params, mcpTools)` | → `NormalizedResponse` | Journey-level query. Returns buckets + messages array (from `normalizeMessageRows`) for Journey Detail screen. |
| `runQueryOverview(journeyNames, params, mcpTools)` | → `JourneyEntry[]` | Fans out parallel queries to all discovered journeys. Stores results in `SESSION_STORE.journeys`. |

### 4c. Date Parsing — `parseSfmcDate()`

The SFMC REST API returns `Date` DE columns in different string formats depending on the channel and SFMC locale configuration. Both confirmed formats are handled by explicit regex matching — `new Date()` is never used because it guesses the format and produces wrong results on ambiguous strings.

> **Two confirmed date formats** — the parser handles both; falling back to ISO string detection as a tertiary path.

| Format | Example | Used by | Pattern |
|---|---|---|---|
| US locale (email rows) | `3/24/2025 11:45:00 AM` | Email, Push | `M/D/YYYY h:mm:ss AM/PM` |
| AU locale (SMS rows) | `22/08/2026, 5:03 am` | SMS | `DD/MM/YYYY, h:mm am/pm` (comma separator, no seconds) |
| ISO fallback | `2026-06-01T09:00:00` | Future API / test fixtures | Substring slice; no parsing needed |

AM/PM edge cases handled explicitly: 12 AM → hour 0 (midnight); 12 PM → hour 12 (noon); 1 PM → hour 13.

Rows with unparseable dates are silently dropped from the bucket output (they do not contribute to any count).

### 4d. Journey Discovery

`discoverJourneyNames()` scans `MessageName` values in the DE, strips channel suffixes (`_Email`, `_SMS`, `_Push`, and space-prefixed variants), and returns up to 100 distinct stems. This is the entry point for overview queries where the user has not specified a journey.

> **Why MessageName, not JourneyName?** SMS rows in the Comm_Log DE do not populate the `JourneyName` field. Using `MessageName` stem as the universal journey identifier ensures SMS journeys appear in overview results alongside email journeys. The stem function `messageNameStem()` strips the trailing `_Email` / `_SMS` / `_Push` suffix to produce a canonical name.

The DE filter uses OR-chained `messagename eq` clauses covering all known suffix variants so the server-side query returns all rows for a journey regardless of which channel sent them.

### 4e. Session Store

An in-memory `Map` (`SESSION_STORE`) keyed by UUID session ID. Each entry holds: `viewState` (the canonical state object), `journeys` (populated by `runQueryOverview()`), and `detail` (the last `NormalizedResponse` from a drill query, which includes both `buckets` and `messages`). This is a local-process construct — it resets on server restart and cannot be shared across multiple processes or hosts. See §11 for the persistence requirement.

### 4f. SFMC Authentication

`server.js` implements a client-credentials OAuth2 token cache. The token is fetched on the first authenticated request, then reused until 5 minutes before its expiry. Credentials are read from environment variables (`SFMC_CLIENT_ID`, `SFMC_CLIENT_SECRET`, `SFMC_AUTH_URL`, `SFMC_BASE_URL`, `COMMS_DE_KEY`).

---

## 5. Conversational Agent

### Entry Point

`handleUserMessage(userMessage, sessionId, mcpTools, options)` is the single public interface of the agent layer. It is called by the IBM Bob tool/prompt wrapper with the user's raw text and the available MCP tool set. It returns `{ text, handoffOffer, sessionId }`.

### Intent Classification

The lightweight parser (`parseIntent()`) classifies each message into one of four types:

| Intent Type | Trigger | Action |
|---|---|---|
| `journey_query` | A named journey is identified in the text | Run `runQueryMessage()` for that journey; format chat reply; offer dashboard handoff |
| `overview_query` | Keywords: *all journeys, compare, worst, best, ranking, overview, summary, which journey* | Discover journey names; run `runQueryOverview()`; format ranked table; offer handoff |
| `confirm_handoff` | Affirmative one-word responses: *yes, sure, ok, go ahead…* | Apply pending `targetState` patch to session; acknowledge in chat |
| `unknown` | Anything else | Return guided help text; no state mutation |

### Handoff Protocol

The agent *never* silently mutates session state. After answering a query, it stores a pending `handoff_offer` object in `PENDING_HANDOFFS` (an in-memory `Map`) keyed by session ID. The offer is returned in the response as `handoffOffer` — the calling surface renders it as a confirmation prompt. Only when the user confirms (or `dashboardActive: true` is passed for in-context updates) does the agent call `patchSessionState()`.

### Context Inheritance

On every turn the agent calls `getSessionState()` before parsing the query. This means partial queries — "actually show me SMS instead" or "extend to last 30 days" — automatically inherit journey, date range, and drill level from the prior turn without the user restating them.

---

## 6. Dashboard

### Screen Structure

| Screen | drillLevel | Content |
|---|---|---|
| Overview | `overview` | Global KPI tiles (total sent, delivery rate, bounce rate, period-over-period delta). Sortable journey table with per-row trend sparklines. All columns sortable: `deliveryRate`, `sent`, `bounceRate`, `openRate`, `clickRate`, `ctor`, `undeliveredRate`. |
| Journey Detail | `journey` | Header with journey name, date range, channel tabs. Area chart for metric trend. Status breakdown bar. Sortable message table (one row per `MessageName` stem × channel). |
| Message Detail | `message` | Hourly or daily trend for a single message. Full status donut/bar. Bucket-level table. CSV export of all time series. |

### Global Filters

A persistent filter bar across all three screens controls: date range (preset pills + custom date inputs), channel toggle (all / email / SMS / push), and status filter pills (all / delivered / bounced / undelivered / opened / clicked). Filter changes call `PATCH /session/:id/state` and trigger a data re-fetch.

### Polling & Staleness Guard

The dashboard polls `GET /session/:id/state` every 15 seconds. If the returned `updatedAt` is newer than its locally cached value, it re-fetches the relevant data endpoint for the current drill level. This replaces the SSE/WebSocket approach that was considered and dropped (the agent and dashboard are never simultaneously live in a way that requires server push).

### Current Runtime Constraints

- JSX is transpiled at runtime by Babel Standalone (loaded from unpkg CDN). This is appropriate for prototyping but is not suitable for production (adds ~2 MB of Babel JS, slow initial compile on low-end devices).
- React, ReactDOM, Recharts, Lucide, and prop-types are loaded from unpkg CDN UMD bundles — no tree-shaking, no cache control beyond CDN defaults.
- No minification, code splitting, or bundle integrity hashes (`integrity` SRI attributes).

---

## 7. Session State & Chat↔Dashboard Handoff

### Canonical viewState Schema

```json
{
  "sessionId":  "uuid",
  "viewState": {
    "journeyId":  "string | null",
    "channel":    "email|sms|push|all",
    "dateRange":  { "start": "ISO8601", "end": "ISO8601", "preset": "last_30d|custom" },
    "status":     "all|delivered|bounced|undelivered|opened|clicked",
    "drillLevel": "overview|journey|message",
    "messageId":  "string | null",
    "sortBy":     "deliveryRate|sent|bounceRate|openRate|clickRate|ctor|undeliveredRate",
    "updatedBy":  "agent|dashboard",
    "updatedAt":  "ISO8601"
  }
}
```

### Validation Rules

- **Last-write-wins:** the most recent PATCH wins regardless of source.
- **Drill-level mismatch guard:** if `drillLevel === "message"` and the date span > 30 days, the PATCH handler auto-corrects `drillLevel` to `"journey"` and sets `corrected: true` in the response. The calling surface should surface this correction to the user.
- **Explicit user input overrides state:** channel/journey changes from a typed message update only the stated fields; all other viewState fields persist.

### Session ID Resolution (Dashboard)

Priority order: (1) `?session=` URL parameter, (2) `localStorage["hr_session_id"]`, (3) newly generated `crypto.randomUUID()`. The resolved ID is written back to both localStorage and the URL so it survives reload and can be shared via URL.

---

## 8. API Reference

| Method | Path | Purpose | Key Request Fields |
|---|---|---|---|
| GET | `/session/:id/state` | Read full session state | — |
| PATCH | `/session/:id/state` | Partial viewState update. Returns corrected state and `corrected` boolean. | `patch` (viewState fields), `updatedBy` |
| POST | `/api/overview` | Populate journey index for Overview screen. Runs discovery + parallel journey queries. Returns `journeys` array and discovered `journeyNames`. | `sessionId`, `journeyNames?`, `dateRange?` |
| POST | `/api/query` | Journey-level drill. Runs `runQueryMessage()`. Writes detail to session. | `sessionId`, `journeyId`, `channel?`, `range?` |
| POST | `/api/query/message` | Message-level drill. Scoped to a single `MessageName` stem. | `sessionId`, `journeyId`, `messageId?` |

All endpoints return `{ code, message }` on validation errors (400) and `{ error: "Internal error" }` on 500s (no stack trace or system detail is exposed to the client).

---

## 9. Test Suite

Both backend logic layers have a full unit + integration test suite run with Node's built-in test runner (`node:test` + `assert/strict`). No external test framework is required.

```bash
# Run backend tests
node --test Headless_Reporting_Agent_Backend.test.js

# Run agent tests
node --test Headless_Reporting_Agent.test.js
```

### Backend Test Coverage (`Headless_Reporting_Agent_Backend.test.js`)

| Suite | Tests | What is covered |
|---|---|---|
| `computeRates()` | 5 | Correct calculation of all 6 rate fields; zero-denominator safety; non-mutation of original; field preservation. |
| `filterByStatus()` | 7 | Status `"all"` passthrough; zeroing of non-selected columns; `sent` preserved as denominator for all statuses; non-mutation of input. |
| `parseQuery()` | 12 | Missing journey error (`MISSING_JOURNEY`); journeyId from raw and inherited state; default and supplied metrics; relative range resolution (`last_7d`, `last_30d`); explicit `dateRange` object; `groupBy` derivation; default channel; channel inheritance. |
| `normalizeRestRows()` | 13 | Empty input; null/unparseable dates discarded; day grouping; hour grouping; `Sent` / `Delivered` / `Opened` / `Clicked` / `Bounced` / `Undelivered` status counting; sort order; AM/PM edge cases (noon, midnight); ISO fallback; **SMS AU-locale date format** (`DD/MM/YYYY, h:mm am/pm`) for both day and hour groupBy. |
| `patchSessionState()` | 6 | No correction when span ≤ 30 days at message level; correction to journey level when span > 30 days; no correction for journey/overview drill levels; field merge without overwrite; `updatedBy` / `updatedAt` stamping; first-call initialisation. |
| `normalizeMessageRows()` | 8 | Empty input; grouping by `MessageName`; `id` / `name` / `channel` / `buckets` fields present; channel lower-cased; per-message metric isolation (no cross-contamination); sort by total sent descending; `"(unnamed)"` fallback for missing `MessageName`; computed rate fields present in buckets. |

### Agent Test Coverage (`Headless_Reporting_Agent.test.js`)

| Suite | Tests | What is covered |
|---|---|---|
| `parseIntent()` | 17 | Intent classification for all four types (`confirm_handoff`, `overview_query`, `journey_query`, `unknown`); channel extraction (email, sms, push, default all); range extraction (last_7d, last_30d, this_month, null); metric hint extraction; journey name extraction from quoted strings, "for X journey", and "how did X perform" patterns; no duplicate metrics. |
| `sumBuckets()` | 3 | Summing all six metric fields; computed rates on totals; empty array graceful handling. |
| `formatJourneyResponse()` | 5 | Journey name present; key metrics included; opens/clicks omitted for SMS; no-data message; date range included. |
| `formatOverviewResponse()` | 5 | No-data message; journey names present; markdown table header; date range; sorted by delivery rate descending. |
| `buildJourneyHandoff()` | 6 | `type='handoff_offer'`; `confirmationRequired=true`; journey name in message; `targetState` fields; drill-correction note and `drillLevel='journey'` when `drillCorrected=true`. |
| `buildOverviewHandoff()` | 4 | `type='handoff_offer'` with `drillLevel='overview'`; `confirmationRequired=true`; channel propagation; default channel. |
| `resolveRange()` | 4 | Preset key resolution; explicit `dateRange` object passthrough; viewState fallback; default to last 30 days. |
| `handleUserMessage()` — integration | 12 | New session creation; sessionId echo; non-empty text; journey name in reply; handoff offer present; `dashboardActive` suppresses offer; confirm handoff commits + clears pending; no-pending graceful handling; unknown query guidance; `MISSING_JOURNEY` path; overview table from DE data; messages array populated in session detail after journey query. |

> ✅ **All tests pass — 114 total (58 backend + 56 agent)**  
> Both test files pass fully under `node --test`. No external packages are required beyond Node ≥ 18 built-ins.

---

## 10. Local Dependencies (What Is Not Yet Portable)

The following items are hard or soft dependencies on the local development environment or on IBM Bob. Each must be resolved before the solution can run in any other environment.

---

**IBM Bob / Bob Agent Platform** — 🔴 Hard

- **What it provides:** The MCP server (`SFMC_MCP`) that exposes `sfmc_query_data_extension_rows` and other SFMC tools as callable functions within the Bob conversation context. When running inside Bob, the agent passes these MCP tools directly to the backend.
- **Why it's a blocker:** The chat agent layer (`Headless_Reporting_Agent.js`) requires an `mcpTools` object to be injected by a calling context. Outside Bob, this is provided by the `server.js` MCP shim — but that shim only replicates `sfmc_query_data_extension_rows`. Any future query path that uses other MCP tools (e.g. `sfmc_get_journeys` for journey name discovery) has no equivalent outside Bob.
- **Mitigation in place:** `server.js` implements a standalone REST shim for `sfmc_query_data_extension_rows`. The server runs fully without Bob for all currently implemented query paths.

---

**Local process hosting** — 🔴 Hard

- **What it provides:** `node server.js` on the developer's machine, listening on `127.0.0.1:3000`.
- **Why it's a blocker:** The server binds to loopback only. The session store is in-memory and does not persist across restarts. There is no process manager, health check, or restart policy. Any other user, service, or deployment cannot reach this server.
- **Mitigation in place:** None — this is intentional for a local prototype.

---

**In-memory session store** — 🔴 Hard

- **What it provides:** `SESSION_STORE` — a Node.js `Map` held in process memory.
- **Why it's a blocker:** State is lost on any server restart, deployment, or crash. A multi-process deployment (load balancer, multiple replicas) would route requests to different session states. There is no TTL — sessions accumulate until the process is restarted.
- **Mitigation in place:** None required for single-user local use.

---

**SFMC credentials in environment** — 🟡 Soft

- **What it provides:** `SFMC_CLIENT_ID`, `SFMC_CLIENT_SECRET`, `SFMC_AUTH_URL`, `SFMC_BASE_URL` loaded via `dotenv` from a `.env` file on the local filesystem.
- **Why it matters:** A `.env` file in the project root is not a production secret-management pattern. If committed to version control it exposes credentials. The server handles missing credentials gracefully (returns empty results), but does not block startup with a clear error.
- **Mitigation in place:** dotenv is only used at startup; the code reads from `process.env`. Migrating to a secrets manager requires only changing the injection mechanism, not the code.

---

**Runtime Babel transpile of JSX** — 🟡 Soft

- **What it provides:** `@babel/standalone` loaded from unpkg CDN; transpiles `Headless_Reporting_Dashboard.jsx` on every page load in the browser.
- **Why it matters:** ~2 MB additional download, ~300–800 ms compile time per page load on average hardware. CDN availability dependency. No SRI hash on the CDN scripts (supply-chain risk). Not acceptable for production performance or security posture.
- **Mitigation in place:** None — explicitly noted in `index.html` as "prototype use only".

---

**CDN-sourced frontend dependencies** — 🟡 Soft

- **What it provides:** React 18, ReactDOM, Recharts 2, Lucide React, prop-types — all loaded from `unpkg.com` UMD bundles.
- **Why it matters:** No Subresource Integrity (SRI) hashes, no pinned versions beyond the semver range, runtime CDN dependency, no tree-shaking (full library bundles), no offline capability.
- **Mitigation in place:** None — acceptable for local development only.

---

**Permissive CORS policy** — 🟡 Soft

- **What it provides:** `app.use(cors())` — allows all origins, all methods, all headers.
- **Why it matters:** Appropriate for local development where the dashboard and API are same-origin. In production, any deployment where the dashboard is hosted separately (e.g. CDN) from the API requires an explicit origin allowlist.
- **Mitigation in place:** Service binds to `127.0.0.1` which limits exposure to localhost only.

---

**No dashboard authentication** — 🔴 Hard (for production)

- **What it provides:** None — anyone who can reach the server URL and knows (or guesses) a session ID can read that session's data.
- **Why it matters:** The dashboard displays communications data about AusNet customers. Unauthenticated access is not acceptable beyond a developer's localhost.
- **Mitigation in place:** Network boundary (loopback only). No mitigation suitable for production.

---

## 11. Productionisation Requirements

The following work items must be completed before this solution can be deployed to any environment accessible beyond the developer's machine. Items are grouped by priority.

### P0 — Blocking (Must Have Before Any Deployment)

#### 1. Backend Hosting Decision

Choose a hosting target. The backend is a standard Node.js Express application with no build step — it can run on any of the following:

| Option | Fit | Notes |
|---|---|---|
| Containerised service (Docker + Kubernetes / ECS) | Best for enterprise | Full control; add a process manager (PM2 or the container restart policy); horizontal scaling requires external session store (see item 2) |
| Serverless function (AWS Lambda, Azure Functions, Cloudflare Workers) | Good for low-traffic admin tooling | In-memory session store is per-invocation — external store **required**; cold-start latency on infrequent use; Cloudflare Workers requires removing Node-specific APIs |
| PaaS (Heroku, Railway, Render) | Simplest path | Works with minimal changes; external session store still needed for multi-dyno setups |

The existing bind of `127.0.0.1` in `server.js` must be changed to an explicit interface or removed (to let the platform bind correctly) before deployment.

#### 2. External Session Store

Replace the in-memory `SESSION_STORE` `Map` with a persistent, shared store. The interface is minimal — only `get`, `set` operations on a string key.

- **Redis** (Azure Cache for Redis, AWS ElastiCache, Upstash for serverless) — recommended. Add TTL of 24h per session. Requires adding the `ioredis` or `@upstash/redis` package and replacing the three lines in `getSessionState` / `SESSION_STORE.set()`.
- **DynamoDB / Cosmos DB / Firestore** — viable for serverless. Slightly higher latency per read/write than Redis.

#### 3. Authentication & Authorisation

The dashboard and all API endpoints must be protected before deployment. Recommended approach:

- Integrate with AusNet's existing IdP (Azure AD / Entra ID) via OpenID Connect. Use `passport-azure-ad` (OIDC strategy) as Express middleware on all routes.
- Enforce MFA at the IdP level — this requires no application-level code change if the IdP conditional access policy requires it.
- The session cookie should be set with `Secure`, `HttpOnly`, and `SameSite=Strict` flags.
- Role-based access: read-only access to deliverability data is likely appropriate for a broad analyst group; no write access to SFMC data is possible through this application.

#### 4. SFMC Credential Management

Remove the `.env` file pattern. Inject credentials via the hosting platform's secret management:

- Azure: Azure Key Vault with Managed Identity (no code change required — the existing `process.env` reads stay; the platform injects secrets as env vars).
- AWS: Secrets Manager or Parameter Store via environment variable injection in the task definition.
- Ensure the SFMC installed package has the minimum required scope: **Data Extensions → Read** only. No write scopes are needed by this application.

#### 5. TLS / HTTPS

All traffic to the service must be over TLS 1.2+. In practice this is handled by the load balancer or ingress layer — the Node application itself does not need to terminate TLS. Ensure the CDN / load balancer certificate is valid and not self-signed.

### P1 — Required for Production Quality

#### 6. Frontend Build Pipeline

Replace runtime Babel + CDN UMD bundles with a proper build step:

1. Add a build tool: **Vite** is the simplest choice (zero-config JSX + React support, excellent tree-shaking). Add `vite`, `@vitejs/plugin-react` to devDependencies.
2. Add explicit package dependencies: `react`, `react-dom`, `recharts`, `lucide-react`.
3. Remove the CDN `<script>` tags from `index.html` and replace with Vite's injected bundle references.
4. Output to a `dist/` directory. Point `express.static()` at `dist/` or serve from a CDN with cache headers.
5. Add SRI hashes to any remaining external resources.

#### 7. CORS Hardening

Replace `cors()` with an explicit origin allowlist:

```js
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") ?? [],
  credentials: true,
}));
```

#### 8. Structured Logging

Replace `console.log` / `console.error` calls with a structured logger (e.g. `pino`). Ensure no sensitive data (SFMC tokens, subscriber keys, email addresses) appears in log output. Set log level via environment variable. Route logs to the platform's log aggregator (CloudWatch, Azure Monitor, etc.).

#### 9. Health & Readiness Endpoints

Add `GET /health` (liveness) and `GET /ready` (readiness — confirms SFMC token is obtainable and session store is reachable). Required by Kubernetes probes, load balancer health checks, and monitoring.

#### 10. Rate Limiting & Request Validation

Add `express-rate-limit` on the query endpoints (`/api/overview`, `/api/query`, `/api/query/message`) to prevent accidental or deliberate DE over-querying. Each overview query can fan out to 100+ parallel DE page reads — a tight rate limit (e.g. 5 req/min per authenticated user) is appropriate.

### P2 — Dashboard Completeness

#### 11. Remove Seeded Mock Data

The Overview screen currently falls back to seeded mock journey data when no real data is available in the session. This fallback should be removed or gated behind a clearly visible "demo mode" indicator. The real data path (`POST /api/overview` → `runQueryOverview()`) is fully implemented; the dashboard needs to call it on initial load and on date-range changes.

#### 12. Error States & Empty States

Add explicit UI states for: (a) SFMC query error (network failure, token expired), (b) no data for the selected filter combination, (c) partial data (some journeys returned no results in the window). The `EmptyState` component exists in the dashboard but is not wired to all failure paths.

#### 13. SMS Undelivered Reason Breakdown

The DE includes `smsUndeliveredStatus` and `smsUndeliveredReason` fields which are currently not surfaced in the dashboard. These are high-value for SMS debugging and should be added as a secondary breakdown table on the Message Detail screen for SMS channel queries.

### P3 — Optional / Future

#### 14. Bob Integration Wrapper

For the chat agent to run within Bob, a thin Bob tool or prompt must call `handleUserMessage()` and pass the available MCP tools. This wrapper is not yet written. It requires: importing `Headless_Reporting_Agent.js` as a module (or copying the logic into a Bob script), passing `sfmc_query_data_extension_rows` from the Bob MCP tool context, and returning the `text` and `handoffOffer` to the Bob response.

#### 15. Dashboard URL Sharing

The `?session=` URL parameter already enables session sharing. To make this useful, the session link should deep-link to the current drill level and filters. This requires encoding the full `viewState` in the URL (as base64 or individual params) rather than just the session ID.

#### 16. Rollup Data Extension

The spec recommends a pre-aggregated `journey × channel × day` rollup DE for Overview and trend queries, built by a scheduled SQL Query Activity. The current implementation queries the raw Comm_Log DE for all views, which works but is slower and more DE-quota-intensive for large date ranges. Implementing the rollup DE would improve Overview load time significantly.

---

## 12. Open Items & Known Gaps

| Item | Status | Blocking? |
|---|---|---|
| Dashboard hosting decision (standalone web app vs. embed) | ⚠️ Open | Yes — affects auth integration and CORS config |
| Dashboard real-data layer: replace mock data with session-state buckets | ⚠️ Partially done | Yes — mock fallback must be removed before production |
| Bob integration wrapper (calling `handleUserMessage` from Bob tool/prompt) | ⚠️ Open | Yes — required for chat agent to function in Bob |
| External session store (Redis or equivalent) | ⚠️ Open | Yes — in-memory store is not production-safe |
| Authentication (OIDC / Azure AD) | ⚠️ Open | Yes — unauthenticated access to customer comms data is not acceptable |
| Frontend build pipeline (replace runtime Babel) | ⚠️ Open | Yes — performance and supply-chain risk |
| SMS undelivered reason breakdown in dashboard | ⚠️ Open | No — enhancement |
| Rollup DE for overview queries | ⚠️ Open | No — performance optimisation only |
| DE field names and types confirmed from Comm_Log_Schema.csv | ✅ Resolved | — |
| MessageStatus exhaustive value set confirmed | ✅ Resolved | — |
| SentDate US-locale format confirmed and explicit parser implemented | ✅ Resolved | — |
| SentDate AU-locale SMS format (`DD/MM/YYYY, h:mm am/pm`) confirmed and parser extended | ✅ Resolved | — |
| All metrics routed to Comm_Log DE (no MCP split needed) | ✅ Resolved | — |
| SSE / WebSocket requirement (dropped — polling is sufficient) | ✅ Resolved — dropped | — |
| Metric formulas confirmed and locked in code | ✅ Resolved | — |
| Status filter pill wired across all three screens | ✅ Resolved | — |
| `normalizeMessageRows()` implemented for Journey Detail message table | ✅ Resolved | — |
| `filterByStatus()` implemented for status-pill filtering of bucket data | ✅ Resolved | — |
| Journey discovery uses `MessageName` stem (not `JourneyName`) — SMS fix | ✅ Resolved | — |
| Full unit + integration test suite for backend and agent layers | ✅ Resolved | — |
| `parseQuery()` defaults to `last_30d` when no range is specified | ✅ Resolved | — |
| Agent test suite completed — 56 tests across 8 suites (`parseIntent`, `sumBuckets`, `formatJourneyResponse`, `formatOverviewResponse`, `buildJourneyHandoff`, `buildOverviewHandoff`, `resolveRange`, `handleUserMessage` integration) | ✅ Resolved | — |
| `parseIntent()` suite count corrected from 15 to 17 tests; `handleUserMessage()` integration suite corrected from 10 to 12 tests; total test count updated to 114 | ✅ Resolved | — |
| E2E demo preparation guide created (`e2e-demo-preparation-guide.html`) — environment checklist, env-var reference, 15–20 min demo script with say/show columns | ✅ Resolved | — |
| Handover summary artefact created (`headless-reporting-handover-summary.html`) — one-page stakeholder-facing overview of what is real, what is stubbed, and next steps | ✅ Resolved | — |

---

*Made with IBM Bob*
