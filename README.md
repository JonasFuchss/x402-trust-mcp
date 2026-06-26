# x402-trust-mcp

An [MCP](https://modelcontextprotocol.io) server that lets your agent check the
**trust & reliability of x402 endpoints before paying them**.

Backed by [x402.fuchss.app](https://x402.fuchss.app), which monitors the entire
x402 ecosystem on Base 24/7: uptime probes, 402-envelope spec compliance,
advertised-price history, and **real on-chain USDC settlement volume** per
endpoint.

[![x402-trust-mcp MCP server](https://glama.ai/mcp/servers/JonasFuchss/x402-trust-mcp/badges/card.svg)](https://glama.ai/mcp/servers/JonasFuchss/x402-trust-mcp)

## Why

Agents increasingly pay x402 endpoints autonomously. But ~⅔ of listed x402
endpoints are unreachable and ~⅓ of the reachable ones serve non-compliant
payment envelopes. Before your agent sends USDC to an unknown endpoint, ask:
*is it alive, compliant, and does anyone actually pay it?*

## Tools

| Tool | Cost | Description |
|---|---|---|
| `x402_ecosystem_stats` | free | Aggregate state of the x402 ecosystem (listings, reachability, compliance, 30d settlement volume). |
| `x402_trust_leaderboard` | free | Top-25 most trustworthy x402 endpoints. |
| `x402_trust_preview` | free | Showcase of what `x402_trust_score` returns — you don't choose the endpoint. Returns the **complete** paid-grade report (exact score, full breakdown, advertised price, on-chain settlement figures, all flags) for **three** endpoints: the best-scored, the median, and the worst-scored. See the full data shape across the quality range before you pay. To score *your own* endpoint, use `x402_trust_score` (paid). Takes no arguments. |
| `x402_trust_score` | paid | Trust score (0-100, grade A-F) for a specific endpoint, plus a machine-readable pay/don't-pay verdict, the advertised price, a confidence band, and structured flags — everything to decide in one call. |
| `x402_endpoint_history` | paid | Observation time-series for a specific endpoint (listings, price changes, probes). |

Paid tools cost a few tenths of a cent, charged over x402 (USDC on Base). If you
set `X402_PRIVATE_KEY`, the server **auto-pays** within your `X402_MAX_USD`
limit; otherwise it returns the price quote for your host to pay.

### `x402_trust_score` result

A single call returns everything an agent needs to decide **whether** and at
**what price** to use an endpoint — no second round-trip, no raw-unit guessing:

| Field | Meaning |
|---|---|
| `score` / `grade` | 0-100 point score and its A-F grade. |
| `recommendation` | Machine verdict: `proceed` \| `caution` \| `avoid`. Already prices in data uncertainty — low confidence caps it at `caution` (a young endpoint is *unproven*, not *untrustworthy*); `avoid` is reserved for real negatives (error-severity flags, low score, recent payTo change). |
| `scoreRange` | `{ low, point, high }` — a confidence-adjusted band. Decide conservatively against `low`. |
| `confidence` / `confidenceDetail` | Overall confidence plus its parts: `observation` (data volume/age) vs `economic` (settlement coverage). |
| `gradeThresholds` | The score cutoffs for each grade, so the verdict is auditable. |
| `advertised` | The last observed 402 quote: `{ amount, amountUsd, asset, network, decimals, observedAtTs }`. Trust **and** cost in one call. |
| `flags` / `flagsDetailed` | Legacy string flags plus structured `{ code, severity, message }`. Rule of thumb: **any flag with `severity: "error"` ⇒ avoid.** |
| `breakdown` / `subscores` | The full deterministic math (uptime, compliance, latency, age, activity, stability → technical / spec / economic subscores). |
| `stats` | Observed evidence: probe counts, latency, payTo, `settledVolumeUsd30d`, distinct payers, and a `payToChanged*` hijack signal when the receiving wallet changed recently. |

Everything is computed deterministically (no LLM) from continuous on-chain and
probe observation, so the breakdown is fully auditable.

## x402 V2 Payment Flow

This MCP server uses the canonical x402 V2 payment flow:

1. **402 + `PAYMENT-REQUIRED`** — The server responds with HTTP 402 and a
   base64-encoded `PAYMENT-REQUIRED` header containing the payment requirements
   (accepts, network, asset, amount, payTo).
2. **Sign + retry with `PAYMENT-SIGNATURE`** — The MCP client signs an
   EIP-3009 `transferWithAuthorization` for the selected accept and re-POSTs
   with the `PAYMENT-SIGNATURE` header (base64-encoded payment payload).
3. **Settlement + `PAYMENT-RESPONSE`** — The server settles the payment and
   responds with the data plus a `PAYMENT-RESPONSE` header.

Legacy `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers are accepted as a fallback
during the V1→V2 transition period but are not the default.

**Accept selection:** When a 402 response offers multiple accepts (e.g. Solana
+ Base USDC), the client selects the best compatible one (canonical USDC on an
allow-listed chain) rather than blindly taking the first accept.

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
| `X402_TRUST_API_BASE` | `https://x402.fuchss.app` | API base URL. |
| `X402_PRIVATE_KEY` | _(unset)_ | Base wallet private key. Enables auto-pay for paid tools. Accepted with or without the `0x` prefix (surrounding whitespace is trimmed); a set-but-malformed key logs a warning and leaves auto-pay off rather than failing silently. |
| `X402_MAX_USD` | `0.05` | Per-call auto-pay ceiling. 0 disables auto-pay. |
| `X402_MAX_TOTAL_USD` | `1.00` | Cumulative auto-pay cap per process. 0 = unlimited. |
| `X402_MAX_CALLS` | `1000` | Max paid calls per process. 0 = unlimited. |
| `X402_TIMEOUT_MS` | `20000` | Request timeout. |

The free tools work with no configuration at all.

## Security

`X402_PRIVATE_KEY` is a hot wallet — fund it with only what you're willing to
spend on trust lookups. The key never leaves your machine; it signs EIP-3009
payment authorizations locally.

**Policy checks enforced before signing:**
- Chain allow-list (Base mainnet by default)
- Canonical USDC contract verification (no arbitrary tokens)
- Optional payTo allow-list
- Per-call spend ceiling (`X402_MAX_USD`)
- Cumulative spend cap (`X402_MAX_TOTAL_USD`)
- Call-count cap (`X402_MAX_CALLS`)

## License

MIT
