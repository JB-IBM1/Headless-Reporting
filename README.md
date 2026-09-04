# SFMC Headless Reporting Agent

A headless agent and interactive dashboard for querying Salesforce Marketing Cloud (SFMC) deliverability data. Users interact conversationally (via Bob/chat) or visually (dashboard UI), with both surfaces sharing session state so either can hand off to the other mid-task.

---

## Solutions in this repository

This repository contains the **localhost Express backend** solution. For the Salesforce-hosted UIBundle version, see `sfmc-headless-reporting-sf`.

---

## What it does

- **Conversational queries** — ask in natural language: *"How did the Welcome journey perform last week?"*, *"What was the SMS bounce rate for X in March?"*, *"Compare email vs SMS for Y this month."*
- **Interactive dashboard** — three-level drill-down: Overview → Journey → Message, with filters for date range, channel, and status.
- **Shared state** — agent and dashboard stay in sync via a session state store; either surface can hand off context to the other without re-prompting the user.
- **SFMC data** — reads from a centralised `Comm_Log` Data Extension via the SFMC REST API.

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
                                                              ▼ SFMC REST API
                                                   ┌──────────────────────────┐
                                                   │  SFMC Comm_Log DE        │
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
| `HANDOVER_APEX_MIGRATION.md` | Bridge document: migration path to Apex REST for Salesforce-hosted version |
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

Create a `.env` file in the project root (**never commit this file**):

```env
SFMC_BASE_URL=https://XXXX.rest.marketingcloudapis.com
SFMC_AUTH_URL=https://XXXX.auth.marketingcloudapis.com
SFMC_CLIENT_ID=your-client-id
SFMC_CLIENT_SECRET=your-client-secret

# External key (UUID) of the Comm_Log Data Extension
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

Server starts at `http://127.0.0.1:3000`.
Dashboard: `http://127.0.0.1:3000/index.html`

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/query` | Journey-level metric query |
| `POST` | `/api/query/message` | Message-level drill-down |
| `POST` | `/api/query/failures` | Individual bounced/undelivered records |
| `POST` | `/api/overview` | Populate journey index for the Overview screen |
| `GET` | `/session/:id/state` | Read current session view state |
| `PATCH` | `/session/:id/state` | Partial update to session view state |

### Example

```powershell
Invoke-RestMethod -Method POST -Uri 'http://127.0.0.1:3000/api/query' `
  -ContentType 'application/json' `
  -Body '{"sessionId":"demo-session","journeyId":"Welcome","channel":"email","range":"last_7d"}'
```

---

## Running tests

```bash
node --experimental-vm-modules node_modules/.bin/jest
```

---

## Related repositories

| Repository | Purpose |
|---|---|
| `sfmc-headless-reporting-sf` | Salesforce UIBundle version (React + Vite, deployed via SFDX, Apex REST backend) |
