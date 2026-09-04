// ---------------------------------------------------------------------------
// Browser-compatible preamble
// ---------------------------------------------------------------------------
// Loaded via Babel standalone (index.html fetch+transform path).
// React, Recharts and LucideReact are all available as CDN globals.
/* global React, Recharts, LucideReact */

const { useState, useEffect, useCallback, useRef } = React;

const {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} = Recharts;

const {
  ChevronRight, ArrowLeft, ArrowUpRight, ArrowDownRight,
  Download, Radio, Mail, MessageSquare, Bell,
} = LucideReact;

// filterByStatus and STATUS_METRIC are inlined here so the dashboard doesn't
// need to import from the backend module (which isn't loadable as a browser script).
const STATUS_METRIC = {
  all:         null,
  delivered:   "delivered",
  bounced:     "bounced",
  undelivered: "undelivered",
  opened:      "opens",
  clicked:     "clicks",
};

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
// Design tokens
// ---------------------------------------------------------------------------
const INK     = "#0B1220";
const CANVAS  = "#F3F5F9";
const SURFACE = "#FFFFFF";
const LINE    = "#E3E7EE";
const TEXT    = "#0B1220";
const SUBTEXT = "#5B6472";
const SIGNAL  = "#16C784";   // healthy / delivered
const WARN    = "#F5A623";   // pending / degraded
const CRIT    = "#E5484D";   // bounced / failed
const ACCENT  = "#3B6FE0";   // structural accent (links, active states)

const fontDisplay = "'Space Grotesk', sans-serif";
const fontBody    = "'Inter', sans-serif";
const fontMono    = "'IBM Plex Mono', monospace";

// ---------------------------------------------------------------------------
// Channel metadata
// ---------------------------------------------------------------------------
const CHANNEL_META = {
  email: { label: "Email", icon: Mail },
  sms:   { label: "SMS",   icon: MessageSquare },
};

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

/**
 * Sum a MetricBucket[] into a single totals object.
 * @param {Object[]} rows
 * @returns {{ sent, delivered, bounced, undelivered, opens, clicks }}
 */
function sumSeries(rows) {
  return rows.reduce(
    (acc, r) => {
      acc.sent        += r.sent        || 0;
      acc.delivered   += r.delivered   || 0;
      acc.bounced     += r.bounced     || 0;
      acc.undelivered += r.undelivered || 0;
      acc.opens       += r.opens       || 0;
      acc.clicks      += r.clicks      || 0;
      return acc;
    },
    { sent: 0, delivered: 0, bounced: 0, undelivered: 0, opens: 0, clicks: 0 }
  );
}

function pct(n, d)   { return d > 0 ? (n / d) * 100 : 0; }
function fmt(n)      { return n.toLocaleString("en-US"); }
function fmtPct(n)   { return n.toFixed(1) + "%"; }
// STATUS_METRIC and filterByStatus are imported from the backend —
// they operate on MetricBucket[] which is a backend-defined type.
// See Headless_Reporting_Agent_Backend.js section 5c.

/**
 * Triggers a browser CSV download.
 * @param {string} filename  - suggested filename (no extension needed — added here)
 * @param {string[][]} rows  - first row is the header
 */
function downloadCsv(filename, rows) {
  const escape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}


/**
 * Derives a human-readable x-axis label from a MetricBucket date string.
 * Handles ISO dates ("2026-08-21") and ISO datetimes ("2026-08-21T14:00:00").
 *
 * @param {string} isoDate
 * @param {"day"|"hour"} groupBy
 * @returns {string}
 */
function bucketLabel(isoDate, groupBy = "day") {
  if (!isoDate) return "";
  if (groupBy === "hour") return isoDate.slice(11, 16) || isoDate.slice(0, 10);
  // "2026-08-21" → "Aug 21"
  const [, m, d] = isoDate.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function KPITile({ label, value, delta, tone = "neutral" }) {
  const positive = delta !== undefined && delta >= 0;
  const valueColor = tone === "crit" ? CRIT : tone === "warn" ? WARN : TEXT;
  return (
    <div style={{
      background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10,
      padding: "18px 20px", flex: 1, minWidth: 150,
    }}>
      <div style={{ fontFamily: fontBody, fontSize: 12, color: SUBTEXT, letterSpacing: 0.3, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontFamily: fontMono, fontSize: 26, fontWeight: 600, color: valueColor, marginTop: 6 }}>
        {value}
      </div>
      {delta !== undefined && (
        <div style={{
          display: "flex", alignItems: "center", gap: 4, marginTop: 6,
          fontFamily: fontMono, fontSize: 12,
          color: tone === "inverse" ? (positive ? CRIT : SIGNAL) : (positive ? SIGNAL : CRIT),
        }}>
          {positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          {Math.abs(delta).toFixed(1)}% vs prior period
        </div>
      )}
    </div>
  );
}

function Sparkline({ data, dataKey = "delivered" }) {
  return (
    <ResponsiveContainer width={100} height={32}>
      <AreaChart data={data}>
        <Area type="monotone" dataKey={dataKey} stroke={SIGNAL} fill={SIGNAL} fillOpacity={0.15} strokeWidth={1.5} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ChannelBadge({ channel }) {
  const meta = CHANNEL_META[channel] ?? { label: channel, icon: Radio };
  const Icon = meta.icon;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontFamily: fontBody, fontSize: 12, color: SUBTEXT,
      background: CANVAS, border: `1px solid ${LINE}`, borderRadius: 20,
      padding: "3px 9px",
    }}>
      <Icon size={12} /> {meta.label}
    </span>
  );
}

function StatusBar({ delivered, bounced, undelivered }) {
  const total = (delivered + bounced + undelivered) || 1;
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", width: "100%" }}>
      <div style={{ width: `${(delivered   / total) * 100}%`, background: SIGNAL }} />
      <div style={{ width: `${(bounced     / total) * 100}%`, background: CRIT   }} />
      <div style={{ width: `${(undelivered / total) * 100}%`, background: WARN   }} />
    </div>
  );
}

function Breadcrumb({ items, onNavigate }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: fontBody, fontSize: 13 }}>
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight size={13} color={SUBTEXT} />}
          <span
            onClick={() => i < items.length - 1 && onNavigate(i)}
            style={{
              color: i === items.length - 1 ? TEXT : SUBTEXT,
              fontWeight: i === items.length - 1 ? 600 : 400,
              cursor: i < items.length - 1 ? "pointer" : "default",
            }}
          >
            {item}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function FilterPill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: fontBody, fontSize: 12.5, padding: "6px 12px", borderRadius: 20,
        border: `1px solid ${active ? INK : LINE}`,
        background: active ? INK : SURFACE,
        color: active ? "#fff" : SUBTEXT,
        cursor: "pointer", transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );
}

function EmptyState({ message }) {
  return (
    <div style={{
      padding: "60px 20px", textAlign: "center",
      fontFamily: fontBody, fontSize: 14, color: SUBTEXT,
    }}>
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * Overview — one row per journey, sorted by a chosen metric.
 *
 * @param {{ journeys: JourneyEntry[], channel: string, status: string, onOpenJourney: function, onExport: function }} props
 *   JourneyEntry: { id, name, channels: string[], buckets: MetricBucket[] }
 */
function OverviewScreen({ journeys, channel, onOpenJourney, onExport }) {
  const [sortKey, setSortKey] = useState("sent");

  if (!journeys || journeys.length === 0) {
    return <EmptyState message="No journey data — run a query to populate the overview." />;
  }

  const isSms = channel === "sms";

  // Build per-row display data
  const rows = journeys
    // v1 client-side channel filter: hide rows whose journey doesn't include the channel
    .filter((j) => channel === "all" || (j.channels && j.channels.includes(channel)))
    .map((j) => {
      const totals = sumSeries(j.buckets || []);
      return { journey: j, buckets: j.buckets || [], totals };
    });

  const grandTotals = rows.reduce(
    (acc, r) => {
      acc.sent        += r.totals.sent;
      acc.delivered   += r.totals.delivered;
      acc.bounced     += r.totals.bounced;
      acc.undelivered += r.totals.undelivered;
      acc.opens       += r.totals.opens;
      acc.clicks      += r.totals.clicks;
      return acc;
    },
    { sent: 0, delivered: 0, bounced: 0, undelivered: 0, opens: 0, clicks: 0 }
  );
  const deliveryRate  = pct(grandTotals.delivered,   grandTotals.sent);
  const bounceRate    = pct(grandTotals.bounced,     grandTotals.sent);
  const failedRate    = pct(grandTotals.undelivered, grandTotals.sent);
  const openRate      = pct(grandTotals.opens,       grandTotals.delivered);

  // SMS overview: tighter column set (no bounce/open/click)
  const smsColumns = [
    ["sent",            "Sent"],
    ["deliveryRate",    "Delivered %"],
    ["undeliveredRate", "Failed %"],
  ];
  const allColumns = [
    ["sent",            "Sent"],
    ["deliveryRate",    "Delivered %"],
    ["bounceRate",      "Bounced %"],
    ["undeliveredRate", "Undelivered %"],
    ["openRate",        "Open Rate"],
    ["clickRate",       "Click Rate"],
  ];
  const tableColumns = isSms ? smsColumns : allColumns;

  // Constrain the active sort key to what's visible when channel changes
  const effectiveSortKey = isSms && !["sent", "deliveryRate", "undeliveredRate"].includes(sortKey)
    ? "sent"
    : sortKey;

  const sorted = [...rows].sort((a, b) => {
    if (effectiveSortKey === "sent")            return b.totals.sent - a.totals.sent;
    if (effectiveSortKey === "deliveryRate")    return pct(b.totals.delivered,   b.totals.sent)      - pct(a.totals.delivered,   a.totals.sent);
    if (effectiveSortKey === "bounceRate")      return pct(b.totals.bounced,     b.totals.sent)      - pct(a.totals.bounced,     a.totals.sent);
    if (effectiveSortKey === "undeliveredRate") return pct(b.totals.undelivered, b.totals.sent)      - pct(a.totals.undelivered, a.totals.sent);
    if (effectiveSortKey === "openRate")        return pct(b.totals.opens,       b.totals.delivered) - pct(a.totals.opens,       a.totals.delivered);
    if (effectiveSortKey === "clickRate")       return pct(b.totals.clicks,      b.totals.delivered) - pct(a.totals.clicks,      a.totals.delivered);
    return 0;
  });

  function handleExport() {
    const header = isSms
      ? ["Journey", "Channels", "Sent", "Delivered %", "Failed %"]
      : ["Journey", "Channels", "Sent", "Delivered %", "Bounced %", "Undelivered %", "Open Rate", "Click Rate"];
    const csvRows = sorted.map(({ journey, totals }) => isSms
      ? [
          journey.name,
          (journey.channels || []).join("/"),
          totals.sent,
          pct(totals.delivered,   totals.sent).toFixed(1),
          pct(totals.undelivered, totals.sent).toFixed(1),
        ]
      : [
          journey.name,
          (journey.channels || []).join("/"),
          totals.sent,
          pct(totals.delivered,   totals.sent).toFixed(1),
          pct(totals.bounced,     totals.sent).toFixed(1),
          pct(totals.undelivered, totals.sent).toFixed(1),
          pct(totals.opens,       totals.delivered).toFixed(1),
          pct(totals.clicks,      totals.delivered).toFixed(1),
        ]
    );
    if (onExport) onExport("overview-journeys", [header, ...csvRows]);
  }

  // Grid template: SMS has 3 metric cols; default has 6
  const gridCols = isSms
    ? "2fr 1fr 1fr 1fr 100px 32px"
    : "2fr 1fr 1fr 1fr 1fr 1fr 100px 32px";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12, flex: 1 }}>
          <KPITile label="Total Sent"    value={fmt(grandTotals.sent)} />
          <KPITile label="Delivery Rate" value={fmtPct(deliveryRate)} />
          {isSms ? (
            <KPITile label="Failed Rate" value={fmtPct(failedRate)} tone={failedRate > 5 ? "crit" : "neutral"} />
          ) : (
            <>
              <KPITile label="Bounce Rate" value={fmtPct(bounceRate)} />
              <KPITile label="Open Rate"   value={fmtPct(openRate)} />
            </>
          )}
        </div>
        {onExport && (
          <button onClick={handleExport} style={{
            display: "flex", alignItems: "center", gap: 6, fontFamily: fontBody, fontSize: 12.5,
            color: SUBTEXT, background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 8,
            padding: "7px 12px", cursor: "pointer", marginLeft: 12, flexShrink: 0,
          }}>
            <Download size={13} /> Export CSV
          </button>
        )}
      </div>

      <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: gridCols,
          padding: "12px 20px", borderBottom: `1px solid ${LINE}`,
          fontFamily: fontBody, fontSize: 11.5, color: SUBTEXT, textTransform: "uppercase", letterSpacing: 0.4,
        }}>
          <div>Journey</div>
          {tableColumns.map(([key, label]) => (
            <div key={key} onClick={() => setSortKey(key)}
              style={{ cursor: "pointer", color: effectiveSortKey === key ? TEXT : SUBTEXT, userSelect: "none" }}>
              {label}{effectiveSortKey === key ? " ↓" : ""}
            </div>
          ))}
          <div>Trend</div>
          <div></div>
        </div>

        {sorted.length === 0 && (
          <EmptyState message={`No journeys match channel filter "${channel}".`} />
        )}

        {sorted.map(({ journey, buckets, totals }) => {
          const dr  = pct(totals.delivered,   totals.sent);
          const br  = pct(totals.bounced,     totals.sent);
          const udr = pct(totals.undelivered, totals.sent);
          const or  = pct(totals.opens,       totals.delivered);
          const cr  = pct(totals.clicks,      totals.delivered);
          return (
            <div
              key={journey.id}
              onClick={() => onOpenJourney(journey.id)}
              style={{
                display: "grid", gridTemplateColumns: gridCols,
                padding: "14px 20px", borderBottom: `1px solid ${LINE}`,
                alignItems: "center", cursor: "pointer", fontFamily: fontBody, fontSize: 13.5,
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = CANVAS}
              onMouseLeave={(e) => e.currentTarget.style.background = SURFACE}
            >
              <div>
                <div style={{ fontWeight: 600, color: TEXT }}>{journey.name}</div>
                <div style={{ display: "flex", gap: 5, marginTop: 4 }}>
                  {(journey.channels || []).map((c) => <ChannelBadge key={c} channel={c} />)}
                </div>
              </div>
              <div style={{ fontFamily: fontMono }}>{fmt(totals.sent)}</div>
              <div style={{ fontFamily: fontMono, color: dr > 90 ? SIGNAL : dr > 80 ? WARN : CRIT }}>{fmtPct(dr)}</div>
              {isSms ? (
                <div style={{ fontFamily: fontMono, color: udr > 5 ? CRIT : udr > 2 ? WARN : SUBTEXT }}>{fmtPct(udr)}</div>
              ) : (
                <>
                  <div style={{ fontFamily: fontMono, color: br < 5 ? SUBTEXT : br < 10 ? WARN : CRIT }}>{fmtPct(br)}</div>
                  <div style={{ fontFamily: fontMono, color: udr < 2 ? SUBTEXT : udr < 5 ? WARN : CRIT }}>{fmtPct(udr)}</div>
                  <div style={{ fontFamily: fontMono }}>{fmtPct(or)}</div>
                  <div style={{ fontFamily: fontMono }}>{fmtPct(cr)}</div>
                </>
              )}
              <div><Sparkline data={buckets} /></div>
              <ChevronRight size={16} color={SUBTEXT} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Journey drill-down — trend chart + message table from a NormalizedResponse.
 *
 * @param {{ detail: NormalizedResponse, status: string, onOpenMessage: function, onExport: function }} props
 *   NormalizedResponse: { journeyId, channel, groupBy, buckets: MetricBucket[], sources }
 *   For v1 the message table is deferred — detail.buckets drive the trend; a
 *   "channel" label replaces the channel-split donut (single-channel query).
 */
function JourneyScreen({ detail, isSms = false, onOpenMessage, onExport }) {
  if (!detail || !detail.buckets) {
    return <EmptyState message="No detail data — select a journey from the overview after running a query." />;
  }

  const totals  = sumSeries(detail.buckets);
  const dr      = pct(totals.delivered,   totals.sent);
  const br      = pct(totals.bounced,     totals.sent);
  const failedR = pct(totals.undelivered, totals.sent);
  const groupBy = detail.groupBy || "day";

  // Add a display label derived from the ISO date so XAxis has something to show
  const labelledBuckets = detail.buckets.map((b) => ({ ...b, label: bucketLabel(b.date, groupBy) }));

  function handleExport() {
    const header = isSms
      ? ["Date", "Sent", "Delivered", "Undelivered", "Delivery %", "Failed %"]
      : ["Date", "Sent", "Delivered", "Bounced", "Undelivered", "Opens", "Clicks",
         "Delivery %", "Bounce %", "Open Rate", "Click Rate"];
    const csvRows = detail.buckets.map((b) => isSms
      ? [
          b.date,
          b.sent, b.delivered, b.undelivered,
          pct(b.delivered,   b.sent).toFixed(1),
          pct(b.undelivered, b.sent).toFixed(1),
        ]
      : [
          b.date,
          b.sent, b.delivered, b.bounced, b.undelivered, b.opens, b.clicks,
          pct(b.delivered,   b.sent).toFixed(1),
          pct(b.bounced,     b.sent).toFixed(1),
          pct(b.opens,       b.delivered).toFixed(1),
          pct(b.clicks,      b.delivered).toFixed(1),
        ]
    );
    const filename = `journey-${(detail.journeyId || "data").replace(/\s+/g, "-").toLowerCase()}`;
    if (onExport) onExport(filename, [header, ...csvRows]);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, flex: 1 }}>
          <KPITile label="Sent"          value={fmt(totals.sent)} />
          <KPITile label="Delivery Rate" value={fmtPct(dr)} />
          {isSms ? (
            <KPITile label="Failed Rate" value={fmtPct(failedR)} tone={failedR > 5 ? "crit" : "neutral"} />
          ) : (
            <KPITile label="Bounce Rate" value={fmtPct(br)} />
          )}
          <KPITile label="Channel"       value={detail.channel || "all"} />
        </div>
        {onExport && (
          <button onClick={handleExport} style={{
            display: "flex", alignItems: "center", gap: 6, fontFamily: fontBody, fontSize: 12.5,
            color: SUBTEXT, background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 8,
            padding: "7px 12px", cursor: "pointer", marginLeft: 12, flexShrink: 0,
          }}>
            <Download size={13} /> Export CSV
          </button>
        )}
      </div>

      <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10, padding: 20, marginBottom: 20 }}>
        <div style={{ fontFamily: fontBody, fontSize: 12, color: SUBTEXT, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.3 }}>
          Delivered vs Bounced — {groupBy === "hour" ? "hourly" : "daily"}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={labelledBuckets}>
            <CartesianGrid stroke={LINE} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontFamily: fontMono, fontSize: 10, fill: SUBTEXT }}
              axisLine={{ stroke: LINE }} tickLine={false}
              interval={Math.ceil(labelledBuckets.length / 8)}
            />
            <YAxis tick={{ fontFamily: fontMono, fontSize: 10, fill: SUBTEXT }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ fontFamily: fontMono, fontSize: 12, borderRadius: 8, border: `1px solid ${LINE}` }} />
            <Area type="monotone" dataKey="delivered" stackId="1" stroke={SIGNAL} fill={SIGNAL} fillOpacity={0.2} />
            <Area type="monotone" dataKey="bounced"   stackId="1" stroke={CRIT}   fill={CRIT}   fillOpacity={0.2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Message-level table — deferred for v1; shown when detail.messages is available */}
      {detail.messages && detail.messages.length > 0 ? (
        <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1.5fr 32px",
            padding: "12px 20px", borderBottom: `1px solid ${LINE}`,
            fontFamily: fontBody, fontSize: 11.5, color: SUBTEXT, textTransform: "uppercase", letterSpacing: 0.4,
          }}>
            <div>Message</div>
            <div>Channel</div>
            <div>Sent</div>
            <div>Delivered</div>
            <div>Status Mix</div>
            <div></div>
          </div>
          {detail.messages.map((m) => {
            const t = sumSeries(m.buckets || []);
            return (
              <div
                key={m.id}
                onClick={() => onOpenMessage(m.id)}
                style={{
                  display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1.5fr 32px",
                  padding: "14px 20px", borderBottom: `1px solid ${LINE}`,
                  alignItems: "center", cursor: "pointer", fontFamily: fontBody, fontSize: 13.5,
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = CANVAS}
                onMouseLeave={(e) => e.currentTarget.style.background = SURFACE}
              >
                <div style={{ fontWeight: 600, color: TEXT }}>{m.name}</div>
                <div><ChannelBadge channel={m.channel || detail.channel} /></div>
                <div style={{ fontFamily: fontMono }}>{fmt(t.sent)}</div>
                <div style={{ fontFamily: fontMono }}>{fmt(t.delivered)}</div>
                <div><StatusBar delivered={t.delivered} bounced={t.bounced} undelivered={t.undelivered} /></div>
                <ChevronRight size={16} color={SUBTEXT} />
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{
          background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10, padding: "18px 20px",
          fontFamily: fontBody, fontSize: 13, color: SUBTEXT,
        }}>
          Message-level breakdown available after a message-level query.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FailureRecordsPanel — bounced / undelivered subscriber record drill-down
// ---------------------------------------------------------------------------

/**
 * Column definitions for the failure records table.
 * Each entry: { key, label, width (flex), align, render? }
 * render(value, row) → display string; omit to show value as-is.
 */
const FAILURE_COLS_EMAIL = [
  { key: "sentDate",          label: "Sent",            width: 1.4 },
  { key: "subscriberKey",     label: "Subscriber Key",  width: 1.4 },
  { key: "email",             label: "Email",           width: 2 },
  { key: "messageStatus",     label: "Status",          width: 0.8,
    render: (v) => v },
  { key: "nmi",               label: "NMI",             width: 1 },
  { key: "messageName",       label: "Message",         width: 1.6 },
];

const FAILURE_COLS_SMS = [
  { key: "sentDate",          label: "Sent",            width: 1.4 },
  { key: "subscriberKey",     label: "Subscriber Key",  width: 1.4 },
  { key: "mobile",            label: "Mobile",          width: 1.2 },
  { key: "messageStatus",     label: "Status",          width: 0.8 },
  { key: "undeliveredStatus", label: "Undel. Status",   width: 1.2 },
  { key: "undeliveredReason", label: "Reason",          width: 2 },
  { key: "nmi",               label: "NMI",             width: 1 },
];

/**
 * Collapsible panel that fetches and displays individual bounced / undelivered
 * records for the current message. Includes sort-by-column and CSV export.
 *
 * Props:
 *   baseUrl    {string}  - API base (same as App)
 *   sessionId  {string}
 *   messageId  {string}  - MessageName stem to query
 *   journeyId  {string}
 *   isSms      {boolean}
 *   dateRange  {Object}  - { start, end } ISO8601 strings (may be null)
 *   totalFailed {number} - pre-computed count from parent (for the panel heading badge)
 */
function FailureRecordsPanel({ baseUrl, sessionId, messageId, journeyId, isSms, dateRange, totalFailed }) {
  const [open,    setOpen]    = useState(false);
  const [records, setRecords] = useState(null);   // null = not yet fetched
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [sortKey, setSortKey] = useState("sentDate");
  const [sortDir, setSortDir] = useState("desc");   // "asc" | "desc"
  const [page,    setPage]    = useState(0);
  const PAGE_SIZE = 50;

  // Fetch on first open (lazy), and again if the message / date range changes while open.
  const lastFetchId = useRef(null);
  const fetchKey = `${messageId}|${dateRange?.start ?? ""}|${dateRange?.end ?? ""}`;

  useEffect(() => {
    if (!open) return;
    if (fetchKey === lastFetchId.current) return;
    lastFetchId.current = fetchKey;

    setLoading(true);
    setError(null);

    const hasStart = (dateRange?.start ?? "").length >= 10;
    const hasEnd   = (dateRange?.end   ?? "").length >= 10;
    const drPayload = (hasStart || hasEnd) ? {
      start: hasStart ? `${(dateRange.start).slice(0,10)}T00:00:00.000Z` : null,
      end:   hasEnd   ? `${(dateRange.end  ).slice(0,10)}T23:59:59.999Z` : null,
    } : null;

    fetch(`${baseUrl}/api/query/failures`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId,
        messageId: messageId ?? journeyId,
        journeyId,
        ...(drPayload && { dateRange: drPayload }),
      }),
    })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data) => { setRecords(data.records ?? []); setPage(0); })
      .catch((e)  => setError(`Failed to load records (${e})`))
      .finally(()  => setLoading(false));
  }, [open, fetchKey, baseUrl, sessionId, messageId, journeyId, dateRange]);

  // Sort
  const sorted = (records ?? []).slice().sort((a, b) => {
    const av = a[sortKey] ?? "";
    const bv = b[sortKey] ?? "";
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totalPages  = Math.ceil(sorted.length / PAGE_SIZE);
  const pageRecords = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const cols        = isSms ? FAILURE_COLS_SMS : FAILURE_COLS_EMAIL;

  function handleSort(key) {
    if (key === sortKey) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  function handleExportCsv() {
    const header = cols.map((c) => c.label);
    const csvRows = sorted.map((row) => cols.map((c) => row[c.key] ?? ""));
    const safeName = (messageId ?? journeyId ?? "failures").replace(/\s+/g, "-").toLowerCase();
    downloadCsv(`failures-${safeName}`, [header, ...csvRows]);
  }

  const badgeCount = records !== null ? sorted.length : totalFailed;
  const badgeColor = badgeCount > 0 ? CRIT : SUBTEXT;

  return (
    <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10, padding: 20, marginTop: 12 }}>
      {/* Panel header / toggle */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: fontBody, fontSize: 13, fontWeight: 600, color: TEXT }}>
            {isSms ? "Undelivered Records" : "Bounced / Undelivered Records"}
          </span>
          {badgeCount > 0 && (
            <span style={{
              fontFamily: fontMono, fontSize: 11, color: "#fff",
              background: badgeColor, borderRadius: 10, padding: "1px 7px", lineHeight: 1.6,
            }}>
              {records !== null ? fmt(sorted.length) : `~${fmt(badgeCount)}`}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {open && records !== null && records.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); handleExportCsv(); }}
              style={{
                display: "flex", alignItems: "center", gap: 5, fontFamily: fontBody, fontSize: 12,
                color: SUBTEXT, background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 6,
                padding: "5px 10px", cursor: "pointer",
              }}
            >
              <Download size={12} /> Export CSV
            </button>
          )}
          <span style={{ fontFamily: fontBody, fontSize: 12.5, color: ACCENT }}>
            {open ? "Hide" : "Investigate"}
          </span>
        </div>
      </div>

      {/* Panel body */}
      {open && (
        <div style={{ marginTop: 16 }}>
          {loading && (
            <div style={{ fontFamily: fontMono, fontSize: 12, color: SUBTEXT, padding: "12px 0" }}>
              Loading records…
            </div>
          )}
          {error && (
            <div style={{ fontFamily: fontMono, fontSize: 12, color: CRIT, padding: "12px 0" }}>
              {error}
            </div>
          )}
          {!loading && !error && records !== null && records.length === 0 && (
            <div style={{ fontFamily: fontMono, fontSize: 12, color: SUBTEXT, padding: "12px 0" }}>
              No {isSms ? "undelivered" : "bounced or undelivered"} records found for this window.
            </div>
          )}
          {!loading && !error && records !== null && records.length > 0 && (
            <div>
              {/* Column headers */}
              <div style={{
                display: "flex", borderBottom: `2px solid ${LINE}`, paddingBottom: 6, marginBottom: 4,
              }}>
                {cols.map((c) => (
                  <div
                    key={c.key}
                    onClick={() => handleSort(c.key)}
                    style={{
                      flex: c.width, fontFamily: fontBody, fontSize: 11, fontWeight: 600,
                      color: sortKey === c.key ? ACCENT : SUBTEXT,
                      cursor: "pointer", userSelect: "none",
                      paddingRight: 8, letterSpacing: 0.2, textTransform: "uppercase",
                    }}
                  >
                    {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                  </div>
                ))}
              </div>

              {/* Rows */}
              {pageRecords.map((row, i) => {
                const isFailure = row.messageStatus === "Bounced" || row.messageStatus === "Undelivered";
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex", alignItems: "flex-start",
                      padding: "7px 0",
                      borderBottom: i < pageRecords.length - 1 ? `1px solid ${LINE}` : "none",
                      background: i % 2 === 1 ? "#FAFBFC" : "transparent",
                    }}
                  >
                    {cols.map((c) => {
                      const val = c.render ? c.render(row[c.key], row) : (row[c.key] ?? "");
                      const isStatus = c.key === "messageStatus";
                      const isReason = c.key === "undeliveredReason" || c.key === "undeliveredStatus";
                      return (
                        <div
                          key={c.key}
                          style={{
                            flex: c.width,
                            fontFamily: fontMono, fontSize: 11.5,
                            color: isStatus && isFailure ? CRIT : isReason && val ? WARN : SUBTEXT,
                            fontWeight: isStatus && isFailure ? 600 : 400,
                            paddingRight: 8, wordBreak: "break-all",
                          }}
                        >
                          {val || <span style={{ opacity: 0.35 }}>—</span>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 12, marginTop: 14,
                  fontFamily: fontMono, fontSize: 12, color: SUBTEXT,
                }}>
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    style={{
                      fontFamily: fontBody, fontSize: 12, padding: "4px 10px",
                      border: `1px solid ${LINE}`, borderRadius: 6, background: SURFACE,
                      color: page === 0 ? LINE : SUBTEXT, cursor: page === 0 ? "default" : "pointer",
                    }}
                  >← Prev</button>
                  <span>Page {page + 1} of {totalPages} · {fmt(sorted.length)} records</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    style={{
                      fontFamily: fontBody, fontSize: 12, padding: "4px 10px",
                      border: `1px solid ${LINE}`, borderRadius: 6, background: SURFACE,
                      color: page >= totalPages - 1 ? LINE : SUBTEXT,
                      cursor: page >= totalPages - 1 ? "default" : "pointer",
                    }}
                  >Next →</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageScreen
// ---------------------------------------------------------------------------

function MessageScreen({ detail, isSms = false, onExport, baseUrl = "", sessionId, appliedRange }) {
  const [exportingRaw, setExportingRaw] = useState(false);

  if (!detail || !detail.buckets) {
    return <EmptyState message="No message detail — navigate from the journey screen after running a message-level query." />;
  }

  const totals  = sumSeries(detail.buckets);
  const dr      = pct(totals.delivered,   totals.sent);
  const failedR = pct(totals.undelivered, totals.sent);

  // Add hour display label; buckets should have date as ISO datetime for hourly groupBy
  const labelledBuckets = detail.buckets.map((b) => ({
    ...b,
    hour: b.date ? (b.date.slice(11, 16) || b.date.slice(0, 10)) : "",
  }));

  // Total failure count from aggregated buckets (used as the badge estimate
  // before the failure records fetch completes)
  const totalFailed = isSms ? totals.undelivered : (totals.bounced + totals.undelivered);

  function handleExport() {
    const header = isSms
      ? ["Hour", "Sent", "Delivered", "Undelivered", "Delivery %", "Failed %"]
      : ["Hour", "Sent", "Delivered", "Bounced", "Undelivered", "Opens", "Clicks"];
    const csvRows = detail.buckets.map((b) => isSms
      ? [b.date, b.sent, b.delivered, b.undelivered,
         pct(b.delivered, b.sent).toFixed(1), pct(b.undelivered, b.sent).toFixed(1)]
      : [b.date, b.sent, b.delivered, b.bounced, b.undelivered, b.opens, b.clicks]
    );
    const filename = `message-${(detail.journeyId || "data").replace(/\s+/g, "-").toLowerCase()}`;
    if (onExport) onExport(filename, [header, ...csvRows]);
  }

  function handleRawExport() {
    setExportingRaw(true);
    const header = isSms
      ? ["Hour", "Sent", "Delivered", "Undelivered"]
      : ["Hour", "Sent", "Delivered", "Bounced", "Undelivered", "Opens", "Clicks"];
    const csvRows = detail.buckets.map((b) => isSms
      ? [b.date, b.sent, b.delivered, b.undelivered]
      : [b.date, b.sent, b.delivered, b.bounced, b.undelivered, b.opens, b.clicks]
    );
    const filename = `raw-send-records-${(detail.journeyId || "data").replace(/\s+/g, "-").toLowerCase()}`;
    downloadCsv(filename + ".csv", [header, ...csvRows]);
    setTimeout(() => setExportingRaw(false), 1200);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, flex: 1 }}>
          <KPITile label="Sent"          value={fmt(totals.sent)} />
          <KPITile label="Delivery Rate" value={fmtPct(dr)} />
          {isSms ? (
            <KPITile label="Failed Rate" value={fmtPct(failedR)} tone={failedR > 5 ? "crit" : "neutral"} />
          ) : (
            <KPITile label="Bounced"     value={fmt(totals.bounced)} />
          )}
        </div>
        {onExport && (
          <button onClick={handleExport} style={{
            display: "flex", alignItems: "center", gap: 6, fontFamily: fontBody, fontSize: 12.5,
            color: SUBTEXT, background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 8,
            padding: "7px 12px", cursor: "pointer", marginLeft: 12, flexShrink: 0,
          }}>
            <Download size={13} /> Export CSV
          </button>
        )}
      </div>

      <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10, padding: 20, marginBottom: 16 }}>
        <div style={{ fontFamily: fontBody, fontSize: 12, color: SUBTEXT, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.3 }}>
          Hourly send volume
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={labelledBuckets}>
            <CartesianGrid stroke={LINE} vertical={false} />
            <XAxis dataKey="hour" tick={{ fontFamily: fontMono, fontSize: 10, fill: SUBTEXT }} axisLine={{ stroke: LINE }} tickLine={false} interval={2} />
            <YAxis tick={{ fontFamily: fontMono, fontSize: 10, fill: SUBTEXT }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ fontFamily: fontMono, fontSize: 12, borderRadius: 8, border: `1px solid ${LINE}` }} />
            <Bar dataKey="delivered" stackId="a" fill={SIGNAL} radius={[0, 0, 0, 0]} />
            <Bar dataKey="bounced"   stackId="a" fill={CRIT}   radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Failure record drill-down panel — shown whenever there is at least one failure */}
      {totalFailed > 0 && (
        <FailureRecordsPanel
          baseUrl={baseUrl}
          sessionId={sessionId}
          messageId={detail.messageId}
          journeyId={detail.journeyId}
          isSms={isSms}
          dateRange={appliedRange}
          totalFailed={totalFailed}
        />
      )}

      {/* Raw send records — export only, no inline table */}
      <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 10, padding: 20, marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: fontBody, fontSize: 13, fontWeight: 600, color: TEXT }}>
              Raw send records
            </div>
            <div style={{ fontFamily: fontBody, fontSize: 12, color: SUBTEXT, marginTop: 3 }}>
              {fmt(totals.sent)} records — download as CSV to view in full
            </div>
          </div>
          <button
            onClick={handleRawExport}
            disabled={exportingRaw}
            style={{
              display: "flex", alignItems: "center", gap: 6, fontFamily: fontBody, fontSize: 12.5,
              color: exportingRaw ? SUBTEXT : ACCENT,
              background: SURFACE, border: `1px solid ${exportingRaw ? LINE : ACCENT}`,
              borderRadius: 8, padding: "7px 14px", cursor: exportingRaw ? "default" : "pointer",
              flexShrink: 0, transition: "opacity 0.15s",
            }}
          >
            <Download size={13} />
            {exportingRaw ? "Preparing…" : "Export to CSV"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

// Polling interval (ms). The dashboard re-fetches session state on this cadence
// so that agent-driven updates (from the chat surface) appear without a reload.
// 15 s is the spec §7 polling fallback value — fine for prototype use.
const POLL_INTERVAL_MS = 15_000;

// Null start/end means "all time" — no lower or upper bound applied.
const EMPTY_DATE_RANGE = { start: "", end: "" };

/**
 * Top-level dashboard. Fetches live session state from the backend on mount
 * and polls every POLL_INTERVAL_MS for agent-driven updates.
 *
 * Props
 * ─────
 * sessionId  {string}  Required. The session ID minted by the agent on the
 *                      first handleUserMessage() call. Pass via URL param,
 *                      page-level data attribute, or parent component.
 * baseUrl    {string}  Base URL of the backend service (no trailing slash).
 *                      Defaults to "" (same origin), suitable for dev.
 *
 * sessionData shape (mirrors SessionData in the backend):
 * {
 *   viewState: { journeyId, channel, dateRange, drillLevel, messageId, updatedBy },
 *   journeys:  JourneyEntry[],            // overview rows — populated by runQueryOverview()
 *   detail:    NormalizedResponse | null  // journey/message drill detail
 * }
 */
export default function App({ sessionId, baseUrl = "" }) {
  // ── Server state ──────────────────────────────────────────────────────────
  const [journeys, setJourneys] = useState([]);
  const [detail,   setDetail]   = useState(null);

  // ── Fetch status ─────────────────────────────────────────────────────────
  const [loading,  setLoading]  = useState(false);
  const [stale,    setStale]    = useState(false);   // true while a new fetch is in-flight after a filter change
  const lastUpdatedAt = useRef(null);

  // ── Local UI state ────────────────────────────────────────────────────────
  const [view,    setView]    = useState({ drillLevel: "overview", journeyId: null, messageId: null });
  const [channel, setChannel] = useState("all");
  // appliedRange is the committed window used for queries; pendingRange tracks
  // the picker inputs before the user clicks Apply.
  const [appliedRange, setAppliedRange] = useState(EMPTY_DATE_RANGE);
  const [pendingRange, setPendingRange] = useState(EMPTY_DATE_RANGE);
  const seededFromServer = useRef(false);

  // ── Fetch session state from the backend ─────────────────────────────────
  const fetchSessionState = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res  = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/state`);
      if (!res.ok) return;
      const data = await res.json();

      // Staleness guard (spec §7): only update if server state is newer
      const serverTs = data.viewState?.updatedAt;
      if (serverTs && serverTs === lastUpdatedAt.current) return; // no change
      lastUpdatedAt.current = serverTs ?? null;

      setJourneys(data.journeys ?? []);
      setDetail(data.detail   ?? null);

      // Seed local UI state from server on the very first successful fetch
      if (!seededFromServer.current && data.viewState) {
        const vs = data.viewState;
        if (vs.channel) setChannel(vs.channel);
        if (vs.drillLevel || vs.journeyId || vs.messageId) {
          setView({
            drillLevel: vs.drillLevel ?? "overview",
            journeyId:  vs.journeyId  ?? null,
            messageId:  vs.messageId  ?? null,
          });
        }
        // Seed date picker from server-stored range if present
        if (vs.dateRange?.start && vs.dateRange?.end) {
          const seeded = {
            start: vs.dateRange.start.slice(0, 10),
            end:   vs.dateRange.end.slice(0, 10),
          };
          setAppliedRange(seeded);
          setPendingRange(seeded);
        }
        seededFromServer.current = true;
      }
    } catch {
      // Network error — stay on current state, stale indicator already shown
    } finally {
      setLoading(false);
      setStale(false);
    }
  }, [sessionId, baseUrl]);

  // ── Initial load + polling ────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    fetchSessionState();

    const timer = setInterval(fetchSessionState, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sessionId, fetchSessionState]);

  // ── Overview fetch — called on mount only (use runOverview for re-fetches) ─
  const overviewFetchedRef = useRef(false);
  // Cache discovered journey names so re-fetches (date range changes) skip the
  // expensive discoverJourneyNames DE scan and go straight to metric queries.
  const journeyNamesRef = useRef(null);

  // Core overview fetch — does the actual POST and updates journeys state.
  // Accepts an explicit dateRange so the server uses it directly rather than
  // reading from session state (avoids any commit-timing ambiguity).
  // Does NOT check or set overviewFetchedRef; callers manage that guard.
  const runOverview = useCallback((dateRange) => {
    if (!sessionId) return;
    setStale(true);
    const body = { sessionId };
    if (dateRange) body.dateRange = dateRange;
    // Pass cached names on re-fetches to skip the full DE name-discovery scan.
    if (journeyNamesRef.current) body.journeyNames = journeyNamesRef.current;
    fetch(`${baseUrl}/api/overview`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.journeys) return;
        // Cache the journey names for future re-fetches (date range changes).
        if (data.journeyNames) journeyNamesRef.current = data.journeyNames;
        setJourneys(data.journeys);
        // Clear the staleness-guard timestamp so the next poll picks up the
        // freshly written session state rather than skipping it.
        lastUpdatedAt.current = null;
        fetchSessionState();
      })
      .catch(() => { /* network error — next poll will retry */ })
      .finally(() => setStale(false));
  }, [sessionId, baseUrl, fetchSessionState]);

  // Mount-time guard: only fire once per sessionId/baseUrl combination.
  const fetchOverview = useCallback(() => {
    if (!sessionId || overviewFetchedRef.current) return;
    overviewFetchedRef.current = true;
    runOverview();
  }, [sessionId, runOverview]);

  useEffect(() => {
    fetchOverview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, baseUrl]);

  // ── Date range apply — PATCH session state + re-run overview ─────────────
  // Called when the user clicks Apply in the date picker.
  // Passing null dateRange tells the server to use no bounds (all time).
  const handleDateApply = useCallback(async (range) => {
    setAppliedRange(range);
    setStale(true);
    if (!sessionId) return;

    // Build the dateRange payload. Empty start/end = all-time (null bounds).
    const hasStart = range.start.length === 10;
    const hasEnd   = range.end.length   === 10;
    const dateRange = (hasStart || hasEnd) ? {
      preset: "custom",
      start:  hasStart ? `${range.start}T00:00:00.000Z` : null,
      end:    hasEnd   ? `${range.end}T23:59:59.999Z`   : null,
    } : null;

    try {
      await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/state`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ patch: { dateRange: dateRange ?? {} }, updatedBy: "dashboard" }),
      });
    } catch {
      // PATCH failed — local state already updated visually
    }

    runOverview(dateRange);
  }, [sessionId, baseUrl, runOverview]);

  // ── Drill fetch — auto-load detail when navigating to journey/message ─────
  // Fired whenever drillLevel, journeyId, messageId, OR the applied date range
  // changes so drill screens always reflect the current filter window.
  useEffect(() => {
    if (!sessionId) return;
    if (view.drillLevel === "overview") return;
    if (!view.journeyId) return;

    // Check whether the cached detail already matches the current view AND date range.
    // appliedRange is included so a date-range change always triggers a fresh fetch
    // even when the journey/message hasn't changed.
    const detailMatchesView =
      detail &&
      detail.journeyId === view.journeyId &&
      (view.drillLevel === "journey" || detail.messageId === view.messageId) &&
      detail._appliedStart === appliedRange.start &&
      detail._appliedEnd   === appliedRange.end;
    if (detailMatchesView) return;

    setStale(true);

    // Build the dateRange payload to pass explicitly so the server uses the
    // correct window rather than whatever was last written to session state.
    const hasStart = appliedRange.start.length === 10;
    const hasEnd   = appliedRange.end.length   === 10;
    const dateRange = (hasStart || hasEnd) ? {
      preset: "custom",
      start:  hasStart ? `${appliedRange.start}T00:00:00.000Z` : null,
      end:    hasEnd   ? `${appliedRange.end}T23:59:59.999Z`   : null,
    } : null;

    const endpoint = view.drillLevel === "message" ? "/api/query/message" : "/api/query";
    fetch(`${baseUrl}${endpoint}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId,
        journeyId: view.journeyId,
        ...(dateRange && { dateRange }),
        ...(view.drillLevel === "message" && { messageId: view.messageId }),
      }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          // Tag the result with the date range that produced it so the
          // staleness guard above can detect range changes.
          data._appliedStart = appliedRange.start;
          data._appliedEnd   = appliedRange.end;
          setDetail(data);
        }
      })
      .catch(() => { /* stay on stale detail — poll will reconcile */ })
      .finally(() => setStale(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, baseUrl, view.drillLevel, view.journeyId, view.messageId, appliedRange.start, appliedRange.end]);

  // ── Derived display values ────────────────────────────────────────────────
  const journeyEntry = view.journeyId ? journeys.find((j) => j.id === view.journeyId) : null;
  const journeyName  = journeyEntry?.name ?? view.journeyId ?? "";
  const messageDetail = view.drillLevel === "message" ? detail : null;
  const messageName   = detail?.messageId ?? view.messageId ?? "Message";

  // isSmsContext: true when the current drill is known to be SMS-only.
  // Checks (in priority):
  //   1. detail.channel set by API
  //   2. active channel filter pill
  //   3. message name ends in _SMS / " SMS" (covers mixed-channel journeys)
  //   4. journey has channels and they are ALL sms
  const isSmsContext =
    detail?.channel === "sms" ||
    channel === "sms" ||
    /[_ ]sms$/i.test(view.messageId ?? "") ||
    /[_ ]sms$/i.test(messageName ?? "") ||
    ((journeyEntry?.channels ?? []).length > 0 && (journeyEntry?.channels ?? []).every((c) => c === "sms"));

  const crumbs = ["Overview"];
  if (view.journeyId) crumbs.push(journeyName);
  if (view.messageId) crumbs.push(messageName);

  const navigateCrumb = (i) => {
    if (i === 0) setView({ drillLevel: "overview", journeyId: null, messageId: null });
    else if (i === 1) setView({ drillLevel: "journey", journeyId: view.journeyId, messageId: null });
  };

  // Status dot: green when live, amber when stale/loading
  const dotColor     = (loading || stale) ? WARN : SIGNAL;
  const dotGlow      = (loading || stale)
    ? "0 0 0 3px rgba(245,166,35,0.25)"
    : "0 0 0 3px rgba(22,199,132,0.2)";
  const statusLabel  = loading ? "loading…" : stale ? "updating…" : `${journeys.length} journey${journeys.length !== 1 ? "s" : ""}`;

  return (
    <div style={{ minHeight: "100vh", background: CANVAS, fontFamily: fontBody }}>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; }
      `}</style>

      {/* Top bar */}
      <div style={{
        background: INK, padding: "16px 28px", display: "flex",
        justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Radio size={20} color={SIGNAL} />
          <span style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: 17, color: "#fff", letterSpacing: 0.2 }}>
            AusNet
          </span>
          <span style={{ fontFamily: fontBody, fontSize: 12.5, color: "#8B93A7", marginLeft: 4 }}>
            Deliverability
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: fontMono, fontSize: 11.5, color: "#8B93A7" }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", background: dotColor, display: "inline-block",
            boxShadow: dotGlow, transition: "background 0.3s, box-shadow 0.3s",
          }} />
          session data · {statusLabel}
        </div>
      </div>

      <div style={{ padding: "22px 28px 60px" }}>
        {/* Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          {view.drillLevel !== "overview" && (
            <ArrowLeft
              size={16} color={SUBTEXT} style={{ cursor: "pointer" }}
              onClick={() => navigateCrumb(view.drillLevel === "message" ? 1 : 0)}
            />
          )}
          <Breadcrumb items={crumbs} onNavigate={navigateCrumb} />
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 20, marginBottom: 22, flexWrap: "wrap", alignItems: "center" }}>
          {/* Date range picker */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <style>{`
              .hr-date-input {
                background: #fff;
                border: 1px solid ${LINE};
                border-radius: 8px;
                padding: 6px 10px;
                font-family: ${fontMono};
                font-size: 12px;
                color: ${TEXT};
                outline: none;
                cursor: pointer;
              }
              .hr-date-input:focus { border-color: ${ACCENT}; }
              .hr-apply-btn {
                background: ${ACCENT};
                color: #fff;
                border: none;
                border-radius: 8px;
                padding: 6px 14px;
                font-family: ${fontBody};
                font-size: 12.5px;
                font-weight: 600;
                cursor: pointer;
              }
              .hr-apply-btn:hover { opacity: 0.88; }
              .hr-clear-btn {
                background: none;
                border: 1px solid ${LINE};
                border-radius: 8px;
                padding: 6px 10px;
                font-family: ${fontBody};
                font-size: 12px;
                color: ${SUBTEXT};
                cursor: pointer;
              }
              .hr-clear-btn:hover { border-color: ${SUBTEXT}; color: ${TEXT}; }
            `}</style>
            <input
              type="date"
              className="hr-date-input"
              value={pendingRange.start}
              onChange={(e) => setPendingRange((r) => ({ ...r, start: e.target.value }))}
            />
            <span style={{ fontFamily: fontMono, fontSize: 11, color: SUBTEXT }}>to</span>
            <input
              type="date"
              className="hr-date-input"
              value={pendingRange.end}
              onChange={(e) => setPendingRange((r) => ({ ...r, end: e.target.value }))}
            />
            <button
              className="hr-apply-btn"
              onClick={() => handleDateApply(pendingRange)}
            >
              Apply
            </button>
            {(appliedRange.start || appliedRange.end) && (
              <button
                className="hr-clear-btn"
                onClick={() => {
                  setPendingRange(EMPTY_DATE_RANGE);
                  handleDateApply(EMPTY_DATE_RANGE);
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Channel filter */}
          {view.drillLevel !== "message" && (
            <div style={{ display: "flex", gap: 6 }}>
              <FilterPill label="All channels" active={channel === "all"}   onClick={() => setChannel("all")} />
              <FilterPill label="Email"        active={channel === "email"} onClick={() => setChannel("email")} />
              <FilterPill label="SMS"          active={channel === "sms"}   onClick={() => setChannel("sms")} />
            </div>
          )}
        </div>

        {/* No session yet */}
        {!sessionId && (
          <EmptyState message="No session ID provided. Start a conversation with the agent to populate this dashboard." />
        )}

        {/* Screens */}
        {sessionId && view.drillLevel === "overview" && (
          <OverviewScreen
            journeys={journeys}
            channel={channel}
            onOpenJourney={(id) => setView({ drillLevel: "journey", journeyId: id, messageId: null })}
            onExport={downloadCsv}
          />
        )}
        {sessionId && view.drillLevel === "journey" && (
          <JourneyScreen
            detail={detail}
            isSms={isSmsContext}
            onOpenMessage={(id) => setView({ drillLevel: "message", journeyId: view.journeyId, messageId: id })}
            onExport={downloadCsv}
          />
        )}
        {sessionId && view.drillLevel === "message" && (
          <MessageScreen
            detail={messageDetail}
            isSms={isSmsContext}
            onExport={downloadCsv}
            baseUrl={baseUrl}
            sessionId={sessionId}
            appliedRange={appliedRange}
          />
        )}
      </div>
    </div>
  );
}

// Expose the App for CDN/Babel-standalone loading in index.html.
// When loaded via a bundler, this is a no-op (window may not exist).
if (typeof window !== "undefined") {
  window.__DashboardApp = App;
  if (typeof window.__mountDashboard === "function") {
    window.__mountDashboard(App);
  }
}
