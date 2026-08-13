/**
 * x402-trust MCP tool surface — SINGLE SOURCE OF TRUTH, shared by both
 * distributions of the server:
 *
 *   1. the npm package (`x402-trust-mcp`, stdio, runs on the user's machine,
 *      pays the public API over x402 with the user's key), and
 *   2. the hosted Streamable-HTTP endpoint `POST /mcp` on x402.fuchss.app
 *      (zero-install; free tools open, paid tools settle via a forwarded
 *      PAYMENT-SIGNATURE header — see packages/reseller/src/mcp-hosted.ts).
 *
 * Both register their tools from TRUST_TOOL_SPECS and build the SAME backend
 * HTTP call from tool args via buildBackendRequest(), so the two surfaces
 * cannot drift apart: names, titles, descriptions and input schemas are
 * literally one object graph.
 *
 * This module is deliberately free of any MCP-SDK or HTTP-client imports so
 * the reseller can compile it standalone. It only depends on zod (schemas)
 * and its own types.
 */
import { z } from "zod";

/** Server identity reported in the MCP handshake (both transports). */
export const MCP_SERVER_NAME = "x402-trust";
export const MCP_VERSION = "1.8.0";
/** User-Agent the npm (stdio) build sends to the public API. */
export const MCP_USER_AGENT = `x402-trust-mcp/${MCP_VERSION}`;

/** Validated tool arguments as they arrive from the SDK (post-zod-parse). */
export type ToolArgs = Record<string, unknown>;

export type ToolMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** One concrete HTTP call against the public x402-trust API, derived from a
 * tool call. Both executors turn this into an actual fetch: the npm package
 * targets https://x402.fuchss.app (paidPost with the user's key), the hosted
 * endpoint targets the reseller's own loopback and forwards the caller's
 * payment header verbatim. */
export interface BackendCall {
  method: ToolMethod;
  /** Fully-resolved path (path params encoded), no query string. */
  path: string;
  /** JSON body for POST/PATCH. Absent for GET/DELETE. */
  body?: Record<string, unknown>;
  /** Query params (already stringified). */
  params?: Record<string, string>;
  /** Full Authorization header value ("Bearer …") for bearer-secret tools. */
  authorization?: string;
}

export interface TrustToolSpec {
  name: string;
  title: string;
  description: string;
  /** Raw zod shape handed to McpServer.registerTool({ inputSchema }). */
  inputSchema: Record<string, z.ZodTypeAny>;
  backend: {
    /** Paid tools require x402 payment; the executors surface a quote when
     * unsettled instead of executing. */
    paid: boolean;
    method: ToolMethod;
    build: (args: ToolArgs) => Omit<BackendCall, "method">;
    /** Optional result augmentation applied to a SUCCESSFUL (2xx) paid call
     * before decoration (used by bulk to echo the selected tier). */
    augmentResult?: (args: ToolArgs, data: unknown) => unknown;
  };
  /** Watch-create/renew responses embed the decorateWatch "secret shown once"
   * warning in the npm package; the hosted endpoint mirrors it. */
  watchSecretDecoration?: true;
}

const urlOrUrls = z.union([z.string(), z.array(z.string())]).optional();

// ---------------------------------------------------------------------------
// x402_trust_bulk tier selection (shared so npm and hosted pick identically)
// ---------------------------------------------------------------------------

export const BULK_TIERS: readonly { max: number; path: string }[] = [
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

// ---------------------------------------------------------------------------
// Per-tool backend builders
// ---------------------------------------------------------------------------

function strArg(args: ToolArgs, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function numArg(args: ToolArgs, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArrArg(args: ToolArgs, key: string): string[] | undefined {
  const v = args[key];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function watchPath(args: ToolArgs, suffix: string): string {
  return `/v1/watch/${encodeURIComponent(strArg(args, "watch_id"))}${suffix}`;
}

function bearerAuth(args: ToolArgs): { authorization: string } {
  return { authorization: `Bearer ${strArg(args, "secret")}` };
}

/** Assemble the delivery block for watch create/edit exactly like the npm
 * client does: only when at least one channel is present. */
function deliveryBlock(args: ToolArgs): Record<string, unknown> | undefined {
  const delivery: Record<string, unknown> = {};
  if (args.webhook_url !== undefined) delivery.webhook_url = args.webhook_url;
  if (args.slack_url !== undefined) delivery.slack_url = args.slack_url;
  return Object.keys(delivery).length > 0 ? delivery : undefined;
}

// ---------------------------------------------------------------------------
// The tool surface (12 tools: 6 free, 6 paid)
// ---------------------------------------------------------------------------

export const TRUST_TOOL_SPECS: readonly TrustToolSpec[] = [
  {
    name: "x402_ecosystem_stats",
    title: "x402 ecosystem stats (free)",
    description:
      "Free aggregate snapshot of the entire x402 ecosystem (Base + Solana): how many endpoints are listed/active/delisted, what fraction are reachable and spec-compliant, and real on-chain USDC settlement volume / receivers / payers over the last 30 days. Use this to gauge market health before transacting.",
    inputSchema: {},
    backend: { paid: false, method: "GET", build: () => ({ path: "/trust/stats" }) },
  },
  {
    name: "x402_trust_leaderboard",
    title: "x402 trust leaderboard (free)",
    description:
      "Free top-25 most trustworthy x402 endpoints, ranked by a deterministic trust score (uptime, envelope compliance, latency, age, on-chain settlement activity, price stability). Latency is measured from a single EU vantage point and includes network distance to the endpoint (so it is only lightly weighted). Use this to discover reliable paid endpoints.",
    inputSchema: {},
    backend: { paid: false, method: "GET", build: () => ({ path: "/trust/leaderboard" }) },
  },
  {
    name: "x402_trust_preview",
    title: "x402 trust preview — full sample reports (free)",
    description:
      "FREE showcase of what x402_trust_score returns. You do NOT choose the endpoint: this returns the COMPLETE paid-grade trust report (every field — exact score, scoreRange, full component breakdown, advertised price, on-chain settlement figures, all flags) for THREE endpoints picked from the current population — the best-scored, the median, and the worst-scored ('samples' each carry 'role', 'populationRank', and the full 'report'). Use it to see exactly what the paid output looks like across the entire quality range BEFORE paying. It cannot score an endpoint you choose — to evaluate YOUR OWN endpoint, call x402_trust_score (paid). Takes no arguments.",
    inputSchema: {},
    backend: { paid: false, method: "GET", build: () => ({ path: "/v1/x402-trust-preview" }) },
  },
  {
    name: "x402_trust_score",
    title: "x402 trust score for an endpoint (paid)",
    description:
      "Trust score (0-100, grade A-F, or '?' when unmeasured) for a SPECIFIC x402 endpoint -- cataloged or not (uncataloged endpoints are live-probed on first query, auto-adopted, score carries a low-confidence first-contact flag). PLUS a machine-readable verdict ('recommendation': proceed|caution|avoid|parameterize|unverified|not-payable), the advertised price ('advertised.amountUsd'), a confidence-adjusted band ('scoreRange'), and structured flags ('flagsDetailed' with code/severity/message; any severity 'error' means avoid). The 'parameterize' verdict (with 'templated':true) means the resource URL still contains an unresolved template placeholder (e.g. {slug}, :slug or %7B…%7D) but we DO have a real signal (scored probes or a discovery fallback): substitute a valid value first, then the health metrics apply to the resolved URL. The 'unverified' verdict (grade '?') means we have NO measurement at all (every probe excluded and no discovery payment requirements to fall back on): it is unknown, not bad, so verify the endpoint yourself before paying. The 'not-payable' verdict (grade '?') means the URL answers a 402 with an EMPTY accepts[] (an auth/API-key gate such as sign-in-with-x), so it is not an x402-payable resource at all and there is nothing to settle. For templated per-item endpoints that ARE payable, a varying payTo/price is EXPECTED (one wallet/price per item): the report surfaces 'stats.payToVaries'+'payToDistinct30d' and 'advertised.amountRange30d' as a 'payto-varies'/'price-varies' note rather than a 'payto-changed-recently' hijack error; always pay the payTo in the live 402 quote, not a cached listing. 'stats.scoredProbes30d' vs 'stats.excluded30d' show how many probes actually back the score. Includes the full component breakdown, the provider-advertised 'serviceName' and 'description' (unverified provider claims, shown next to our independent metrics), and 30-day on-chain stats. Note: 'stats.avgLatencyMs' is measured from a single EU vantage point and includes network distance to the endpoint (see 'stats.latencyVantage'), so a geographically distant endpoint reads slower even when its server is fast. One call answers WHETHER and at WHAT PRICE to use an endpoint. Call this BEFORE paying an unknown x402 endpoint to avoid dead, fraudulent, or recently-hijacked services. Pay-per-call over x402; auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      resource: z.string().describe("Full x402 resource URL to evaluate, e.g. https://api.example.com/v1/thing"),
    },
    backend: {
      paid: true,
      method: "POST",
      build: (args) => ({ path: "/v1/x402-trust", body: { resource: strArg(args, "resource") } }),
    },
  },
  {
    name: "x402_endpoint_history",
    title: "x402 endpoint observation history (paid)",
    description:
      "Raw observation time-series for a SPECIFIC x402 endpoint: listing/delisting/relisting events, advertised price changes, payTo changes, and probe results (uptime, latency, quoted amount) over the requested window (1-90 days). Per-probe 'latencyMs' is measured from a single EU vantage point and includes network distance to the endpoint. Pay-per-call over x402; auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      resource: z.string().describe("Full x402 resource URL"),
      days: z.number().int().min(1).max(90).optional().describe("Lookback window in days (default 30)"),
    },
    backend: {
      paid: true,
      method: "POST",
      build: (args) => {
        const body: Record<string, unknown> = { resource: strArg(args, "resource") };
        const days = numArg(args, "days");
        if (days !== undefined) body.days = days;
        return { path: "/v1/x402-history", body };
      },
    },
  },
  {
    name: "x402_find_alternatives",
    title: "Find better-scored alternatives to an x402 endpoint (paid)",
    description:
      "Given an x402 endpoint URL, returns the top semantically-similar endpoints (matched on advertised purpose via description embeddings) that currently OUT-SCORE it on the deterministic trust score. Use this to route away from a mediocre/dead/expensive endpoint toward a more reliable, better-settled one serving the SAME function — e.g. before paying, check if a higher-graded equivalent exists. Each alternative carries its trust 'score', 'grade', 'recommendation', cosine 'similarity' (0-1), 'amountUsd' price, and a free 'endpointPage' URL. Same-host siblings and 'avoid'-flagged endpoints are excluded. An empty 'alternatives' array is a valid answer meaning nothing beats the subject. Similarity is independent of latency/geography. Pay-per-call over x402 (~$0.005); auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      resource: z.string().describe("Full x402 resource URL to find better alternatives for, e.g. https://api.example.com/v1/thing"),
      limit: z.number().int().min(1).max(25).optional().describe("Max alternatives to return (1-25, default 5)"),
      minScoreDelta: z.number().min(0).optional().describe("Minimum trust-score advantage an alternative must have over the subject (default 5)"),
    },
    backend: {
      paid: true,
      method: "POST",
      build: (args) => {
        const body: Record<string, unknown> = { resource: strArg(args, "resource") };
        const limit = numArg(args, "limit");
        if (limit !== undefined) body.limit = limit;
        const minScoreDelta = numArg(args, "minScoreDelta");
        if (minScoreDelta !== undefined) body.minScoreDelta = minScoreDelta;
        return { path: "/v1/similar", body };
      },
    },
  },
  {
    name: "x402_trust_bulk",
    title: "x402 bulk trust scoring (paid)",
    description:
      "Score up to 500 x402 endpoints in a SINGLE paid call. Returns the authoritative full-density trust score (0-100, grade A-F or '?' when unmeasured, recommendation proceed|caution|avoid|parameterize|unverified|not-payable), confidence, `probed_at`, `computed_at`, and a `recomputed` flag for each requested resource. Cache rows older than ~15 minutes are recomputed on-demand from the latest stored probes and settlements (no live network re-probe), so bulk scores typically reflect reality within minutes. Per-request recompute limits apply: at most 50 endpoints / 8 seconds are recomputed; the response includes `recompute_limit_hit` and `recompute_limit` so you know if the cap was reached. The smallest tier that fits your request is selected automatically (10/50/100/200/500 endpoints; ~$0.045/$0.20/$0.325/$0.40/$0.50). Resources not in our observation set return `found:false`; you still pay for the batch. For a fresh live probe, use `x402_trust_score`. Pay-per-call over x402; auto-pays if a wallet is configured, otherwise returns the price quote.",
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
    backend: {
      paid: true,
      method: "POST",
      build: (args) => {
        const raw = strArrArg(args, "resources") ?? [];
        const unique = [...new Set(raw.map((r) => r.trim()))];
        const tierArg = numArg(args, "tier");
        const selected = pickBulkTier(unique.length, tierArg);
        return { path: selected.path, body: { resources: unique } };
      },
      augmentResult: (args, data) => {
        const raw = strArrArg(args, "resources") ?? [];
        const unique = [...new Set(raw.map((r) => r.trim()))];
        const tierArg = numArg(args, "tier");
        const selected = pickBulkTier(unique.length, tierArg);
        return { tier: selected.max, ...(typeof data === "object" && data !== null ? (data as object) : { data }) };
      },
    },
  },
  {
    name: "x402_watch_create",
    title: "x402 watch — create 30-day endpoint monitor (paid)",
    description:
      "Start monitoring ONE x402 endpoint for 30 days. Get alerted on changes that break autonomous payment: payTo changes (possible takeover/rug — but for a templated per-item endpoint a payTo move is expected variance and is delivered as severity 'warn', not 'critical'), price changes, asset/network changes, 402-spec regressions, delisting, and liveness down/recovered. A self-healing endpoint that repeatedly blips is auto-detected as `liveness_flapping` and its individual down/up alerts are coalesced into a single flapping notice (plus one 'stopped flapping' notice when it stabilizes) so you are not spammed. Returns a one-time bearer secret + poll URL + renew URL + edit URL + cancel URL + machine-readable `next_steps`. Use x402_watch_events to poll the append-only log, or configure push delivery to one or more signed HTTPS webhooks and/or Slack/Discord incoming webhooks (max 5 each). `webhook_url`/`slack_url` accept a single URL string or an array of URLs. All URLs are connection-tested BEFORE payment — unreachable URLs are rejected with no charge (retry with a corrected URL). On success the response reports per-URL delivery in `delivery.connection_test`. Webhook signature: `x-signature` = 'sha256=' + HMAC-SHA256(body) keyed by hex(sha256(secret)), NOT the raw secret. Pay-per-call over x402 (~$0.20); auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      endpoint: z.string().describe("Full x402 resource URL to watch. It must already be in our observation set."),
      events: z.array(z.string()).optional().describe("Event types to subscribe to (default all): payto_change, price_change, asset_network_change, spec_regression, delisting, liveness_down, liveness_recovered, liveness_flapping, latency_regression."),
      liveness_sensitivity_n: z.number().int().min(1).max(10).optional()
        .describe("Consecutive missed probes before liveness_down surfaces to you (1=paranoid … 10=relaxed; default 2)."),
      webhook_url: urlOrUrls.describe("Optional signed HTTPS webhook URL(s) for push delivery. Single string or array; max 5."),
      slack_url: urlOrUrls.describe("Optional Slack or Discord incoming webhook URL(s). Single string or array; max 5."),
    },
    backend: {
      paid: true,
      method: "POST",
      build: (args) => {
        const body: Record<string, unknown> = { endpoint: strArg(args, "endpoint") };
        const events = strArrArg(args, "events");
        if (events !== undefined) body.events = events;
        const sens = numArg(args, "liveness_sensitivity_n");
        if (sens !== undefined) body.liveness_sensitivity_n = sens;
        const delivery = deliveryBlock(args);
        if (delivery !== undefined) body.delivery = delivery;
        return { path: "/v1/watch-endpoint-30d", body };
      },
    },
    watchSecretDecoration: true,
  },
  {
    name: "x402_watch_events",
    title: "x402 watch — poll event log (free)",
    description:
      "Read the append-only event log for an active x402 watch. Returns two streams: `events` (endpoint changes — payTo/price/asset/spec/delisting/liveness) and `watch_events` (lifecycle feedback — created/edited/cancelled/renewed/expiring/expired). Nothing between two polls is lost. Provide the watch_id and the one-time secret from x402_watch_create. Advance `since` with the returned `next_cursor` (endpoint events) and `watch_since` with `watch_events_cursor` (lifecycle events). Cursors/ids are GLOBAL sequences shared across watches (a watch's first event id may be >1); always page by the returned cursor rather than assuming they start at 1. Cancelled watches remain READABLE until expires_at (no new events accrue). If the watch has push delivery, still poll to reconcile missed webhooks.",
    inputSchema: {
      watch_id: z.string().describe("Watch id returned by x402_watch_create."),
      secret: z.string().describe("The one-time bearer secret returned by x402_watch_create."),
      since: z.string().optional().describe("Endpoint-event cursor: the `next_cursor` from a previous poll. Omit for the first poll."),
      watch_since: z.string().optional().describe("Lifecycle-event cursor: the `watch_events_cursor` from a previous poll. Omit for the first poll."),
    },
    backend: {
      paid: false,
      method: "GET",
      build: (args) => {
        const params: Record<string, string> = {};
        const since = strArg(args, "since");
        if (since !== "") params.since = since;
        const watchSince = strArg(args, "watch_since");
        if (watchSince !== "") params.watch_since = watchSince;
        return {
          path: watchPath(args, "/events"),
          ...bearerAuth(args),
          ...(Object.keys(params).length > 0 ? { params } : {}),
        };
      },
    },
  },
  {
    name: "x402_watch_edit",
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
    backend: {
      paid: false,
      method: "PATCH",
      build: (args) => {
        const body: Record<string, unknown> = {};
        const events = strArrArg(args, "events");
        if (events !== undefined) body.events = events;
        const sens = numArg(args, "liveness_sensitivity_n");
        if (sens !== undefined) body.liveness_sensitivity_n = sens;
        const delivery = deliveryBlock(args);
        if (delivery !== undefined) body.delivery = delivery;
        return {
          path: watchPath(args, ""),
          ...bearerAuth(args),
          ...(Object.keys(body).length > 0 ? { body } : {}),
        };
      },
    },
  },
  {
    name: "x402_watch_cancel",
    title: "x402 watch — cancel early (free)",
    description:
      "Soft-cancel a watch immediately: no new events accrue, but the event log stays READABLE via x402_watch_events until the original expires_at (cancel is not a delete). Probing drops back to normal cadence as soon as no active watches cover the endpoint. Bearer-authed with the secret from x402_watch_create. Free and idempotent.",
    inputSchema: {
      watch_id: z.string().describe("Watch id returned by x402_watch_create."),
      secret: z.string().describe("The one-time bearer secret returned by x402_watch_create."),
    },
    backend: {
      paid: false,
      method: "DELETE",
      build: (args) => ({ path: watchPath(args, ""), ...bearerAuth(args) }),
    },
  },
  {
    name: "x402_watch_renew",
    title: "x402 watch — renew 30 days (paid)",
    description:
      "Extend an active x402 watch by another 30 days before it expires. The secret stays the same. Pay-per-call over x402 (~$0.20); auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      watch_id: z.string().describe("Watch id returned by x402_watch_create."),
    },
    backend: {
      paid: true,
      method: "POST",
      build: (args) => ({ path: watchPath(args, "/renew"), body: {} }),
    },
    watchSecretDecoration: true,
  },
];

export function getToolSpec(name: string): TrustToolSpec | undefined {
  return TRUST_TOOL_SPECS.find((s) => s.name === name);
}

/** Turn a validated tool call into the concrete backend HTTP call. Throws on
 * structurally-invalid args (the SDK zod-validates before handlers run, so a
 * throw here means a caller bypassed validation). */
export function buildBackendRequest(spec: TrustToolSpec, args: ToolArgs): BackendCall {
  const built = spec.backend.build(args);
  return { method: spec.backend.method, ...built };
}
