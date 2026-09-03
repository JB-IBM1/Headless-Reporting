/**
 * server.js — Express entry point for the Headless Reporting backend.
 *
 * Wraps the backend handler module and adds:
 *   • Static file serving for index.html + the dashboard JSX (via CDN Babel)
 *   • CORS (permissive for local prototype use)
 *   • MCP tool injection — wires sfmc_query_data_extension_rows from the
 *     SFMC MCP server into every request so the backend can call it without
 *     being inside the Bob agent context.
 *
 * Environment variables (set in .env or shell before starting):
 *   COMMS_DE_KEY   — External key of the Comm_Log Data Extension (UUID)
 *                    Defaults to the value hard-coded in the backend module.
 *   SFMC_BASE_URL  — SFMC REST API base URL, e.g. https://XXXX.rest.marketingcloudapis.com
 *   SFMC_AUTH_URL  — Token endpoint, e.g. https://XXXX.auth.marketingcloudapis.com
 *   SFMC_CLIENT_ID     — Installed-package client ID
 *   SFMC_CLIENT_SECRET — Installed-package client secret
 *   PORT           — HTTP port (default 3000)
 *
 * SFMC token handling:
 *   We fetch a client-credentials token on first request and cache it until
 *   5 minutes before expiry. All calls to sfmc_query_data_extension_rows use
 *   the cached token.
 */

import "dotenv/config";   // loads .env into process.env before anything else reads it

import express      from "express";
import cors         from "cors";
import path         from "path";
import { fileURLToPath } from "url";

import backendHandler, {
  runQuery,
  runQueryMessage,
  runQueryOverview,
  getFailureRecords,
  discoverJourneyNames,
  getSessionState,
  patchSessionState,
  setSessionDetail,
  DEFAULT_VIEW_STATE,
  QueryError,
} from "./Headless_Reporting_Agent_Backend.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT       = parseInt(process.env.PORT ?? "3000", 10);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));

const SFMC_BASE_URL      = process.env.SFMC_BASE_URL      ?? "";
const SFMC_AUTH_URL      = process.env.SFMC_AUTH_URL      ?? "";
const SFMC_CLIENT_ID     = process.env.SFMC_CLIENT_ID     ?? "";
const SFMC_CLIENT_SECRET = process.env.SFMC_CLIENT_SECRET ?? "";

// ---------------------------------------------------------------------------
// SFMC OAuth2 token cache (client credentials grant)
// ---------------------------------------------------------------------------
let _tokenCache = null;  // { accessToken, expiresAt }

async function getSfmcToken() {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.accessToken;
  }

  if (!SFMC_AUTH_URL || !SFMC_CLIENT_ID || !SFMC_CLIENT_SECRET) {
    // Running without credentials — queries will fail gracefully at the DE call
    return null;
  }

  const res = await fetch(`${SFMC_AUTH_URL}/v2/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      grant_type:    "client_credentials",
      client_id:     SFMC_CLIENT_ID,
      client_secret: SFMC_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SFMC token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _tokenCache = {
    accessToken: data.access_token,
    // Expire 5 min early to avoid using a token right as it expires
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };
  return _tokenCache.accessToken;
}

// ---------------------------------------------------------------------------
// MCP tool shim — sfmc_query_data_extension_rows
//
// The backend calls mcpTools.sfmc_query_data_extension_rows({ key, filter,
// fields, page, page_size }). This shim makes that same call against the SFMC
// REST API directly so the server can operate standalone (outside Bob context).
//
// When running inside Bob, the agent passes its own MCP tools via req.mcpTools
// instead — see the middleware below.
// ---------------------------------------------------------------------------
async function sfmc_query_data_extension_rows({ key, filter, fields, page = 1, page_size = 2500 }) {
  const token = await getSfmcToken();

  if (!token || !SFMC_BASE_URL) {
    // No credentials configured — return empty result set rather than crashing
    console.warn("SFMC credentials not configured — returning empty DE result");
    return { count: 0, page, pageSize: page_size, items: [], links: {} };
  }

  // Build query string manually — URLSearchParams percent-encodes the leading
  // '$' in SFMC param names ($filter, $page, $pageSize) which breaks the API.
  const base = SFMC_BASE_URL.replace(/\/$/, "");
  const qsParts = [
    `%24pageSize=${page_size}`,
    `%24page=${page}`,
  ];
  if (filter) qsParts.push(`%24filter=${encodeURIComponent(filter)}`);
  if (fields) qsParts.push(`%24fields=${encodeURIComponent(fields)}`);

  const url = `${base}/data/v1/customobjectdata/key/${encodeURIComponent(key)}/rowset?${qsParts.join("&")}`;

  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SFMC DE query failed (${res.status}): ${text}`);
  }

  return res.json();
}

// Default mcpTools bundle — used when req.mcpTools is not injected
const DEFAULT_MCP_TOOLS = { sfmc_query_data_extension_rows };

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json());

// Inject MCP tools onto every request (can be overridden per-request for testing)
app.use((req, _res, next) => {
  req.mcpTools = req.mcpTools ?? DEFAULT_MCP_TOOLS;
  next();
});

// Serve static files (index.html, dashboard JSX) from the project root
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// Session endpoints
// ---------------------------------------------------------------------------

// GET /session/:id/state
app.get("/session/:id/state", async (req, res) => {
  try {
    const { viewState, journeys, detail } = await getSessionState(req.params.id);
    res.json({ sessionId: req.params.id, viewState, journeys, detail });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /session/:id/state
app.patch("/session/:id/state", async (req, res) => {
  try {
    const { patch, updatedBy } = req.body;
    const { session, corrected } = await patchSessionState(req.params.id, patch, updatedBy ?? "dashboard");
    res.json({ sessionId: req.params.id, viewState: session.viewState, corrected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// Query endpoints (called by the dashboard when drill state changes)
// ---------------------------------------------------------------------------

// POST /api/overview  — populate journey index for the Overview screen
// Body: { sessionId, journeyNames?: string[], dateRange?: { start, end, preset } }
// journeyNames — if supplied, skips the DE name-discovery scan (faster re-fetch on date change).
// dateRange    — if supplied, overrides the session's stored dateRange for this query only.
app.post("/api/overview", async (req, res) => {
  try {
    const { sessionId, journeyNames, dateRange } = req.body;
    if (!sessionId) return res.status(400).json({ code: "MISSING_SESSION", message: "sessionId required" });

    // If the request includes an explicit dateRange, commit it to the session
    // before running the query so runQueryOverview reads the correct window.
    if (dateRange) {
      await patchSessionState(sessionId, { dateRange }, "dashboard");
    }

    const mcpTools = req.mcpTools;
    const names = journeyNames ?? await discoverJourneyNames(mcpTools);
    const journeys = await runQueryOverview(sessionId, names, mcpTools);

    // Bump viewState.updatedAt so the dashboard staleness guard detects this
    // write on the next poll cycle and re-fetches the session (which now has journeys).
    await patchSessionState(sessionId, {}, "agent");

    // Return the discovered/used names so the dashboard can cache them and skip
    // the DE scan on subsequent date-range re-fetches.
    res.json({ sessionId, journeys, journeyNames: names });
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ code: err.code, message: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/query/failures — individual bounced/undelivered subscriber records for a message.
// Must be registered BEFORE /api/query/message and /api/query (Express matches in order).
// Body: { sessionId, messageId, journeyId, dateRange? }
app.post("/api/query/failures", async (req, res) => {
  try {
    const { sessionId, messageId, journeyId, dateRange: bodyDateRange } = req.body;
    if (!sessionId) return res.status(400).json({ code: "MISSING_SESSION", message: "sessionId required" });

    const { viewState } = await getSessionState(sessionId);
    const stem      = messageId ?? journeyId ?? viewState.journeyId;
    const channel   = viewState.channel ?? "all";
    const dateRange = bodyDateRange !== undefined ? bodyDateRange : viewState.dateRange;

    const records = await getFailureRecords(stem, channel, dateRange, req.mcpTools);
    res.json({ messageId: stem, channel, records });
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ code: err.code, message: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/query/message — message-level drill; returns NormalizedResponse with per-message buckets.
// Body: { sessionId, journeyId, messageId, dateRange? }
app.post("/api/query/message", async (req, res) => {
  try {
    const { sessionId, journeyId, messageId, ...rest } = req.body;
    if (!sessionId) return res.status(400).json({ code: "MISSING_SESSION", message: "sessionId required" });

    const { viewState } = await getSessionState(sessionId);
    // Scope the query to the specific message stem (messageId), falling back to
    // the journey stem if no messageId was supplied.
    const rawQuery = { ...rest, journeyId: messageId ?? journeyId };
    const result = await runQueryMessage(rawQuery, viewState, req.mcpTools);

    // Tag the result so the dashboard staleness check can match it.
    result.messageId = messageId ?? null;
    await setSessionDetail(sessionId, result);
    await patchSessionState(sessionId, { drillLevel: "message", journeyId, messageId: messageId ?? null }, "agent");
    res.json(result);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ code: err.code, message: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/query", async (req, res) => {
  try {
    const { sessionId, ...rawQuery } = req.body;
    if (!sessionId) return res.status(400).json({ code: "MISSING_SESSION", message: "sessionId required" });

    const { viewState } = await getSessionState(sessionId);
    // runQueryMessage returns journey-level buckets + per-message breakdown in one call.
    const result = await runQueryMessage(rawQuery, viewState, req.mcpTools);
    await setSessionDetail(sessionId, result);
    await patchSessionState(sessionId, { drillLevel: "journey", journeyId: result.journeyId }, "agent");
    res.json(result);
  } catch (err) {
    if (err instanceof QueryError) return res.status(400).json({ code: err.code, message: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Headless Reporting server running at http://127.0.0.1:${PORT}`);
  console.log(`  Dashboard: http://127.0.0.1:${PORT}/index.html`);
  if (!SFMC_BASE_URL) {
    console.warn("  ⚠  SFMC_BASE_URL not set — DE queries will return empty results.");
    console.warn("     Set SFMC_BASE_URL, SFMC_AUTH_URL, SFMC_CLIENT_ID, SFMC_CLIENT_SECRET in env.");
  }
});

export default app;
