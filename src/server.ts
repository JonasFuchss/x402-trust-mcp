#!/usr/bin/env node
/**
 * x402-trust MCP server.
 *
 * Lets ANY MCP-capable agent (Claude Desktop, Coinbase AgentKit, Cursor, …)
 * query trust & reliability data about x402 endpoints before paying them.
 * This is the agent-to-agent distribution surface: an agent that must decide
 * "should I trust this paid endpoint?" installs this and gets the answer.
 *
 * Tools:
 *   x402_ecosystem_stats   (free)  aggregate state-of-x402 snapshot
 *   x402_trust_leaderboard (free)  top endpoints by trust score
 *   x402_trust_preview     (free)  full sample reports for 3 fixed endpoints (best/median/worst)
 *   x402_trust_score       (paid)  per-endpoint score 0-100 + breakdown
 *   x402_endpoint_history  (paid)  per-endpoint observation time-series
 *   x402_trust_bulk        (paid)  score many endpoints in one call
 *   x402_watch_create      (paid)  start a 30-day endpoint watch
 *   x402_watch_events      (free)  poll a watch's append-only event log
 *   x402_watch_edit        (free)  change delivery URLs / sensitivity / events
 *   x402_watch_cancel      (free)  cancel a watch early
 *   x402_watch_renew       (paid)  extend a watch by 30 days
 *
 * Paid tools quote the price and, if X402_PRIVATE_KEY is set (a funded Base
 * USDC wallet) and the quote is within X402_MAX_USD, auto-pay over x402.
 * Without a key they return the quote so the host can pay.
 *
 * Config via env:
 *   X402_TRUST_API_BASE   default https://x402.fuchss.app
 *   X402_PRIVATE_KEY      optional 0x… Base wallet key to enable auto-pay
 *   X402_MAX_USD          default 0.05 — auto-pay ceiling PER CALL (0 disables)
 *   X402_MAX_TOTAL_USD    default 1.00 — cumulative auto-pay cap per process (0 = unlimited)
 *   X402_MAX_CALLS        default 1000 — max paid calls per process (0 = unlimited)
 *   X402_TIMEOUT_MS       default 20000
 *
 * Safety: paid tools only ever sign EIP-3009 USDC transfers whose asset is the
 * canonical USDC contract on an allow-listed chain (Base mainnet by default);
 * a malicious 402 cannot redirect the payment to an arbitrary token or chain.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Hex } from "viem";
import { paidPost, SpendTracker } from "./pay.js";

const API_BASE = (process.env.X402_TRUST_API_BASE ?? "https://x402.fuchss.app").replace(/\/$/, "");
const PRIVATE_KEY = (() => {
  const raw = process.env.X402_PRIVATE_KEY;
  if (raw === undefined || raw.trim() === "") return undefined;
  // Be tolerant about the input shape: accept the key with or without a `0x`
  // prefix and ignore surrounding whitespace, then normalize to canonical
  // `0x`-prefixed lower-hex. A bare 64-hex string is a perfectly valid key and
  // shouldn't silently disable auto-pay.
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Loud failure: the operator clearly intended to enable auto-pay but the
    // key is malformed. Never print the key itself — only its length.
    process.stderr.write(
      `warning: X402_PRIVATE_KEY is set but not a valid 32-byte hex key ` +
        `(got ${hex.length} hex chars after stripping any 0x prefix; expected 64). ` +
        `Auto-pay stays OFF.\n`,
    );
    return undefined;
  }
  return ("0x" + hex.toLowerCase()) as Hex;
})();

/** Parse a non-negative number env var. Unlike `Number(x) || dflt`, this does
 * NOT silently turn an explicit `0` into the default, and rejects negatives. */
function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`warning: ${name}="${raw}" is invalid; using ${dflt}\n`);
    return dflt;
  }
  return n;
}

// Per-call auto-pay ceiling. 0 = disable auto-pay entirely.
const MAX_USD = envNum("X402_MAX_USD", 0.05);
const TIMEOUT_MS = envNum("X402_TIMEOUT_MS", 20_000) || 20_000;
// Process-lifetime caps so a runaway loop / hostile server can't drain the
// wallet one small call at a time. 0 = unlimited (defaults are generous).
const MAX_TOTAL_USD = envNum("X402_MAX_TOTAL_USD", 1.0);
const MAX_CALLS = Math.floor(envNum("X402_MAX_CALLS", 1000));
const AUTO_PAY = PRIVATE_KEY !== undefined && MAX_USD > 0;
const spendTracker = new SpendTracker(MAX_TOTAL_USD, MAX_CALLS);
const PAY_KEY: Hex | undefined = AUTO_PAY ? PRIVATE_KEY : undefined;

/** Exported for unit tests only. */
export async function getJson(
  path: string,
  opts: { headers?: Record<string, string>; params?: Record<string, string | number | undefined> } = {},
): Promise<unknown> {
  const url = new URL(path, API_BASE + "/");
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { accept: "application/json", "user-agent": "x402-trust-mcp/1.5.1", ...(opts.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `HTTP ${res.status} from ${path}`, body: text.slice(0, 500) };
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function asText(obj: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/** Bearer-authed request helper for free watch-management routes (edit/cancel/events). */
async function authedRequest(
  method: string,
  path: string,
  secret: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(path, API_BASE + "/");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "x402-trust-mcp/1.5.1",
        Authorization: `Bearer ${secret}`,
      },
      signal: ctrl.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url.toString(), init);
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      return { error: `HTTP ${res.status} from ${path}`, ...(typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {}) };
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

const server = new McpServer({ name: "x402-trust", version: "1.5.1" });

server.registerTool(
  "x402_ecosystem_stats",
  {
    title: "x402 ecosystem stats (free)",
    description:
      "Free aggregate snapshot of the entire x402 ecosystem (Base + Solana): how many endpoints are listed/active/delisted, what fraction are reachable and spec-compliant, and real on-chain USDC settlement volume / receivers / payers over the last 30 days. Use this to gauge market health before transacting.",
    inputSchema: {},
  },
  async () => asText(await getJson("/trust/stats")),
);

server.registerTool(
  "x402_trust_leaderboard",
  {
    title: "x402 trust leaderboard (free)",
    description:
      "Free top-25 most trustworthy x402 endpoints, ranked by a deterministic trust score (uptime, envelope compliance, latency, age, on-chain settlement activity, price stability). Use this to discover reliable paid endpoints.",
    inputSchema: {},
  },
  async () => asText(await getJson("/trust/leaderboard")),
);

server.registerTool(
  "x402_trust_preview",
  {
    title: "x402 trust preview — full sample reports (free)",
    description:
      "FREE showcase of what x402_trust_score returns. You do NOT choose the endpoint: this returns the COMPLETE paid-grade trust report (every field — exact score, scoreRange, full component breakdown, advertised price, on-chain settlement figures, all flags) for THREE endpoints picked from the current population — the best-scored, the median, and the worst-scored ('samples' each carry 'role', 'populationRank', and the full 'report'). Use it to see exactly what the paid output looks like across the entire quality range BEFORE paying. It cannot score an endpoint you choose — to evaluate YOUR OWN endpoint, call x402_trust_score (paid). Takes no arguments.",
    inputSchema: {},
  },
  async () => asText(await getJson("/v1/x402-trust-preview")),
);

server.registerTool(
  "x402_trust_score",
  {
    title: "x402 trust score for an endpoint (paid)",
    description:
      "Trust score (0-100, grade A-F) for a SPECIFIC x402 endpoint, PLUS a machine-readable verdict ('recommendation': proceed|caution|avoid), the advertised price ('advertised.amountUsd'), a confidence-adjusted band ('scoreRange'), and structured flags ('flagsDetailed' with code/severity/message — any severity 'error' means avoid). Includes the full component breakdown and 30-day on-chain stats. One call answers WHETHER and at WHAT PRICE to use an endpoint. Call this BEFORE paying an unknown x402 endpoint to avoid dead, fraudulent, or recently-hijacked services. Pay-per-call over x402; auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      resource: z.string().describe("Full x402 resource URL to evaluate, e.g. https://api.example.com/v1/thing"),
    },
  },
  async ({ resource }) => {
    const r = await paidPost({
      url: `${API_BASE}/v1/x402-trust`,
      body: { resource },
      ...(PAY_KEY ? { privateKey: PAY_KEY } : {}),
      maxAmountUsd: MAX_USD,
      timeoutMs: TIMEOUT_MS,
      spendTracker,
    });
    return asText(decorate(r));
  },
);

server.registerTool(
  "x402_endpoint_history",
  {
    title: "x402 endpoint observation history (paid)",
    description:
      "Raw observation time-series for a SPECIFIC x402 endpoint: listing/delisting/relisting events, advertised price changes, payTo changes, and probe results (uptime, latency, quoted amount) over the requested window (1-90 days). Pay-per-call over x402; auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      resource: z.string().describe("Full x402 resource URL"),
      days: z.number().int().min(1).max(90).optional().describe("Lookback window in days (default 30)"),
    },
  },
  async ({ resource, days }) => {
    const r = await paidPost({
      url: `${API_BASE}/v1/x402-history`,
      body: { resource, ...(days ? { days } : {}) },
      ...(PAY_KEY ? { privateKey: PAY_KEY } : {}),
      maxAmountUsd: MAX_USD,
      timeoutMs: TIMEOUT_MS,
      spendTracker,
    });
    return asText(decorate(r));
  },
);

const BULK_TIERS: readonly { max: number; path: string }[] = [
  { max: 10, path: "/v1/x402-trust-bulk-10" },
  { max: 50, path: "/v1/x402-trust-bulk-50" },
  { max: 100, path: "/v1/x402-trust-bulk-100" },
  { max: 200, path: "/v1/x402-trust-bulk-200" },
  { max: 500, path: "/v1/x402-trust-bulk-500" },
];

export function pickBulkTier(count: number, requestedTier?: number): { max: number; path: string } {
  if (count > BULK_TIERS[BULK_TIERS.length - 1]!.max) {
    throw new Error(`too many resources: maximum is ${BULK_TIERS[BULK_TIERS.length - 1]!.max}; got ${count}`);
  }
  if (requestedTier !== undefined) {
    const t = BULK_TIERS.find((tier) => tier.max === requestedTier);
    if (!t) throw new Error(`invalid tier ${requestedTier}; valid tiers are ${BULK_TIERS.map((x) => x.max).join(", ")}`);
    if (count > t.max) throw new Error(`tier ${requestedTier} accepts at most ${t.max} resources; got ${count}`);
    return t;
  }
  for (const tier of BULK_TIERS) {
    if (count <= tier.max) return tier;
  }
  throw new Error("unreachable");
}

server.registerTool(
  "x402_trust_bulk",
  {
    title: "x402 bulk trust scoring (paid)",
    description:
      "Score up to 500 x402 endpoints in a SINGLE paid call. Returns the authoritative full-density trust score (0-100, grade A-F, recommendation proceed|caution|avoid), confidence, `probed_at`, `computed_at`, and a `recomputed` flag for each requested resource. Cache rows older than ~15 minutes are recomputed on-demand from the latest stored probes and settlements (no live network re-probe), so bulk scores typically reflect reality within minutes. Per-request recompute limits apply: at most 50 endpoints / 8 seconds are recomputed; the response includes `recompute_limit_hit` and `recompute_limit` so you know if the cap was reached. The smallest tier that fits your request is selected automatically (10/50/100/200/500 endpoints; ~$0.045/$0.20/$0.325/$0.40/$0.50). Resources not in our observation set return `found:false`; you still pay for the batch. For a fresh live probe, use `x402_trust_score`. Pay-per-call over x402; auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      resources: z
        .array(z.string())
        .min(1)
        .max(500)
        .describe("List of full x402 resource URLs (https://...) to score. Duplicates are ignored; max 500."),
      tier: z.union([z.literal(10), z.literal(50), z.literal(100), z.literal(200), z.literal(500)])
        .optional()
        .describe("Optional fixed tier size. If omitted, the cheapest tier that fits `resources` is used."),
    },
  },
  async ({ resources, tier }) => {
    const unique = [...new Set(resources.map((r) => r.trim()))];
    const selected = pickBulkTier(unique.length, tier);
    const r = await paidPost({
      url: `${API_BASE}${selected.path}`,
      body: { resources: unique },
      ...(PAY_KEY ? { privateKey: PAY_KEY } : {}),
      maxAmountUsd: MAX_USD,
      timeoutMs: TIMEOUT_MS,
      spendTracker,
    });
    return asText({ tier: selected.max, ...(decorate(r) as object) });
  },
);

const urlOrUrls = z.union([z.string(), z.array(z.string())]).optional();

server.registerTool(
  "x402_watch_create",
  {
    title: "x402 watch — create 30-day endpoint monitor (paid)",
    description:
      "Start monitoring ONE x402 endpoint for 30 days. Get alerted on changes that break autonomous payment: payTo changes (possible takeover/rug), price changes, asset/network changes, 402-spec regressions, delisting, and liveness down/recovered. A self-healing endpoint that repeatedly blips is auto-detected as `liveness_flapping` and its individual down/up alerts are coalesced into a single flapping notice (plus one 'stopped flapping' notice when it stabilizes) so you are not spammed. Returns a one-time bearer secret + poll URL + renew URL + edit URL + cancel URL + machine-readable `next_steps`. Use x402_watch_events to poll the append-only log, or configure push delivery to one or more signed HTTPS webhooks and/or Slack/Discord incoming webhooks (max 5 each). `webhook_url`/`slack_url` accept a single URL string or an array of URLs. All URLs are connection-tested BEFORE payment — unreachable URLs are rejected with no charge (retry with a corrected URL). On success the response reports per-URL delivery in `delivery.connection_test`. Webhook signature: `x-signature` = 'sha256=' + HMAC-SHA256(body) keyed by hex(sha256(secret)), NOT the raw secret. Pay-per-call over x402 (~$0.20); auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      endpoint: z.string().describe("Full x402 resource URL to watch. It must already be in our observation set."),
      events: z.array(z.string()).optional().describe("Event types to subscribe to (default all): payto_change, price_change, asset_network_change, spec_regression, delisting, liveness_down, liveness_recovered, liveness_flapping, latency_regression."),
      liveness_sensitivity_n: z.number().int().min(1).max(10).optional()
        .describe("Consecutive missed probes before liveness_down surfaces to you (1=paranoid … 10=relaxed; default 2)."),
      webhook_url: urlOrUrls.describe("Optional signed HTTPS webhook URL(s) for push delivery. Single string or array; max 5."),
      slack_url: urlOrUrls.describe("Optional Slack or Discord incoming webhook URL(s). Single string or array; max 5."),
    },
  },
  async ({ endpoint, events, liveness_sensitivity_n, webhook_url, slack_url }) => {
    const body: Record<string, unknown> = { endpoint };
    if (events !== undefined) body.events = events;
    if (liveness_sensitivity_n !== undefined) body.liveness_sensitivity_n = liveness_sensitivity_n;
    const delivery: Record<string, unknown> = {};
    if (webhook_url !== undefined) delivery.webhook_url = webhook_url;
    if (slack_url !== undefined) delivery.slack_url = slack_url;
    if (Object.keys(delivery).length > 0) body.delivery = delivery;
    const r = await paidPost({
      url: `${API_BASE}/v1/watch-endpoint-30d`,
      body,
      ...(PAY_KEY ? { privateKey: PAY_KEY } : {}),
      maxAmountUsd: MAX_USD,
      timeoutMs: TIMEOUT_MS,
      spendTracker,
    });
    return asText(decorateWatch(r));
  },
);

server.registerTool(
  "x402_watch_events",
  {
    title: "x402 watch — poll event log (free)",
    description:
      "Read the append-only event log for an active x402 watch. Returns two streams: `events` (endpoint changes — payTo/price/asset/spec/delisting/liveness) and `watch_events` (lifecycle feedback — created/edited/cancelled/renewed/expiring/expired). Nothing between two polls is lost. Provide the watch_id and the one-time secret from x402_watch_create. Advance `since` with the returned `next_cursor` (endpoint events) and `watch_since` with `watch_events_cursor` (lifecycle events). Cursors/ids are GLOBAL sequences shared across watches (a watch's first event id may be >1); always page by the returned cursor rather than assuming they start at 1. Cancelled watches remain READABLE until expires_at (no new events accrue). If the watch has push delivery, still poll to reconcile missed webhooks.",
    inputSchema: {
      watch_id: z.string().describe("Watch id returned by x402_watch_create."),
      secret: z.string().describe("The one-time bearer secret returned by x402_watch_create."),
      since: z.string().optional().describe("Endpoint-event cursor: the `next_cursor` from a previous poll. Omit for the first poll."),
      watch_since: z.string().optional().describe("Lifecycle-event cursor: the `watch_events_cursor` from a previous poll. Omit for the first poll."),
    },
  },
  async ({ watch_id, secret, since, watch_since }) => {
    return asText(
      await getJson(`/v1/watch/${encodeURIComponent(watch_id)}/events`, {
        headers: { Authorization: `Bearer ${secret}` },
        params: { ...(since ? { since } : {}), ...(watch_since ? { watch_since } : {}) },
      }),
    );
  },
);

server.registerTool(
  "x402_watch_edit",
  {
    title: "x402 watch — edit delivery URLs / sensitivity / events (free)",
    description:
      "Edit an active watch: change webhook/Slack URLs, liveness sensitivity, or subscribed events. Bearer-authed with the secret from x402_watch_create. Newly-added URLs are connection-tested before the change is persisted; if any new URL fails, the existing config is unchanged. Delivery fields are full-replace per channel (omit to leave that channel unchanged). Returns the updated watch view.",
    inputSchema: {
      watch_id: z.string().describe("Watch id returned by x402_watch_create."),
      secret: z.string().describe("The one-time bearer secret returned by x402_watch_create."),
      events: z.array(z.string()).optional().describe("Event types to subscribe to (default all). Omit to keep current events."),
      liveness_sensitivity_n: z.number().int().min(1).max(10).optional().describe("1=paranoid … 10=relaxed. Omit to keep current value."),
      webhook_url: urlOrUrls.describe("Replace webhook URL(s). Single string or array; max 5. Omit to keep current webhook(s)."),
      slack_url: urlOrUrls.describe("Replace Slack/Discord URL(s). Single string or array; max 5. Omit to keep current URL(s)."),
    },
  },
  async ({ watch_id, secret, events, liveness_sensitivity_n, webhook_url, slack_url }) => {
    const body: Record<string, unknown> = {};
    if (events !== undefined) body.events = events;
    if (liveness_sensitivity_n !== undefined) body.liveness_sensitivity_n = liveness_sensitivity_n;
    const delivery: Record<string, unknown> = {};
    if (webhook_url !== undefined) delivery.webhook_url = webhook_url;
    if (slack_url !== undefined) delivery.slack_url = slack_url;
    if (Object.keys(delivery).length > 0) body.delivery = delivery;
    return asText(
      await authedRequest(
        "PATCH",
        `/v1/watch/${encodeURIComponent(watch_id)}`,
        secret,
        Object.keys(body).length > 0 ? body : undefined,
      ),
    );
  },
);

server.registerTool(
  "x402_watch_cancel",
  {
    title: "x402 watch — cancel early (free)",
    description:
      "Soft-cancel a watch immediately: no new events accrue, but the event log stays READABLE via x402_watch_events until the original expires_at (cancel is not a delete). Probing drops back to normal cadence as soon as no active watches cover the endpoint. Bearer-authed with the secret from x402_watch_create. Free and idempotent.",
    inputSchema: {
      watch_id: z.string().describe("Watch id returned by x402_watch_create."),
      secret: z.string().describe("The one-time bearer secret returned by x402_watch_create."),
    },
  },
  async ({ watch_id, secret }) => {
    return asText(await authedRequest("DELETE", `/v1/watch/${encodeURIComponent(watch_id)}`, secret));
  },
);

server.registerTool(
  "x402_watch_renew",
  {
    title: "x402 watch — renew 30 days (paid)",
    description:
      "Extend an active x402 watch by another 30 days before it expires. The secret stays the same. Pay-per-call over x402 (~$0.20); auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      watch_id: z.string().describe("Watch id returned by x402_watch_create."),
    },
  },
  async ({ watch_id }) => {
    const r = await paidPost({
      url: `${API_BASE}/v1/watch/${encodeURIComponent(watch_id)}/renew`,
      body: {},
      ...(PAY_KEY ? { privateKey: PAY_KEY } : {}),
      maxAmountUsd: MAX_USD,
      timeoutMs: TIMEOUT_MS,
      spendTracker,
    });
    return asText(decorateWatch(r));
  },
);

/** Shape the tool result for the agent, with an accurate, non-contradictory
 * hint. Three distinct cases:
 *   1. paid — the server accepted payment and returned the answer.
 *   2. status !== 402 — the server gave a DEFINITIVE non-payment response
 *      (e.g. 404 "endpoint not in our observation set", 400 bad input, 5xx).
 *      This can happen AFTER auto-pay was attempted: the price was within budget,
 *      we paid, and the server still declined for a reason unrelated to payment.
 *      Surface the server's own response — never the price-ceiling hint, which
 *      would be wrong (and self-contradictory when the quote was under the cap).
 *   3. status === 402 — the request genuinely still needs payment: either
 *      auto-pay is off, or the quote exceeded a budget/guard. Show quote + hint.
 */
function decorate(r: Awaited<ReturnType<typeof paidPost>>): unknown {
  if (r.paid) return { paid: true, result: r.data, ...(r.paymentResponse ? { payment: r.paymentResponse } : {}) };

  // Case 2: a real, non-payment server response. The call reached the endpoint
  // and got a verdict that paying again won't change.
  if (r.status !== 402) {
    return {
      paid: false,
      status: r.status,
      // If a quote was parsed, auto-pay was attempted; the server rejected for a
      // reason OTHER than payment. Make that explicit so the agent doesn't read
      // this as a pricing problem. The server marks notCharged when it declined
      // before settling.
      ...(r.quote && AUTO_PAY
        ? { note: `Auto-pay was attempted (quote $${r.quote.amountUsd}, within budget) but the server returned HTTP ${r.status} for a non-payment reason. See detail.` }
        : {}),
      detail: r.data,
    };
  }

  // Case 3: genuinely still 402 — payment required and not made.
  if (r.quote) {
    return {
      paid: false,
      status: 402,
      quote: r.quote,
      hint: AUTO_PAY ? autoPayFailureHint(r.quote.amountUsd, r.data) : notConfiguredHint(r.quote.amountUsd),
      detail: r.data,
    };
  }
  return { paid: false, status: r.status, detail: r.data };
}

const notConfiguredHint = (amountUsd: number): string =>
  `Payment required ($${amountUsd}). Set X402_PRIVATE_KEY (a funded Base USDC wallet) and X402_MAX_USD>0 to enable auto-pay, or pay this x402 quote with your own wallet.`;

/**
 * P2-5: return the hint that actually matches why auto-pay didn't happen, rather
 * than a static "exceeds cap OR guard blocked" disjunction. Inspects the quote
 * vs the configured cap and the server/settle detail text. `>` is a strict
 * over-cap; quote == cap is NOT "exceeds".
 */
export function autoPayFailureHint(amountUsd: number, detail: unknown): string {
  const text = extractDetailText(detail).toLowerCase();
  // (a) Over the configured per-call ceiling.
  if (amountUsd > MAX_USD) {
    return `Quote $${amountUsd} exceeds your per-call cap X402_MAX_USD $${MAX_USD}. Raise X402_MAX_USD to at least $${amountUsd} to auto-pay.`;
  }
  // (b) Settlement failed for lack of funds (payer wallet balance too low).
  if (text.includes("insufficient_funds") || text.includes("insufficient funds") || text.includes("balance")) {
    const payer = extractPayer(detail);
    return `Payment signed but settlement failed: wallet balance too low${payer ? ` (payer ${payer})` : ""}. Fund the Base USDC wallet behind X402_PRIVATE_KEY.`;
  }
  // (c) Session/total spend or call-count guard tripped.
  if (text.includes("spend cap") || text.includes("call cap")) {
    return `Auto-pay blocked by a session spend/call-count guard (X402_MAX_TOTAL_USD / X402_MAX_CALLS). See detail.`;
  }
  // (d) SSRF/asset/chain guard refused the quote.
  if (text.includes("unsafe payment quote") || text.includes("not in allow-list") || text.includes("canonical usdc")) {
    return `Auto-pay blocked by the asset/chain/payTo safety guard for this quote. See detail.`;
  }
  // (e) Fallback: point at the concrete detail rather than guessing.
  return `Quote $${amountUsd} was not auto-paid. See detail for the specific reason.`;
}

function extractDetailText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const o = detail as Record<string, unknown>;
    const parts = [o.error, o.errorReason, o.errorMessage, o.detail, o.reason]
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) return parts.join(" ");
    try {
      return JSON.stringify(detail);
    } catch {
      return "";
    }
  }
  return "";
}

function extractPayer(detail: unknown): string | null {
  if (detail && typeof detail === "object") {
    const o = detail as Record<string, unknown>;
    if (typeof o.payer === "string") return o.payer;
  }
  return null;
}

/** Like `decorate`, but adds a prominent secret-once reminder for watch create. */
function decorateWatch(r: Awaited<ReturnType<typeof paidPost>>): unknown {
  const base = decorate(r) as Record<string, unknown>;
  if (r.paid && typeof r.data === "object" && r.data !== null && "secret" in r.data) {
    return {
      ...base,
      important: "The `secret` above is shown only once. Store it in a secrets manager now; if lost, create a new watch.",
    };
  }
  return base;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP channel.
  process.stderr.write(
    `x402-trust MCP server ready (api=${API_BASE}, autoPay=${AUTO_PAY ? "on" : "off"}, ` +
      `maxUsd=${MAX_USD}, maxTotalUsd=${MAX_TOTAL_USD}, maxCalls=${MAX_CALLS})\n`,
  );
}

void main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
