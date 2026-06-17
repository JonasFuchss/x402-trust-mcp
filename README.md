# x402-trust-mcp

An [MCP](https://modelcontextprotocol.io) server that lets your agent check the
**trust & reliability of x402 endpoints before paying them**.

Backed by [x402.fuchss.app](https://x402.fuchss.app), which monitors the entire
x402 ecosystem (Base + Solana) 24/7: uptime probes, 402-envelope spec compliance,
advertised-price history, and **real on-chain USDC settlement volume** per
endpoint.

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
| `x402_trust_score` | paid | Trust score (0-100, grade A-F) for a specific endpoint, with full breakdown + flags. |
| `x402_endpoint_history` | paid | Observation time-series for a specific endpoint (listings, price changes, probes). |

Paid tools cost a few tenths of a cent, charged over x402 (USDC on Base). If you
set `X402_PRIVATE_KEY`, the server **auto-pays** within your `X402_MAX_USD`
limit; otherwise it returns the price quote for your host to pay.

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
| `X402_PRIVATE_KEY` | _(unset)_ | Base wallet private key (0x…). Enables auto-pay for paid tools. |
| `X402_MAX_USD` | `0.05` | Per-call auto-pay ceiling. |
| `X402_TIMEOUT_MS` | `20000` | Request timeout. |

The free tools work with no configuration at all.

## Security

`X402_PRIVATE_KEY` is a hot wallet — fund it with only what you're willing to
spend on trust lookups. The key never leaves your machine; it signs EIP-3009
payment authorizations locally.

## License

MIT
