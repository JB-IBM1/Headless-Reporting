# SFMC Headless Reporting Agent

A headless agent and interactive dashboard for querying Salesforce Marketing Cloud (SFMC) deliverability data. Users interact conversationally (chat) or visually (dashboard), and the two surfaces share state so either can hand off to the other mid-task.

---

## What it does

- **Conversational queries** — ask in natural language: *"How did the Welcome journey perform last week?"*, *"What was the SMS bounce rate for X in March?"*, *"Compare email vs SMS for Y this month."*
- **Interactive dashboard** — three-level drill-down: Overview → Journey → Message, with persistent filters for date range, channel, and status.
- **Shared state** — agent and dashboard stay in sync via a session state store; either surface can hand off context to the other without re-prompting the user.
- **SFMC data** — reads from a centralised `Comm_Log` Data Extension (refreshed by a scheduled SQL Query Activity) using the SFMC REST API.

---

## Architecture

```
┌─────────────────┐        POST /api/query        ┌──────────────────────────┐
│   Bob / Chat    │ ─────────────────────────────► │                          │
│   (agent)       │                                │  Express backend         │
│                 │ ◄───────────────────────────── │  (server.js +            │
└─────────────────┘        NormalizedResponse      │   Backend.js)            │
                                                   │                          │
┌─────────────────┐        GET/PATCH session       │                          │
│   Dashboard     │ ◄────────────────────────────► │                          │
│   (index.html + │                                │                          │
│   Dashboard.jsx)│        POST /api/overview      │                          │
└─────────────────┘ ─────────────────────────────► └──────────┬───────────────┘
                                                              │
                                                              ▼ REST API
                                                   ┌──────────────────────────┐
                                                   │  SFMC                    │
                                                   │  Comm_Log DE             │
                                                   └──────────────────────────┘
```

### Key files

| File | Purpose |
|---|---|
| `server.js` | Express entry point — routes, SFMC OAuth token cache, MCP tool shim |
| `Headless_Reporting_Agent_Backend.js` | All query logic — DE filtering, date parsing, metric computation, session state |
| `Headless_Reporting_Dashboard.jsx` | React dashboard UI (rendered client-side via CDN Babel) |
| `Headless_Reporting_Agent.js` | Agent entry point for use inside Bob |
| `Headless_Reporting_Agent_Spec.md` | Full architecture specification — authoritative source of truth |
| `Comm_Log_Schema.csv` | Confirmed DE field names and types |
| `index.html` | Dashboard HTML shell |

---

## Getting started

### Prerequisites

- Node.js >= 18
- An SFMC installed package with **Data Extensions → Read** scope
- The `Comm_Log` Data Extension populated by its scheduled SQL Query Activity

### Install

```bash
npm install
```

### Configure

Create a `.env` file in the project root (this file must **not** be committed):

```env
SFMC_BASE_URL=https://XXXX.rest.marketingcloudapis.com
SFMC_AUTH_URL=https://XXXX.auth.marketingcloudapis.com
SFMC_CLIENT_ID=your-client-id
SFMC_CLIENT_SECRET=your-client-secret

# External key (UUID) of the Comm_Log Data Extension
# Defaults to the value hard-coded in the backend if omitted
COMMS_DE_KEY=69C7427F-DC32-4114-ADB3-5D73DE282B8B

PORT=3000
```

### Run

```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

The server starts at `http://127.0.0.1:3000`.  
Dashboard: `http://127.0.0.1:3000/index.html`

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/query` | Journey-level metric query. Body: `{ sessionId, journeyId, channel, range }` |
| `POST` | `/api/query/message` | Message-level drill-down. Body: `{ sessionId, journeyId, messageId }` |
| `POST` | `/api/query/failures` | Individual bounced/undelivered records for a message |
| `POST` | `/api/overview` | Populate journey index for the Overview screen |
| `GET` | `/session/:id/state` | Read current session view state |
| `PATCH` | `/session/:id/state` | Partial update to session view state |

### Example query

```powershell
Invoke-RestMethod -Method POST -Uri 'http://127.0.0.1:3000/api/query' `
  -ContentType 'application/json' `
  -Body '{"sessionId":"demo-session","journeyId":"Welcome","channel":"email","range":"last_7d"}'
```

---

## Metrics

All metrics are derived from the `Comm_Log` DE `MessageStatus` field.

| Metric | Formula |
|---|---|
| Delivery rate | `delivered / sent × 100` |
| Bounce rate | `bounced / sent × 100` |
| Undelivered rate | `undelivered / sent × 100` |
| Open rate | `opens / delivered × 100` |
| Click rate | `clicks / delivered × 100` |
| CTOR | `clicks / opens × 100` |

Valid `MessageStatus` values: `Sent`, `Delivered`, `Opened`, `Clicked`, `Bounced`, `Undelivered`.

---

## Running the tests

```bash
node --experimental-vm-modules node_modules/.bin/jest
```

Or individually:

```bash
node Headless_Reporting_Agent_Backend.test.js
node Headless_Reporting_Agent.test.js
```

---

## Status

This is a **working prototype with a live SFMC connection**. The dashboard queries the `Comm_Log` DE in real time via the backend — no mock or seeded data is used.

The one remaining open item is **dashboard hosting** (standalone web app vs. embed). Everything else is implemented.

See [`Headless_Reporting_Agent_Spec.md`](Headless_Reporting_Agent_Spec.md) § 8 for the full resolved/open items list.
