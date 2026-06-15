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
 *   X402_MAX_USD          default 0.05 — auto-pay ceiling per call
 *   X402_TIMEOUT_MS       default 20000
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Hex } from "viem";
import { paidPost } from "./pay.js";

const API_BASE = (process.env.X402_TRUST_API_BASE ?? "https://x402.fuchss.app").replace(/\/$/, "");
const PRIVATE_KEY = (() => {
  const k = process.env.X402_PRIVATE_KEY;
  return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : undefined;
})();
const MAX_USD = Number(process.env.X402_MAX_USD ?? "0.05") || 0.05;
const TIMEOUT_MS = Number(process.env.X402_TIMEOUT_MS ?? "20000") || 20_000;

async function getJson(path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { accept: "application/json", "user-agent": "x402-trust-mcp/1.0" },
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function asText(obj: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: "x402-trust", version: "1.0.0" });

server.registerTool(
  "x402_ecosystem_stats",
  {
    title: "x402 ecosystem stats (free)",
    description:
      "Free aggregate snapshot of the entire x402 ecosystem on Base: how many endpoints are listed/active/delisted, what fraction are reachable and spec-compliant, and real on-chain USDC settlement volume / receivers / payers over the last 30 days. Use this to gauge market health before transacting.",
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
  "x402_trust_score",
  {
    title: "x402 trust score for an endpoint (paid)",
    description:
      "Trust score (0-100, grade A-F) for a SPECIFIC x402 endpoint, with full component breakdown, flags (e.g. delisted, non-compliant envelope, no observed settlements), and 30-day stats. Call this BEFORE paying an unknown x402 endpoint to avoid dead or fraudulent services. Pay-per-call over x402; auto-pays if a wallet is configured, otherwise returns the price quote.",
    inputSchema: {
      resource: z.string().describe("Full x402 resource URL to evaluate, e.g. https://api.example.com/v1/thing"),
    },
  },
  async ({ resource }) => {
    const r = await paidPost({
      url: `${API_BASE}/v1/x402-trust`,
      body: { resource },
      ...(PRIVATE_KEY ? { privateKey: PRIVATE_KEY } : {}),
      maxAmountUsd: MAX_USD,
      timeoutMs: TIMEOUT_MS,
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
      ...(PRIVATE_KEY ? { privateKey: PRIVATE_KEY } : {}),
      maxAmountUsd: MAX_USD,
      timeoutMs: TIMEOUT_MS,
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
      hint: PRIVATE_KEY
        ? `Quote $${r.quote.amountUsd} exceeds X402_MAX_USD ($${MAX_USD}); raise the limit to auto-pay.`
        : `Payment required ($${r.quote.amountUsd}). Set X402_PRIVATE_KEY (a funded Base USDC wallet) to enable auto-pay, or pay this x402 quote with your own wallet.`,
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
    `x402-trust MCP server ready (api=${API_BASE}, autoPay=${PRIVATE_KEY ? "on" : "off"}, maxUsd=${MAX_USD})\n`,
  );
}

void main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
