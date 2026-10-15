[![x402-trust-mcp MCP server](https://glama.ai/mcp/servers/JonasFuchss/x402-trust-mcp/badges/card.svg)](https://glama.ai/mcp/servers/JonasFuchss/x402-trust-mcp)

# x402-trust-mcp

An [MCP](https://modelcontextprotocol.io) server for **discovering x402
endpoints and checking their trust before paying them**: semantic and keyword
search across the monitored catalog, plus trust scores, history, bulk scoring,
and watches for any endpoint.

Backed by [x402-trust.com](https://x402-trust.com), which monitors the x402
ecosystem on Base and Solana 24/7: uptime probes, 402-envelope spec compliance,
price history, and real on-chain USDC settlement volume per endpoint. Every
score is computed deterministically, no LLM involved, so the breakdown is fully
auditable.

## Tools

| Tool | Cost | Description |
|---|---|---|
| `x402_ecosystem_stats` | free | Snapshot of the whole x402 ecosystem: endpoint counts, reachability, and real USDC settlement volume over 30 days. |
| `x402_trust_leaderboard` | free | Top-100 ranking of the most trustworthy x402 hosts, scored by their whole measured surface. Page with `offset`. |
| `x402_verified_providers` | free | Hosts that proved domain control and confirmed a contact email. Informational only, verification never changes the score. |
| `x402_search` | free | Substring search over host, URL and service name across the catalog. |
| `x402_semantic_search` | free | Meaning-based search: describe the capability you need in plain words. Discovery only, no verdicts. |
| `x402_trust_preview` | free | Three complete trust reports (best, median, worst) exactly as `x402_trust_score` returns them. |
| `x402_trust_score` | paid | The full trust verdict for one endpoint: score 0-100, grade, recommendation, price, and flags. Unknown endpoints get live-probed on the spot. |
| `x402_endpoint_history` | paid | Raw probe and event history for one endpoint over 1-90 days. |
| `x402_find_alternatives` | paid | Semantically similar endpoints that out-score a given one. Empty result means nothing beats it. |
| `x402_trust_bulk` | paid | Score up to 500 endpoints in one call; the cheapest fitting tier (10/50/100/200/500) is picked automatically. |
| `x402_watch_create` | paid | 30-day monitor for one endpoint: alerts on payTo or price changes, delisting, spec regressions and downtime, via polling or webhooks. Returns a one-time secret. |
| `x402_watch_events` | free | Poll a watch's event log with watch id and secret, paging by the returned cursors. |
| `x402_watch_edit` | free | Change a watch's webhook URLs, sensitivity or subscribed events. |
| `x402_watch_cancel` | free | Stop a watch now; its log stays readable until expiry. |
| `x402_watch_renew` | paid | Add another 30 days to an active watch. Same secret. |

Paid tools cost from **$0.005** (single lookup) to **~$0.50** (500-endpoint
bulk), charged over x402 (USDC on Base). With `X402_PRIVATE_KEY` set the server
auto-pays within your limits; otherwise it returns the price quote for your
host to pay. List tools page with `limit` (max 25) + `offset` and return a
`total`.

Field-level documentation, verdict semantics, watch cursor rules and webhook
signature details live at [x402-trust.com/llms.txt](https://x402-trust.com/llms.txt);
every response is self-describing via its schema at
[x402-trust.com/schemas](https://x402-trust.com/schemas).

## Install

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "x402-trust": {
      "command": "npx",
      "args": ["-y", "x402-trust-mcp"]
    }
  }
}
```

To enable autonomous payment for the paid tools, add a funded Base USDC wallet:

```json
{
  "mcpServers": {
    "x402-trust": {
      "command": "npx",
      "args": ["-y", "x402-trust-mcp"],
      "env": {
        "X402_PRIVATE_KEY": "0xYOUR_BASE_WALLET_KEY",
        "X402_MAX_USD": "0.05"
      }
    }
  }
}
```

## Configuration (env vars)

| Var | Default | Description |
|---|---|---|
| `X402_TRUST_API_BASE` | `https://x402-trust.com` | API base URL. |
| `X402_PRIVATE_KEY` | _(unset)_ | Base wallet private key. Enables auto-pay for paid tools. A set-but-malformed key logs a warning and leaves auto-pay off. |
| `X402_MAX_USD` | `0.05` | Per-call auto-pay ceiling. 0 disables auto-pay. |
| `X402_MAX_TOTAL_USD` | `1.00` | Cumulative auto-pay cap per process. 0 = unlimited. |
| `X402_MAX_CALLS` | `1000` | Max paid calls per process. 0 = unlimited. |
| `X402_TIMEOUT_MS` | `20000` | Request timeout. |

The free tools work with no configuration at all.

## Security

`X402_PRIVATE_KEY` is a hot wallet: fund it with only what you are willing to
spend on trust lookups. The key never leaves your machine; it signs EIP-3009
payment authorizations locally, after policy checks: chain allow-list (Base
mainnet by default), canonical USDC contract verification, and the spend and
call-count caps above.

## Response signatures

Signed tool results carry a top-level `signature` block: an Ed25519 signature
over the JCS-canonicalized (RFC 8785) response. It proves the content was
assembled by x402-trust and not modified afterwards.

One rule matters when verifying: **pin the trust anchor, never follow it from
the response.** `signature.publicKeys` is a discovery hint; a forged response
would point at the attacker's own key document and still verify. Pin the public
key itself or fetch `https://x402-trust.com/.well-known/x402-trust-keys.json`
once at bootstrap and cache it. A worked test vector and a 20-line reference
verifier live at [x402-trust.com/schemas](https://x402-trust.com/schemas).
Watch management responses are unsigned by design: they carry capability
secrets that must never be forwarded as evidence.

## License

MIT
