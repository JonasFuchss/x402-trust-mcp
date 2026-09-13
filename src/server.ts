#!/usr/bin/env node
/**
 * x402-trust MCP server (stdio build, published as the `x402-trust-mcp` npm
 * package).
 *
 * Lets ANY MCP-capable agent (Claude Desktop, Coinbase AgentKit, Cursor, …)
 * query trust & reliability data about x402 endpoints before paying them.
 * This is the agent-to-agent distribution surface: an agent that must decide
 * "should I trust this paid endpoint?" installs this and gets the answer.
 *
 * The tool surface (names, titles, descriptions, input schemas and the mapping
 * from tool args to backend HTTP calls) is SINGLE-SOURCED in ./tool-spec.ts and
 * shared with the hosted Streamable-HTTP endpoint (POST /mcp on
 * x402-trust.com, hosted alongside the public API) so the two
 * distributions cannot drift apart. This file only adds the stdio transport
 * and the client-side payment flow.
 *
 * Tools (12): free — x402_ecosystem_stats, x402_trust_leaderboard,
 * x402_trust_preview, x402_watch_events, x402_watch_edit, x402_watch_cancel;
 * paid — x402_trust_score, x402_endpoint_history, x402_find_alternatives,
 * x402_trust_bulk, x402_watch_create, x402_watch_renew.
 *
 * Paid tools quote the price and, if X402_PRIVATE_KEY is set (a funded Base
 * USDC wallet) and the quote is within X402_MAX_USD, auto-pay over x402.
 * Without a key they return the quote so the host can pay.
 *
 * Config via env:
 *   X402_TRUST_API_BASE   default https://x402-trust.com
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
import type { Hex } from "viem";
import { paidPost, SpendTracker } from "./pay.js";
import {
  MCP_SERVER_NAME,
  MCP_VERSION,
  MCP_USER_AGENT,
  TRUST_TOOL_SPECS,
  buildBackendRequest,
  type BackendCall,
  type ToolArgs,
  type TrustToolSpec,
} from "./tool-spec.js";

// pickBulkTier moved to tool-spec.ts (shared with the hosted endpoint);
// re-export so existing imports of "./server.js" keep working.
export { pickBulkTier } from "./tool-spec.js";

const API_BASE = (process.env.X402_TRUST_API_BASE ?? "https://x402-trust.com").replace(/\/$/, "");
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
      headers: { accept: "application/json", "user-agent": MCP_USER_AGENT, ...(opts.headers ?? {}) },
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
        "user-agent": MCP_USER_AGENT,
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

const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_VERSION });

/** Execute a free tool call against the public API. GET reads (stats,
 * leaderboard, preview, watch events) go through getJson; watch edit/cancel
 * are bearer-authed PATCH/DELETE via authedRequest. */
function freeCall(call: BackendCall): Promise<unknown> {
  if (call.method === "GET") {
    return getJson(call.path, {
      ...(call.params !== undefined ? { params: call.params } : {}),
      ...(call.authorization !== undefined ? { headers: { Authorization: call.authorization } } : {}),
    });
  }
  return authedRequest(call.method, call.path, (call.authorization ?? "").replace(/^Bearer /, ""), call.body);
}

/** Execute a paid tool call: auto-pay over x402 when configured, else return
 * the quote. decorate()/decorateWatch() shape the tool result. */
async function paidCall(spec: TrustToolSpec, call: BackendCall, args: ToolArgs): Promise<unknown> {
  const r = await paidPost({
    url: `${API_BASE}${call.path}`,
    body: call.body ?? {},
    ...(PAY_KEY ? { privateKey: PAY_KEY } : {}),
    maxAmountUsd: MAX_USD,
    timeoutMs: TIMEOUT_MS,
    spendTracker,
  });
  const data = r.paid && spec.backend.augmentResult ? spec.backend.augmentResult(args, r.data) : r.data;
  const shaped = { ...r, data };
  return spec.watchSecretDecoration ? decorateWatch(shaped) : decorate(shaped);
}

for (const spec of TRUST_TOOL_SPECS) {
  server.registerTool(
    spec.name,
    { title: spec.title, description: spec.description, inputSchema: spec.inputSchema },
    async (args) => {
      const toolArgs = args as ToolArgs;
      const call = buildBackendRequest(spec, toolArgs);
      if (!spec.backend.paid) return asText(await freeCall(call));
      return asText(await paidCall(spec, call, toolArgs));
    },
  );
}

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
