# crypto-exchange-mcp

MCP server that exposes public market data from **Binance** (spot + USD-M futures) and **CoinDCX** over REST and WebSocket, plus a few cross-exchange analytics tools. Read-only, no API keys, no signing.

Built with [FastMCP](https://github.com/modelcontextprotocol/python-sdk). Default CLI transport is **stdio**; **streamable-http** is used in Docker (`docker-compose.yml` service `mcp-server`, port **4003**).

---

## In-app dashboard AI (Ollama + MCP tools)

The trading dashboard’s periodic market brief can call this server as Ollama tools when MCP is enabled on the **bot** process (the Node app that hosts the dashboard WebSocket — not the Next.js PnL UI alone).

1. Run the MCP HTTP server, e.g. `docker compose up -d mcp-server` (or `python crypto_exchange_mcp.py --transport http` from this directory).
2. In the bot `.env`: `AI_MCP_ENABLED=true`, `AI_MCP_URL=http://localhost:4003` (or `http://mcp-server:4003` if the bot runs on the same Docker network as `mcp-server`).
3. Keep `AI_MARKET_BRIEF_ENABLED=true` and a valid `OLLAMA_MODEL` as today.

The bot connects with the TypeScript MCP client to `{AI_MCP_URL}/mcp` (streamable-http, SSE fallback).

---

## Install

```bash
cd mcp-server
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Verify the import & registration:

```bash
.venv/bin/python -m py_compile crypto_exchange_mcp.py
.venv/bin/python -m pytest tests/ -q
```

Optional dev with the inspector:

```bash
.venv/bin/python -m mcp dev crypto_exchange_mcp.py
```

---

## Register with Claude Code

```bash
claude mcp add crypto-exchange -- \
  /home/nemesis/project/trading-workspace/coindcx/binance/mcp-server/.venv/bin/python \
  /home/nemesis/project/trading-workspace/coindcx/binance/mcp-server/crypto_exchange_mcp.py
```

Or edit `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "crypto-exchange": {
      "command": "/home/nemesis/project/trading-workspace/coindcx/binance/mcp-server/.venv/bin/python",
      "args": ["/home/nemesis/project/trading-workspace/coindcx/binance/mcp-server/crypto_exchange_mcp.py"]
    }
  }
}
```

---

## Optimizing for Agentic Use

To make your LLM fast and efficient with these tools, we recommend using the standardized [SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md). It provides the model with:
- **Tool Hierarchy**: Encourages the use of high-level synthesis tools over granular ones.
- **Workflow Steps**: Defines a clear 3-phase analysis path (Sentiment -> Technicals -> Synthesis).
- **Symbol Handling**: Instructs the model on how to handle futures suffixes like `.P`.

`LOG_LEVEL=DEBUG` is honored.

---

## Symbol & pair conventions

| Asset | Binance | CoinDCX (public-data pair) | CoinDCX (exchange market) |
| --- | --- | --- | --- |
| BTC | BTCUSDT | B-BTC_USDT | BTCUSDT |
| ETH | ETHUSDT | B-ETH_USDT | ETHUSDT |
| SOL | SOLUSDT | B-SOL_USDT | SOLUSDT |
| USDT/INR | n/a | B-USDT_INR | USDTINR |

The `coindcx_pair(asset, quote)` helper builds the `B-<ASSET>_<QUOTE>` form used by the public market_data endpoints. Cross-exchange tools accept a plain asset symbol (e.g. `BTC`) and a quote (default `USDT`).

---

## Tool reference

### Binance REST

| Tool | Endpoint |
| --- | --- |
| `binance_get_exchange_info` | `/api/v3/exchangeInfo` |
| `binance_futures_exchange_info` | `/fapi/v1/exchangeInfo` |
| `binance_get_price` | `/api/v3/ticker/price` |
| `binance_futures_get_price` | `/fapi/v1/ticker/price` |
| `binance_get_ticker_24hr` | `/api/v3/ticker/24hr` |
| `binance_futures_ticker_24hr` | `/fapi/v1/ticker/24hr` |
| `binance_get_order_book` | `/api/v3/depth` or `/fapi/v1/depth` (+ spread bps, top-10 imbalance) |
| `binance_get_recent_trades` | `/api/v3/trades` or `/fapi/v1/trades` |
| `binance_get_klines` | `/api/v3/klines` or `/fapi/v1/klines` |
| `binance_get_agg_trades` | `/api/v3/aggTrades` or `/fapi/v1/aggTrades` |
| `binance_futures_premium_index` | `/fapi/v1/premiumIndex` |
| `binance_futures_funding_rate_history` | `/fapi/v1/fundingRate` |
| `binance_futures_open_interest` | `/fapi/v1/openInterest` |
| `binance_futures_open_interest_hist` | `/futures/data/openInterestHist` |
| `binance_futures_top_long_short_ratio` | `/futures/data/topLongShortAccountRatio` |

### Binance WebSocket (snapshot)

| Tool | Notes |
| --- | --- |
| `binance_ws_collect_stream` | Single stream; `duration_sec` clamped 1-60 |
| `binance_ws_collect_multi_stream` | Combined `/stream?streams=` endpoint |

Example streams: `btcusdt@aggTrade`, `btcusdt@bookTicker`, `btcusdt@depth20@100ms`, `btcusdt@kline_5m`, `btcusdt@markPrice@1s`, `!forceOrder@arr`.

### CoinDCX REST

| Tool | URL |
| --- | --- |
| `coindcx_get_markets` | `https://api.coindcx.com/exchange/v1/markets` |
| `coindcx_get_market_details` | `https://api.coindcx.com/exchange/v1/markets_details` |
| `coindcx_get_ticker` | `https://api.coindcx.com/exchange/ticker` (client-side filter) |
| `coindcx_get_order_book` | `https://public.coindcx.com/market_data/orderbook?pair=...` |
| `coindcx_get_recent_trades` | `https://public.coindcx.com/market_data/trade_history?pair=...` |
| `coindcx_get_candles` | `https://public.coindcx.com/market_data/candles?pair=...&interval=...` |

### CoinDCX WebSocket

`coindcx_ws_collect_stream` joins a Socket.IO channel at `https://stream.coindcx.com`. Channels include `coindcx`, `currentPrices@futures`, `depth-update@<pair>` (e.g. `depth-update@B-BTC_USDT`), `candlestick`.

### Cross-exchange analytics

| Tool | Purpose |
| --- | --- |
| `cross_exchange_compare_price` | Parallel last-price fetch on Binance + CoinDCX, plus USDT/INR conversion and spread bps with suggested direction |
| `cross_exchange_compare_depth` | Sum of bid/ask quantity within `depth_pct` of mid on each venue; reports the deeper side |

All tools accept `response_format: "json"` (default) or `"markdown"`.

---

## Example prompts

- "What is the 24hr volume for BTCUSDT on Binance spot and futures?"
- "Show me a 5-second snapshot of `btcusdt@bookTicker` futures messages and summarize msgs/sec."
- "Compare BTC last price on Binance vs CoinDCX in INR-equivalent terms."
- "Where is BTC liquidity deeper within 0.1% of mid - Binance or CoinDCX?"
- "Pull the last 30 open-interest points for BTCUSDT at 1h periods."

---

## Errors

- Binance JSON error bodies (`{code,msg}`) are surfaced verbatim. 429/418 are flagged as rate-limit hits.
- CoinDCX 200-with-`status:error` payloads are converted to `RuntimeError` and reported as `Error: CoinDCX error: <msg>`.
- WebSocket duration is clamped to `[1, 60]` seconds. High-rate captures return the first 500 + last 500 messages plus summary stats.
