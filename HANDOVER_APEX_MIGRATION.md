# Handover: Apex REST Migration for Headless Reporting UIBundle

## Context

The Headless Reporting dashboard is deployed as a Salesforce UIBundle
(`force-app/main/default/uiBundles/headlessReporting/`). It is a React
app compiled to `app/bundle.js` and served by the Headless 360 platform
at `/app/c__headlessReporting`.

The React frontend (`app/src/App.jsx`) makes all data calls to a separate
Express backend server (`server.js` / `Headless_Reporting_Agent_Backend.js`)
which is currently only reachable at `http://127.0.0.1:3000` (localhost).

When running inside Salesforce, every fetch to `127.0.0.1:3000` is
**blocked by Salesforce's Content Security Policy (CSP)**. The CSP
`connect-src` directive only allows `*.salesforce.com`, `*.amazonaws.com`,
and a handful of other explicit origins — `localhost` is never permitted.

The decision is to **replace the Express backend with a Salesforce Apex
REST class**. This makes all data calls same-origin (`/services/apexrest/...`)
which is unconditionally permitted by the platform CSP.

---

## What the frontend currently calls

`App.jsx` makes exactly four fetch patterns, all relative to a `baseUrl` prop:

| Fetch | Method | Purpose |
|---|---|---|
| `${baseUrl}/session/{id}/state` | GET | Poll session/view state every 15 s |
| `${baseUrl}/session/{id}/state` | PATCH | Push view state changes from the dashboard |
| `${baseUrl}/api/overview` | POST | Load all-journeys overview (KPIs + sparklines) |
| `${baseUrl}/api/query` | POST | Load single-journey detail (buckets + messages) |
| `${baseUrl}/api/query/message` | POST | Load single-message detail (buckets) |
| `${baseUrl}/api/failures` | POST | Load failure records panel (raw rows, paged) |

All requests send `Content-Type: application/json`. All responses are JSON.

The `baseUrl` is baked into `bundle.js` at webpack build time via the
`REPORTING_API_BASE` env var → `__REPORTING_API_BASE__` DefinePlugin in
`app/webpack.config.js`. The fallback hard-coded in `App.jsx:55` is
`http://127.0.0.1:3000`.

---

## What needs to be built

### 1 — Apex REST class: `HeadlessReportingController`

Create `force-app/main/default/classes/HeadlessReportingController.cls`
annotated with `@RestResource(urlMapping='/HeadlessReporting/*')`.

The class must route on the URL suffix and HTTP method to reproduce all
six endpoints above. The simplest approach is a single `@HttpPost` method
that inspects `RestContext.request.requestURI` to determine the operation,
mirroring the Express router in `server.js`.

```
/services/apexrest/HeadlessReporting/session/{id}/state  GET  → getSessionState
/services/apexrest/HeadlessReporting/session/{id}/state  PATCH → patchSessionState
/services/apexrest/HeadlessReporting/api/overview        POST  → runQueryOverview
/services/apexrest/HeadlessReporting/api/query           POST  → runQuery
/services/apexrest/HeadlessReporting/api/query/message   POST  → runQueryMessage
/services/apexrest/HeadlessReporting/api/failures        POST  → getFailureRecords
```

**Session state** in the Express server is an in-process JS Map
(`SESSION_STORE` in `Headless_Reporting_Agent_Backend.js`). In Apex
this must be persisted — use a Custom Object (`HeadlessReportingSession__c`)
with a `SessionId__c` (External ID), `ViewStateJson__c` (Long Text),
`JourneysJson__c` (Long Text), `DetailJson__c` (Long Text), and
`UpdatedAt__c` (DateTime) field.

**Data queries** — the Express backend calls
`sfmc_query_data_extension_rows` (an SFMC MCP tool). In Apex the equivalent
is an SFMC REST callout to:
```
GET /data/v1/customobjectdata/key/{deKey}/rowset
    ?$filter=...&$fields=...&$page=...&$pageSize=2500
```
This requires a Named Credential pointing at the SFMC REST base URL with
a client-credentials OAuth flow, or a pre-fetched bearer token stored in
a Protected Custom Setting.

The Comm_Log DE external key is `69C7427F-DC32-4114-ADB3-5D73DE282B8B`
(also `COMMS_DE_KEY` in `Headless_Reporting_Agent_Backend.js:258`).

**Normalisation logic** — the full bucket-building and rate-computation
logic lives in `Headless_Reporting_Agent_Backend.js` sections 4–6. The
Apex class must reproduce:
- `buildDeFilter()` — constructs the `$filter` string including MessageName
  stem matching, channel, and date bounds.
- `normalizeRestRows()` — groups raw DE rows into day/hour buckets counting
  by `MessageStatus` value. The `MESSAGE_STATUS` sets (lines 107–116) are
  the authoritative lookup.
- `parseSfmcDate()` — parses `SentDate` in both US format
  (`M/D/YYYY h:mm:ss AM/PM`) and AU format (`DD/MM/YYYY, h:mm am/pm`).
  Do not use `Date.parse()` or Apex `DateTime.parse()` without an explicit
  format string — format varies by CommunicationType.
- `computeRates()` — derives the six rate fields from raw counts.
- `normalizeMessageRows()` — groups rows by `MessageName` within a journey.
- `messageNameStem()` — strips `_Email` / `_SMS` / `_Push` suffix from
  MessageName to derive the journey stem used in DE filters.

### 2 — Custom Object: `HeadlessReportingSession__c`

Fields:
- `SessionId__c` Text(36) — External ID, unique, not null
- `ViewStateJson__c` Long Text(131072)
- `JourneysJson__c` Long Text(131072)
- `DetailJson__c` Long Text(131072)
- `UpdatedAt__c` DateTime

### 3 — Named Credential / Auth

Create a Named Credential `SFMC_REST` pointing at the SFMC REST base URL
(currently in `SFMC_BASE_URL` env var). Configure client-credentials OAuth
or store the bearer token in a Protected Custom Setting `SFMCToken__c`.

The Apex callout in the REST controller replaces the Node.js
`sfmc_query_data_extension_rows` call in `fetchFromRestFallback()`.

### 4 — Permission Set

Grant the Named Credential callout and read/write on
`HeadlessReportingSession__c` to the profile/permission set used to access
the app.

### 5 — Rebuild `bundle.js`

Once the Apex class is deployed, rebuild with:

```powershell
cd force-app/main/default/uiBundles/headlessReporting/app
$env:REPORTING_API_BASE = "/services/apexrest/HeadlessReporting"
npm run build
```

Then redeploy:

```powershell
sf project deploy start --source-dir force-app
```

The `DEFAULT_BASE_URL` constant in `App.jsx:52-55` will be replaced at
build time by the `__REPORTING_API_BASE__` DefinePlugin. No other changes
to the React source are needed — the fetch paths, request bodies, and
response shapes stay identical.

---

## What does NOT change

- `app/src/App.jsx` — no code changes required beyond the rebuild above.
- `app/src/index.js` — no changes.
- `app/webpack.config.js` — no changes.
- `Headless_Reporting_Agent_Backend.js` — continues to serve the Bob agent
  chat path unchanged. The agent still calls it via the local Express server.
  Only the UIBundle's browser fetches move to Apex.
- The UIBundle metadata files — no changes after the current deployment fixes.

---

## Response shape contract

The Apex class must return JSON matching the shapes the frontend already
expects. These are the canonical shapes from the Express server:

### `GET /session/{id}/state`
```json
{
  "viewState": { "channel": "all", "drillLevel": "overview", "journeyId": null,
                 "messageId": null, "dateRange": {}, "updatedAt": 1234567890 },
  "journeys": [],
  "detail": null
}
```

### `POST /api/overview`
Request: `{ "sessionId": "...", "dateRange": {...} }`
Response: `{ "journeys": [ { "id": "...", "name": "...", "channels": ["email"],
             "buckets": [ { "date": "YYYY-MM-DD", "sent": 0, ... } ] } ],
             "journeyNames": ["..."] }`

### `POST /api/query`
Request: `{ "sessionId": "...", "journeyId": "...", "dateRange": {...} }`
Response: `{ "journeyId": "...", "channel": "email", "groupBy": "day",
             "buckets": [...], "messages": [...], "sources": ["rest_fallback"] }`

### `POST /api/query/message`
Same as `/api/query` plus `"messageId": "..."` in request. Response adds
`"messageId"` field.

---

## Key implementation notes for the Apex author

1. **Session state is per-user, not per-session-UUID.** The `sessionId` in
   the current Express prototype is a UUID generated client-side. In Apex,
   `UserInfo.getUserId()` is a better partition key — but the frontend passes
   a UUID, so keep `SessionId__c` as the lookup key and just upsert on it.

2. **DE date filter limitation.** `SentDate` on the rowset endpoint silently
   ignores `gte`/`lte` filters for Date-type columns — confirmed in the
   Node backend. The Apex callout can still send them (they don't hurt) but
   must also apply the date range filter in-memory after fetching, exactly
   as `normalizeRestRows()` does.

3. **MessageName stem matching.** The DE filter must match all suffix
   variants: `stem_Email`, `stem_SMS`, `stem_Push`, `stem Email`, `stem SMS`,
   `stem Push`, and the bare `stem`. See `buildDeFilter()` in the backend.

4. **Paging.** SFMC caps the rowset endpoint at 2,500 rows per page. The
   Apex callout must loop until `items.size() < 2500`, the same as the
   `fetchFromRestFallback()` while loop.

5. **CORS.** Apex REST is same-origin from the UIBundle's perspective —
   no CORS headers needed.

6. **Error responses.** Return `{ "error": "...", "code": "..." }` with an
   appropriate HTTP status. The frontend silently swallows errors (empty
   catch blocks) but the Apex class should still use proper status codes.
