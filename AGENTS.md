# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

This is a working prototype with a live SFMC connection. Key files:

| File | Purpose |
|---|---|
| `Headless_Reporting_Agent_Spec.md` | Canonical architecture spec — authoritative source of truth |
| `Headless_Reporting_Agent_Backend.js` | Express backend — query logic, session state, DE access |
| `Headless_Reporting_Dashboard.jsx` | React dashboard UI — connected to live backend API |
| `Headless_Reporting_Agent.js` | Agent entry point for use inside Bob |
| `server.js` | Express entry point — routes, OAuth token cache, MCP tool shim |
| `index.html` | Dashboard HTML shell |
| `package.json` | Dependencies (express, cors, dotenv). Run with `npm start`. |
| `Comm_Log_Schema.csv` | Confirmed DE field names and types |

Start the server with `npm start` (or `npm run dev` for watch mode). Dashboard at `http://127.0.0.1:3000/index.html`.

---

## Architecture: All metrics via REST

All metrics — email, SMS, and push — route through `fetchFromRestFallback()`, which calls `sfmc_query_data_extension_rows` against the `Comm_Log` DE. The `CAPABILITY_MAP` / MCP path is not used in practice; treat `fetchFromRestFallback()` as the sole data path.

Never try MCP first and fall back reactively. All DE queries go direct to REST.

---

## State Schema (Chat ↔ Dashboard)

The canonical `viewState` object (spec Section 5.1) drives both surfaces:

```json
{
  "sessionId": "...",
  "viewState": {
    "journeyId": "jrny_4471 | null",
    "channel": "email | sms | push | all",
    "dateRange": { "start": "ISO8601", "end": "ISO8601", "preset": "last_30d | custom" },
    "drillLevel": "overview | journey | message",
    "messageId": "msg_9012 | null",
    "updatedBy": "agent | dashboard"
  }
}
```

**Drill-level mismatch guard:** if `dateRange` span > 30 days and `drillLevel` is `"message"`, auto-correct `drillLevel` up to `"journey"`. This is enforced in `parseQuery()` and must also be enforced in the PATCH handler.

---

## Dashboard Design Tokens

Defined at top of `Headless_Reporting_Dashboard.jsx` — use these constants, do not introduce new colours:

| Token | Hex | Meaning |
|---|---|---|
| `SIGNAL` | `#16C784` | Delivered / healthy |
| `WARN` | `#F5A623` | Pending / degraded |
| `CRIT` | `#E5484D` | Bounced / failed |
| `ACCENT` | `#3B6FE0` | Links / active states |
| `INK` / `TEXT` | `#0B1220` | Primary text |

Fonts: `Space Grotesk` (display/headings), `Inter` (body), `IBM Plex Mono` (data/numbers).

---

## Agent Handoff Rule

Agent must **propose** a dashboard handoff and wait for user confirmation before the first `PATCH /session/{id}/state` in a conversation. Silent state mutation is forbidden. Exception: obvious in-context updates when the dashboard is already active (spec Section 6).

---

## Data Aggregation Pattern

Raw DE rows are for drill-down only. Journey × channel × day rollup DEs (built by a scheduled SQL Query Activity, hourly) should be queried for all overview and trend screens. Do not query raw rows for top-level KPIs.

---

## Open / Unresolved Items

- **Dashboard hosting** — decide standalone web app vs. embed (affects URL param strategy).
