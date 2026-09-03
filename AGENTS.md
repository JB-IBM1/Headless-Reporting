# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

This is a **prototype / design artefact** — not a production app with a build pipeline. There are exactly four files:

| File | Purpose |
|---|---|
| `Headless_Reporting_Agent_Spec.md` | Canonical architecture spec — authoritative source of truth |
| `Headless_Reporting_Agent_Backend.js` | Backend skeleton (Node/Express or serverless) |
| `Headless_Reporting_Dashboard.jsx` | React dashboard UI prototype |
| `Solution-Doc.docx` | One-page summary of what is and is not yet real |

No `package.json`, no build system, no test runner. All commands are manual.

---

## Critical Stubs — Do Not Treat as Implemented

The following functions in `Headless_Reporting_Agent_Backend.js` are **intentionally empty** — wiring them up requires confirmed DE field names first:

- `fetchFromMCP()` — no real MCP tool call
- `fetchFromRestFallback()` — no SFMC REST auth or DE query
- `normalizeMcpRow()` / `normalizeRestRow()` — field names (`sentCount`, `SentCount`, etc.) are **guesses**, not confirmed DE columns
- `parseSfmcDate()` — uses `new Date(raw)` which is unreliable for SFMC DE date formats (known issue, flagged in code)
- `getSessionState()` — no state store; returns `{}`

---

## Architecture: MCP vs REST Fallback

The `CAPABILITY_MAP` in `Headless_Reporting_Agent_Backend.js` is the single source of truth for routing:

- **Email + Push:** MCP handles all metrics
- **SMS:** ALL metrics route to `rest_fallback` — MCP does not support SMS delivery data

Never try MCP first and fall back reactively. The map decides upfront.

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

- Real DE field names and types (blocks normalizer implementation)
- Backend hosting decision (serverless vs small service)
- Dashboard hosting decision (Cloud Pages ruled out; GitHub Pages set aside)
- `parseSfmcDate()` needs a format-aware parser (e.g. `date-fns/parse`) once actual DE date format is confirmed
