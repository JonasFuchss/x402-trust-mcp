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

async function getJson(path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { accept: "application/json", "user-agent": "x402-trust-mcp/1.0" },
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

const server = new McpServer({ name: "x402-trust", version: "1.3.0" });

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

/** Add a human-readable hint when a paid call returned only a quote. */
function decorate(r: Awaited<ReturnType<typeof paidPost>>): unknown {
  if (r.paid) return { paid: true, result: r.data, ...(r.paymentResponse ? { payment: r.paymentResponse } : {}) };
  if (r.quote) {
    return {
      paid: false,
      quote: r.quote,
      hint: AUTO_PAY
        ? `Quote $${r.quote.amountUsd} not auto-paid (exceeds X402_MAX_USD $${MAX_USD}, or a spend/asset guard blocked it). See detail.`
        : `Payment required ($${r.quote.amountUsd}). Set X402_PRIVATE_KEY (a funded Base USDC wallet) and X402_MAX_USD>0 to enable auto-pay, or pay this x402 quote with your own wallet.`,
      detail: r.data,
    };
  }
  return { paid: false, status: r.status, detail: r.data };
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
