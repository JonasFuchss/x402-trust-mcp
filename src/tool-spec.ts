/**
 * x402-trust MCP tool surface — SINGLE SOURCE OF TRUTH, shared by both
 * distributions of the server:
 *
 *   1. the npm package (`x402-trust-mcp`, stdio, runs on the user's machine,
 *      pays the public API over x402 with the user's key), and
 *   2. the hosted Streamable-HTTP endpoint `POST /mcp` on x402-trust.com
 *      (zero-install; free tools open, paid tools settle via a forwarded
 *      PAYMENT-SIGNATURE header).
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
export const MCP_VERSION = "1.17.0";
/** User-Agent the npm (stdio) build sends to the public API. */
export const MCP_USER_AGENT = `x402-trust-mcp/${MCP_VERSION}`;

/** Validated tool arguments as they arrive from the SDK (post-zod-parse). */
export type ToolArgs = Record<string, unknown>;

export type ToolMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** One concrete HTTP call against the public x402-trust API, derived from a
 * tool call. Both executors turn this into an actual fetch: the npm package
 * targets https://x402-trust.com (paidPost with the user's key), the hosted
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
// The tool surface (15 tools: 9 free, 6 paid)
// ---------------------------------------------------------------------------

export const TRUST_TOOL_SPECS: readonly TrustToolSpec[] = [
  {
    name: "x402_ecosystem_stats",
    title: "x402 Trust ecosystem stats",
    description:
      "Snapshot of the whole x402 ecosystem: endpoint counts, reachability, and real USDC settlement volume over 30 days. Use it to gauge market health.",
    inputSchema: {},
    backend: { paid: false, method: "GET", build: () => ({ path: "/trust/stats" }) },
  },
  {
    name: "x402_trust_leaderboard",
    title: "x402 Trust leaderboard",
    description:
      "Top-100 ranking of the most trustworthy x402 hosts, scored by their whole measured surface. Page with offset, then use x402_search to list a host's endpoints.",
    inputSchema: {
      limit: z.number().int().min(1).max(25).optional().describe("Page size (1-25, default 25)"),
      offset: z.number().int().min(0).optional().describe("Skip this many ranked hosts for the next page (default 0). The board holds at most 100 hosts."),
    },
    backend: {
      paid: false,
      method: "GET",
      build: (args) => {
        const params: Record<string, string> = {};
        const limit = numArg(args, "limit");
        if (limit !== undefined) params.limit = String(limit);
        const offset = numArg(args, "offset");
        if (offset !== undefined) params.offset = String(offset);
        return { path: "/trust/leaderboard", ...(Object.keys(params).length > 0 ? { params } : {}) };
      },
    },
  },
  {
    name: "x402_verified_providers",
    title: "x402 Trust verified providers",
    description:
      "List of hosts that proved domain control and confirmed a contact email. Verification is informational only, it never changes the score.",
    inputSchema: {
      limit: z.number().int().min(1).max(25).optional().describe("Page size (1-25, default 25)"),
      offset: z.number().int().min(0).optional().describe("Skip this many providers for the next page (default 0)"),
    },
    backend: {
      paid: false,
      method: "GET",
      build: (args) => {
        const params: Record<string, string> = {};
        const limit = numArg(args, "limit");
        if (limit !== undefined) params.limit = String(limit);
        const offset = numArg(args, "offset");
        if (offset !== undefined) params.offset = String(offset);
        return { path: "/verified.json", ...(Object.keys(params).length > 0 ? { params } : {}) };
      },
    },
  },
  {
    name: "x402_search",
    title: "Keyword search over the x402 catalog",
    description:
      "Substring search over host, URL and service name across the catalog. For meaning-based search use x402_semantic_search instead.",
    inputSchema: {
      query: z.string().min(1).max(100).describe("Substring matched against host, resource URL and service name, e.g. a domain like 'nsgoods.org' or a path like '/v1/weather'. Matching is literal, not by meaning."),
      limit: z.number().int().min(1).max(25).optional().describe("Page size (1-25, default 25)"),
      offset: z.number().int().min(0).optional().describe("Skip this many matches for the next page (default 0)"),
    },
    backend: {
      paid: false,
      method: "GET",
      build: (args) => {
        const params: Record<string, string> = { q: strArg(args, "query") };
        const limit = numArg(args, "limit");
        if (limit !== undefined) params.limit = String(limit);
        const offset = numArg(args, "offset");
        if (offset !== undefined) params.offset = String(offset);
        return { path: "/trust/search", params };
      },
    },
  },
  {
    name: "x402_trust_preview",
    title: "x402 Trust preview: full sample reports",
    description:
      "Sample pack: three complete trust reports (best, median, worst) exactly as x402_trust_score returns them. Takes no arguments.",
    inputSchema: {},
    backend: { paid: false, method: "GET", build: () => ({ path: "/v1/x402-trust-preview" }) },
  },
  {
    name: "x402_trust_score",
    title: "x402 Trust score for an endpoint",
    description:
      "The full trust verdict for one x402 endpoint: score 0-100, grade, recommendation (proceed, caution, avoid, ...), price, and flags. Unknown endpoints get live-probed on the spot.",
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
    title: "x402 Trust endpoint observation history",
    description:
      "Raw probe and event history for one endpoint over 1-90 days: price and payTo changes, failures, latencies, plus a summary. Excluded probes never count as downtime.",
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
    title: "Find better-scored alternatives to an x402 endpoint",
    description:
      "Finds semantically similar endpoints that out-score a given one. Empty result means nothing beats it.",
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
    name: "x402_semantic_search",
    title: "Semantic search over the x402 catalog",
    description:
      "Meaning-based search across the catalog: describe the capability you need in plain words. Discovery only, no verdicts.",
    inputSchema: {
      query: z.string().min(2).max(500).describe("Free-text search query, e.g. \"weather forecast\". Describe the capability you need in plain words; matching is by meaning, not substrings."),
      limit: z.number().int().min(1).max(25).optional().describe("Max matches to return (1-25, default 25)"),
    },
    backend: {
      paid: false,
      method: "POST",
      build: (args) => {
        const body: Record<string, unknown> = { query: strArg(args, "query") };
        const limit = numArg(args, "limit");
        if (limit !== undefined) body.limit = limit;
        return { path: "/v1/semantic-search", body };
      },
    },
  },
  {
    name: "x402_trust_bulk",
    title: "x402 Trust bulk scoring",
    description:
      "Score up to 500 endpoints in one call; the cheapest fitting tier is picked automatically. Unknown URLs come back found:false, the batch is charged either way.",
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
    title: "x402 Trust watch: create 30-day endpoint monitor",
    description:
      "30-day monitor for one endpoint with alerts on payTo or price changes, delisting, spec regressions and downtime, via polling or webhooks. Returns a one-time secret, keep it.",
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
    title: "x402 Trust watch: poll event log",
    description:
      "Poll a watch's event log with watch_id and secret, paging by the returned cursors. Nothing between polls is lost.",
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
    title: "x402 Trust watch: edit delivery URLs, sensitivity or events",
    description:
      "Change a watch's webhook URLs, sensitivity or subscribed events. New URLs are tested first; failures leave the old config untouched.",
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
    title: "x402 Trust watch: cancel early",
    description:
      "Stop a watch now; its log stays readable until expiry. Idempotent.",
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
    title: "x402 Trust watch: renew 30 days",
    description:
      "Add another 30 days to an active watch. Same secret.",
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
