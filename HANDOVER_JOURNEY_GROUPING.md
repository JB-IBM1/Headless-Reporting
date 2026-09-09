# Handover Note: How Email/SMS Messages Are Found and Grouped into Journeys

## Overview

There is no Journey Builder API call, no MCP metadata lookup, and no `JourneyName`-based join. Journey grouping is derived entirely from the **`MessageName` field** in a single raw-event Data Extension — the `Comm_Log` DE. This approach was chosen because SMS rows do not populate `JourneyName` in this DE, making `MessageName` the only field that works uniformly across all channels (Email, SMS, Push).

---

## The Single Data Source

**DE external key:** `69C7427F-DC32-4114-ADB3-5D73DE282B8B`  
**Env override:** `COMMS_DE_KEY`  
**Schema reference:** `Comm_Log_Schema.csv`

One row per communication event. Metrics are derived by counting rows grouped by `MessageStatus` value. There is no pre-aggregated summary table — all grouping happens in-memory after fetching raw rows.

---

## Step 1 — Discovery: Deriving Journey Stems from `MessageName`

**Function:** `discoverJourneyNames()` → `messageNameStem()`  
**File:** `Headless_Reporting_Agent_Backend.js:983` / `:274`

Pages through every row in the DE requesting only the `MessageName` column, then strips known channel suffixes from each value:

```
"UOM_ETA_Lapsed_SMS"   → "UOM_ETA_Lapsed"
"Welcome_Series_Email" → "Welcome_Series"
"Planned_Outage"       → "Planned_Outage"   ← no suffix, returned as-is
```

**Regex:** `/[_ ](email|sms|push)$/i`  
Matches trailing `_Email`, `_SMS`, `_Push`, ` Email`, ` SMS`, ` Push` (underscore or space separator, case-insensitive). The remainder is the **journey stem** — the canonical display name used everywhere in the session, dashboard, and API.

Discovery is capped at **100 distinct stems** per run to prevent runaway iteration on very large DEs.

---

## Step 2 — Querying Rows for a Stem

**Function:** `buildDeFilter()` → `fetchFromRestFallback()`  
**File:** `Headless_Reporting_Agent_Backend.js:293` / `:343`

Because SFMC cannot compute stems server-side, `buildDeFilter()` generates an OR clause covering every known suffixed variant plus the bare stem:

```
(messagename eq 'UOM_ETA_Lapsed_Email'
 or messagename eq 'UOM_ETA_Lapsed_SMS'
 or messagename eq 'UOM_ETA_Lapsed_Push'
 or messagename eq 'UOM_ETA_Lapsed Email'
 or messagename eq 'UOM_ETA_Lapsed SMS'
 or messagename eq 'UOM_ETA_Lapsed Push'
 or messagename eq 'UOM_ETA_Lapsed')
and sentdate gte '2026-07-01T00:00:00'
and sentdate lte '2026-07-31T23:59:59'
```

If `channel` is not `"all"`, an additional `communicationtype eq 'Email'` (or `SMS` / `Push`) clause is ANDed in.

`fetchFromRestFallback()` pages through the result set in **2,500-row pages** (SFMC's cap), collecting all matching raw DE rows.

> **Important:** The SFMC rowset endpoint silently ignores `sentdate` comparisons server-side (the `Date` column type is not filterable). Date range filtering is also applied **in-memory** inside `normalizeRestRows()` as a safety net. Full ISO timestamps (e.g. `T23:59:59`) must be sent — date-only strings (`YYYY-MM-DD`) cause SFMC to treat the bound as midnight, dropping all rows timestamped after `00:00` on that day.

---

## Step 3 — Channel Detection per Stem

**Function:** `fetchJourneyChannels()`  
**File:** `Headless_Reporting_Agent_Backend.js:899`

Re-queries the same DE for a stem but requests only the `CommunicationType` column with `channel: "all"`. Collects all distinct lowercase values seen (e.g. `{"email", "sms"}`) and returns them as the channel list for that journey. This populates the `channels` array on each `JourneyEntry` in the session store.

---

## Step 4 — Overview Assembly

**Function:** `runQueryOverview()`  
**File:** `Headless_Reporting_Agent_Backend.js:928`

1. Receives the list of stems from `discoverJourneyNames()`
2. Fires `getNormalizedMetrics()` for **every stem in parallel** — one DE query per journey
3. Fires `fetchJourneyChannels()` in parallel for each stem (or uses a pre-supplied `channelMap` to skip re-querying)
4. Assembles a `JourneyEntry[]` array and writes it to `SESSION_STORE`:

```js
{
  id:       "UOM_ETA_Lapsed",         // stem
  name:     "UOM_ETA_Lapsed",         // stem (display name)
  channels: ["email", "sms"],         // from fetchJourneyChannels()
  buckets:  [ ... ]                   // metric aggregates by date
}
```

---

## Data Flow Summary

```
Comm_Log DE (raw event rows)
    │
    ├─ MessageName column ──► messageNameStem() ──► deduplicated stems
    │                                                  (= journey list)
    │
    └─ Per-stem OR filter ──► fetchFromRestFallback() ──► raw rows
                                    │
                                    ├─ normalizeRestRows()    ──► metric buckets
                                    └─ fetchJourneyChannels() ──► channel list
                                                │
                                         JourneyEntry { id, name, channels, buckets }
                                                │
                                         SESSION_STORE (in-memory, keyed by sessionId)
```

---

## Key Design Constraints

| Constraint | Reason |
|---|---|
| `MessageName` used instead of `JourneyName` for grouping | SMS rows do not populate `JourneyName` in this DE |
| No Journey Builder API calls | All journey identity is inferred from DE data alone |
| OR-clause stem expansion at query time | SFMC rowset filter cannot compute derived fields |
| In-memory date filtering as safety net | SFMC rowset endpoint ignores `Date` column comparisons |
| 100-stem discovery cap | Prevents runaway paging on very large DEs |
| 2,500-row page size | SFMC hard cap for the `/data/v1/customobjectdata` rowset endpoint |

---

## Relevant Files

| File | Symbols |
|---|---|
| `Headless_Reporting_Agent_Backend.js` | `messageNameStem`, `buildDeFilter`, `fetchFromRestFallback`, `fetchJourneyChannels`, `discoverJourneyNames`, `runQueryOverview` |
| `Comm_Log_Schema.csv` | Confirmed DE field names and types |
| `AGENTS.md` | Architecture overview — confirms `fetchFromRestFallback` as the sole data path |
