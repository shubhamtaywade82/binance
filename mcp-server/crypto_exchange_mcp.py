#!/usr/bin/env python3
"""MCP server exposing Binance and CoinDCX public market data.

Exposes REST endpoints and short-lived WebSocket snapshot collectors for
both exchanges, plus cross-exchange comparison helpers. Public endpoints
only - no API keys, no signed requests, no order placement.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import Enum
from typing import Any, AsyncIterator, Callable, Iterable, Optional

import httpx
import websockets
from starlette.middleware.cors import CORSMiddleware
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, ConfigDict, Field, field_validator

# region ---------- logging & constants ----------

logging.basicConfig(
    stream=sys.stderr,
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("crypto_exchange_mcp")

BINANCE_SPOT_REST = "https://api.binance.com"
BINANCE_FUTURES_REST = "https://fapi.binance.com"
BINANCE_SPOT_WS = "wss://stream.binance.com:9443"
BINANCE_FUTURES_WS = "wss://fstream.binance.com"

COINDCX_REST = "https://api.coindcx.com"
COINDCX_PUBLIC = "https://public.coindcx.com"
COINDCX_WS = "https://stream.coindcx.com"

VALID_KLINE_INTERVALS = {
    "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
}

VALID_COINDCX_INTERVALS = {
    "1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "1d", "3d", "1w", "1M",
}

VALID_OI_PERIODS = {"5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"}

MAX_WS_DURATION_SEC = 60.0
MIN_WS_DURATION_SEC = 1.0
MAX_WS_MESSAGES_RETURNED = 1000
SYMBOL_RE = re.compile(r"^[A-Z0-9]{2,30}$")
COINDCX_PAIR_RE = re.compile(r"^[A-Z]{1,3}-[A-Z0-9]{2,15}_[A-Z0-9]{2,15}$")

# endregion

# region ---------- enums & shared models ----------


class ResponseFormat(str, Enum):
    """Tool output formats."""

    JSON = "json"
    MARKDOWN = "markdown"


class Market(str, Enum):
    """Binance market segment."""

    SPOT = "spot"
    FUTURES = "futures"


# endregion

# region ---------- lifespan & app context ----------


@dataclass
class AppContext:
    """Shared resources for the lifetime of the server."""

    http: httpx.AsyncClient


@asynccontextmanager
async def lifespan(_: FastMCP) -> AsyncIterator[AppContext]:
    """Provide a shared httpx client to all tools."""
    timeout = httpx.Timeout(15.0, connect=10.0)
    limits = httpx.Limits(max_connections=32, max_keepalive_connections=16)
    async with httpx.AsyncClient(
        timeout=timeout,
        limits=limits,
        follow_redirects=True,
        headers={"User-Agent": "crypto-exchange-mcp/0.1"},
    ) as http:
        log.info("crypto-exchange-mcp starting (httpx client ready)")
        yield AppContext(http=http)
        log.info("crypto-exchange-mcp shutting down")


_MCP_HOST = os.getenv("MCP_HOST", "0.0.0.0")
_MCP_PORT = int(os.getenv("MCP_PORT", "4003"))

mcp = FastMCP(
    "crypto_exchange_mcp",
    lifespan=lifespan,
    host=_MCP_HOST,
    port=_MCP_PORT,
)


def _http(ctx: Context) -> httpx.AsyncClient:
    """Pull the shared httpx client from the MCP request context."""
    return ctx.request_context.lifespan_context.http


# endregion

# region ---------- helpers: validation & formatting ----------


def normalize_symbol(symbol: str) -> str:
    """Uppercase, strip, and validate a Binance symbol like BTCUSDT.
    Automatically handles common suffixes like .P, .PERP, -PERP.
    """
    if symbol is None:
        raise ValueError("symbol is required")
    # Clean common futures suffixes that LLMs often include
    cleaned = symbol.strip().upper()
    for suffix in [".P", ".PERP", "-PERP", "-P"]:
        if cleaned.endswith(suffix):
            cleaned = cleaned[:-len(suffix)]
            break

    if not cleaned or not SYMBOL_RE.match(cleaned):
        raise ValueError(
            f"Invalid symbol '{symbol}' (cleaned: '{cleaned}'). Use alphanumeric symbols like BTCUSDT. "
            "Call binance_get_exchange_info to list valid symbols."
        )
    return cleaned


def validate_kline_interval(interval: str, allowed: Iterable[str] = VALID_KLINE_INTERVALS) -> str:
    """Ensure the kline interval is in the supported whitelist."""
    if interval not in allowed:
        raise ValueError(
            f"Invalid interval '{interval}'. Allowed: {', '.join(sorted(allowed))}"
        )
    return interval


def coindcx_pair(asset: str, quote: str = "USDT") -> str:
    """Build a CoinDCX public-data pair string such as B-BTC_USDT."""
    asset_u = asset.strip().upper()
    quote_u = quote.strip().upper()
    if not asset_u or not quote_u:
        raise ValueError("asset and quote are required")
    pair = f"B-{asset_u}_{quote_u}"
    if not COINDCX_PAIR_RE.match(pair):
        raise ValueError(f"Could not build a valid CoinDCX pair from asset='{asset}', quote='{quote}'")
    return pair


def normalize_coindcx_pair(pair: str) -> str:
    """Validate a user-provided CoinDCX pair string."""
    cleaned = pair.strip().upper()
    if not COINDCX_PAIR_RE.match(cleaned):
        raise ValueError(
            f"Invalid CoinDCX pair '{pair}'. Expected format like 'B-BTC_USDT'."
        )
    return cleaned


def depth_imbalance(bids: list[list[Any]], asks: list[list[Any]], top_n: int = 10) -> dict:
    """Compute top-N depth imbalance and best bid/ask/spread stats."""
    if not bids or not asks:
        return {
            "top_n": top_n,
            "bid_qty": 0.0,
            "ask_qty": 0.0,
            "imbalance": 0.0,
            "best_bid": None,
            "best_ask": None,
            "spread": None,
            "spread_bps": None,
            "mid": None,
        }
    top_bids = bids[:top_n]
    top_asks = asks[:top_n]
    bid_qty = sum(float(b[1]) for b in top_bids)
    ask_qty = sum(float(a[1]) for a in top_asks)
    total = bid_qty + ask_qty
    imbalance = (bid_qty - ask_qty) / total if total > 0 else 0.0
    best_bid = float(bids[0][0])
    best_ask = float(asks[0][0])
    spread = best_ask - best_bid
    mid = (best_bid + best_ask) / 2.0
    spread_bps = (spread / mid * 10_000.0) if mid > 0 else None
    return {
        "top_n": top_n,
        "bid_qty": bid_qty,
        "ask_qty": ask_qty,
        "imbalance": imbalance,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "spread": spread,
        "spread_bps": spread_bps,
        "mid": mid,
    }


def depth_within_pct(bids: list[list[Any]], asks: list[list[Any]], depth_pct: float) -> dict:
    """Sum bid/ask quantity within depth_pct of mid price."""
    if not bids or not asks:
        return {"bid_qty": 0.0, "ask_qty": 0.0, "mid": None, "depth_pct": depth_pct}
    best_bid = float(bids[0][0])
    best_ask = float(asks[0][0])
    mid = (best_bid + best_ask) / 2.0
    floor = mid * (1.0 - depth_pct / 100.0)
    ceiling = mid * (1.0 + depth_pct / 100.0)
    bid_qty = sum(float(q) for p, q in ((float(b[0]), b[1]) for b in bids) if p >= floor)
    ask_qty = sum(float(q) for p, q in ((float(a[0]), a[1]) for a in asks) if p <= ceiling)
    return {"bid_qty": bid_qty, "ask_qty": ask_qty, "mid": mid, "depth_pct": depth_pct}


def _truncate_markdown_rows(rows: list[list[str]], limit: int = 20) -> tuple[list[list[str]], int]:
    """Cap the number of markdown table rows returned."""
    if len(rows) <= limit:
        return rows, 0
    return rows[:limit], len(rows) - limit


def _md_table(headers: list[str], rows: list[list[str]]) -> str:
    """Render a small markdown table."""
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def format_response(
    payload: Any,
    fmt: ResponseFormat | str,
    *,
    title: str | None = None,
    markdown_renderer: Optional[Callable[[Any], str]] = None,
) -> str:
    """Serialize a payload as JSON or markdown.

    Always returns a string. If a markdown_renderer callable is provided it
    is used for the markdown branch; otherwise a sensible default is applied.
    """
    fmt_val = fmt.value if isinstance(fmt, ResponseFormat) else str(fmt).lower()
    if fmt_val == ResponseFormat.JSON.value:
        return json.dumps(payload, indent=2, default=str)

    if markdown_renderer is not None:
        return markdown_renderer(payload)

    lines: list[str] = []
    if title:
        lines.append(f"# {title}")
        lines.append("")

    if isinstance(payload, dict):
        rows: list[list[str]] = []
        for k, v in payload.items():
            if isinstance(v, (dict, list)):
                v_str = json.dumps(v, default=str)
                if len(v_str) > 120:
                    v_str = v_str[:117] + "..."
            else:
                v_str = str(v)
            rows.append([str(k), v_str])
        rows, hidden = _truncate_markdown_rows(rows)
        lines.append(_md_table(["field", "value"], rows))
        if hidden:
            lines.append(f"\n_{hidden} more fields omitted; request response_format='json' for full data._")
    elif isinstance(payload, list):
        lines.append(f"_{len(payload)} items_")
        sample = payload[:20]
        lines.append("```json")
        lines.append(json.dumps(sample, indent=2, default=str))
        lines.append("```")
        if len(payload) > 20:
            lines.append(f"\n_{len(payload) - 20} more items omitted; request response_format='json' for full data._")
    else:
        lines.append(str(payload))

    return "\n".join(lines)


def _parse_binance_error(resp: httpx.Response) -> str:
    """Extract Binance's structured error code/msg if present."""
    try:
        body = resp.json()
    except Exception:
        return resp.text[:200] if resp.text else ""
    if isinstance(body, dict) and ("code" in body or "msg" in body):
        return f"code={body.get('code')} msg={body.get('msg')}"
    return json.dumps(body)[:200]


def handle_exchange_error(e: Exception, *, hint: str = "") -> str:
    """Render a consistent, actionable error string for tool returns."""
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        body = _parse_binance_error(e.response)
        base = f"Error: HTTP {code} from {e.request.url.host} - {body}"
        if code == 429 or code == 418:
            return f"{base}. Rate limit hit; back off and retry with smaller limits."
        if code == 400:
            return f"{base}. {hint or 'Check symbol/interval - call binance_get_exchange_info to list valid symbols.'}"
        if code == 404:
            return f"{base}. {hint or 'Endpoint or symbol not found.'}"
        return base
    if isinstance(e, httpx.TimeoutException):
        return (
            "Error: Request timed out after 15s. Reduce `limit`, narrow the time range, "
            "or retry. Original cause: " + str(e)
        )
    if isinstance(e, ValueError):
        return f"Error: {e}"
    return f"Error: {type(e).__name__}: {e}"


def detect_coindcx_error(payload: Any) -> Optional[str]:
    """CoinDCX often returns HTTP 200 with {status:'error', message:'...'}; surface it."""
    if isinstance(payload, dict) and payload.get("status") == "error":
        return f"CoinDCX error: {payload.get('message') or 'unknown error'}"
    return None


# endregion

# region ---------- HTTP helpers ----------


async def _binance_get(
    ctx: Context,
    market: Market,
    path: str,
    params: Optional[dict] = None,
) -> Any:
    """GET a Binance public REST endpoint."""
    base = BINANCE_SPOT_REST if market == Market.SPOT else BINANCE_FUTURES_REST
    resp = await _http(ctx).get(f"{base}{path}", params=params)
    resp.raise_for_status()
    return resp.json()


async def _coindcx_get(ctx: Context, url: str, params: Optional[dict] = None) -> Any:
    """GET a CoinDCX public endpoint and surface their JSON error shape."""
    resp = await _http(ctx).get(url, params=params)
    resp.raise_for_status()
    data = resp.json()
    err = detect_coindcx_error(data)
    if err:
        raise RuntimeError(err)
    return data


# endregion

# region ---------- WS collectors ----------


async def collect_binance_ws(url: str, duration: float) -> list[dict]:
    """Collect Binance WS messages for up to `duration` seconds."""
    msgs: list[dict] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + duration
    async with websockets.connect(url, ping_interval=20, max_size=2**22) as ws:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            except websockets.ConnectionClosed:
                break
            try:
                msgs.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    return msgs


def _summarize_ws(msgs: list[dict], duration: float) -> dict:
    """Compute msgs/sec and first/last timestamps for a WS capture."""

    def _msg_ts(m: dict) -> Optional[int]:
        if not isinstance(m, dict):
            return None
        for key in ("E", "T"):
            if key in m and isinstance(m[key], (int, float)):
                return int(m[key])
        data = m.get("data") if isinstance(m.get("data"), dict) else None
        if data:
            for key in ("E", "T"):
                if key in data and isinstance(data[key], (int, float)):
                    return int(data[key])
        return None

    timestamps = [t for t in (_msg_ts(m) for m in msgs) if t is not None]
    return {
        "count": len(msgs),
        "duration_sec": duration,
        "msgs_per_sec": (len(msgs) / duration) if duration > 0 else 0.0,
        "first_ts_ms": min(timestamps) if timestamps else None,
        "last_ts_ms": max(timestamps) if timestamps else None,
    }


def _sample_messages(msgs: list[dict], cap: int = MAX_WS_MESSAGES_RETURNED) -> list[dict]:
    """If capture exceeded cap, return first half and last half."""
    if len(msgs) <= cap:
        return msgs
    half = cap // 2
    return msgs[:half] + msgs[-half:]


async def collect_coindcx_ws(channel: str, duration: float) -> list[dict]:
    """Collect CoinDCX Socket.IO messages for up to `duration` seconds."""
    import socketio

    sio = socketio.AsyncClient(reconnection=False, logger=False, engineio_logger=False)
    msgs: list[dict] = []
    done = asyncio.Event()

    @sio.event
    async def connect() -> None:
        await sio.emit("join", {"channelName": channel})

    @sio.on("*")
    async def catch_all(event: str, data: Any) -> None:  # type: ignore[no-redef]
        try:
            parsed = json.loads(data) if isinstance(data, str) else data
        except Exception:
            parsed = data
        msgs.append({"event": event, "data": parsed, "ts_ms": int(time.time() * 1000)})

    try:
        await sio.connect(COINDCX_WS, transports=["websocket"], wait_timeout=10)
    except Exception as e:
        raise RuntimeError(f"CoinDCX WS connect failed: {e}") from e

    async def _stop() -> None:
        await asyncio.sleep(duration)
        done.set()

    stop_task = asyncio.create_task(_stop())
    try:
        await done.wait()
    finally:
        stop_task.cancel()
        try:
            await sio.emit("leave", {"channelName": channel})
        except Exception:
            pass
        try:
            await sio.disconnect()
        except Exception:
            pass
    return msgs


# endregion

# region ---------- Pydantic input models ----------


class _Base(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True, extra="forbid")


class FormatOnly(_Base):
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON, description="json (default) or markdown")


class OptionalSymbolInput(_Base):
    symbol: Optional[str] = Field(default=None, description="Optional symbol like 'BTCUSDT'. Omit to return all.")
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _val(cls, v: Optional[str]) -> Optional[str]:
        return normalize_symbol(v) if v else None


class SymbolInput(_Base):
    symbol: str = Field(..., description="Symbol like 'BTCUSDT'")
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _val(cls, v: str) -> str:
        return normalize_symbol(v)


class OrderBookInput(_Base):
    symbol: str = Field(..., description="Symbol like 'BTCUSDT'")
    limit: int = Field(default=100, ge=5, le=5000, description="Depth levels per side. Binance accepts 5/10/20/50/100/500/1000/5000.")
    market: Market = Field(default=Market.SPOT)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _val(cls, v: str) -> str:
        return normalize_symbol(v)


class RecentTradesInput(_Base):
    symbol: str = Field(..., description="Symbol like 'BTCUSDT'")
    limit: int = Field(default=500, ge=1, le=1000)
    market: Market = Field(default=Market.SPOT)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _val(cls, v: str) -> str:
        return normalize_symbol(v)


class KlinesInput(_Base):
    symbol: str = Field(..., description="Symbol like 'BTCUSDT'")
    interval: str = Field(default="1h", description="Kline interval (1m,5m,1h,1d,...)")
    limit: int = Field(default=500, ge=1, le=1500)
    startTime: Optional[int] = Field(default=None, description="Start time in ms")
    endTime: Optional[int] = Field(default=None, description="End time in ms")
    market: Market = Field(default=Market.SPOT)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _vs(cls, v: str) -> str:
        return normalize_symbol(v)

    @field_validator("interval")
    @classmethod
    def _vi(cls, v: str) -> str:
        return validate_kline_interval(v)


class AggTradesInput(_Base):
    symbol: str = Field(..., description="Symbol like 'BTCUSDT'")
    limit: int = Field(default=500, ge=1, le=1000)
    market: Market = Field(default=Market.SPOT)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _val(cls, v: str) -> str:
        return normalize_symbol(v)


class FundingHistoryInput(_Base):
    symbol: str = Field(..., description="Futures symbol like 'BTCUSDT'")
    limit: int = Field(default=100, ge=1, le=1000)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _val(cls, v: str) -> str:
        return normalize_symbol(v)


class OiHistInput(_Base):
    symbol: str = Field(..., description="Futures symbol like 'BTCUSDT'")
    period: str = Field(default="1h", description="Aggregation period (5m,15m,30m,1h,2h,4h,6h,12h,1d)")
    limit: int = Field(default=30, ge=1, le=500)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("symbol")
    @classmethod
    def _vs(cls, v: str) -> str:
        return normalize_symbol(v)

    @field_validator("period")
    @classmethod
    def _vp(cls, v: str) -> str:
        if v not in VALID_OI_PERIODS:
            raise ValueError(f"Invalid period '{v}'. Allowed: {', '.join(sorted(VALID_OI_PERIODS))}")
        return v


class LongShortInput(OiHistInput):
    """Same shape as OiHistInput."""


class WsStreamInput(_Base):
    stream: str = Field(..., description="Binance stream name, e.g. 'btcusdt@aggTrade'", min_length=3, max_length=100)
    duration_sec: float = Field(default=5.0, ge=MIN_WS_DURATION_SEC, le=MAX_WS_DURATION_SEC)
    market: Market = Field(default=Market.SPOT)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("stream")
    @classmethod
    def _val(cls, v: str) -> str:
        cleaned = v.strip().lower()
        if not cleaned or " " in cleaned:
            raise ValueError("stream must be a non-empty token without whitespace, e.g. 'btcusdt@aggTrade'")
        return cleaned


class WsMultiStreamInput(_Base):
    streams: list[str] = Field(..., description="List of Binance streams", min_length=1, max_length=20)
    duration_sec: float = Field(default=5.0, ge=MIN_WS_DURATION_SEC, le=MAX_WS_DURATION_SEC)
    market: Market = Field(default=Market.SPOT)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("streams")
    @classmethod
    def _val(cls, v: list[str]) -> list[str]:
        out = []
        for s in v:
            cleaned = s.strip().lower()
            if not cleaned or " " in cleaned:
                raise ValueError(f"invalid stream '{s}'")
            out.append(cleaned)
        return out


class CoinDcxTickerInput(_Base):
    market: Optional[str] = Field(default=None, description="Optional CoinDCX market filter, e.g. 'BTCUSDT' (their format).")
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)


class CoinDcxPairInput(_Base):
    pair: str = Field(..., description="CoinDCX public-data pair like 'B-BTC_USDT'")
    limit: int = Field(default=50, ge=1, le=1000)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("pair")
    @classmethod
    def _val(cls, v: str) -> str:
        return normalize_coindcx_pair(v)


class CoinDcxCandlesInput(_Base):
    pair: str = Field(..., description="CoinDCX pair like 'B-BTC_USDT'")
    interval: str = Field(..., description="Candle interval (1m,5m,15m,30m,1h,...,1d,1w,1M)")
    limit: int = Field(default=500, ge=1, le=1000)
    startTime: Optional[int] = Field(default=None)
    endTime: Optional[int] = Field(default=None)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("pair")
    @classmethod
    def _vp(cls, v: str) -> str:
        return normalize_coindcx_pair(v)

    @field_validator("interval")
    @classmethod
    def _vi(cls, v: str) -> str:
        return validate_kline_interval(v, allowed=VALID_COINDCX_INTERVALS)


class CoinDcxWsInput(_Base):
    channel: str = Field(..., description="Channel name e.g. 'coindcx', 'currentPrices@futures', 'depth-update@B-BTC_USDT', 'candlestick'")
    duration_sec: float = Field(default=5.0, ge=MIN_WS_DURATION_SEC, le=MAX_WS_DURATION_SEC)
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("channel")
    @classmethod
    def _val(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned or " " in cleaned:
            raise ValueError("channel must be a non-empty token without whitespace")
        return cleaned


class CrossPriceInput(_Base):
    asset: str = Field(default="BTC", description="Asset symbol like 'BTC','ETH','SOL'", min_length=2, max_length=10)
    quote: str = Field(default="USDT", description="Quote currency (USDT by default)")
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("asset", "quote")
    @classmethod
    def _val(cls, v: str) -> str:
        return v.strip().upper()


class CrossDepthInput(_Base):
    asset: str = Field(default="BTC", min_length=2, max_length=10)
    quote: str = Field(default="USDT")
    depth_pct: float = Field(default=0.1, gt=0.0, le=10.0, description="Percent distance from mid")
    response_format: ResponseFormat = Field(default=ResponseFormat.JSON)

    @field_validator("asset", "quote")
    @classmethod
    def _val(cls, v: str) -> str:
        return v.strip().upper()


# endregion

# region ---------- Annotations ----------

READ_ANNOTATIONS = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}

# endregion

# region ---------- Binance REST tools ----------


@mcp.tool(name="binance_get_exchange_info", annotations={**READ_ANNOTATIONS, "title": "Binance Spot Exchange Info"})
async def binance_get_exchange_info(params: OptionalSymbolInput, ctx: Context) -> str:
    """Return spot symbol filters, lot sizes, and precision from GET /api/v3/exchangeInfo.

    Use this tool to discover valid spot symbols, their tick sizes, and lot sizes
    before placing analytical queries elsewhere.
    """
    try:
        q = {"symbol": params.symbol} if params.symbol else None
        data = await _binance_get(ctx, Market.SPOT, "/api/v3/exchangeInfo", q)
        return format_response(data, params.response_format, title="Binance Spot Exchange Info")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_exchange_info", annotations={**READ_ANNOTATIONS, "title": "Binance Futures Exchange Info"})
async def binance_futures_exchange_info(params: OptionalSymbolInput, ctx: Context) -> str:
    """Return USD-M futures symbol filters from GET /fapi/v1/exchangeInfo."""
    try:
        data = await _binance_get(ctx, Market.FUTURES, "/fapi/v1/exchangeInfo")
        if params.symbol:
            data = {
                "timezone": data.get("timezone"),
                "serverTime": data.get("serverTime"),
                "symbols": [s for s in data.get("symbols", []) if s.get("symbol") == params.symbol],
            }
        return format_response(data, params.response_format, title="Binance Futures Exchange Info")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_get_price", annotations={**READ_ANNOTATIONS, "title": "Binance Spot Last Price"})
async def binance_get_price(params: SymbolInput, ctx: Context) -> str:
    """Return the latest spot price for one symbol via /api/v3/ticker/price."""
    try:
        data = await _binance_get(ctx, Market.SPOT, "/api/v3/ticker/price", {"symbol": params.symbol})
        return format_response(data, params.response_format, title=f"Binance Spot Price {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_get_price", annotations={**READ_ANNOTATIONS, "title": "Binance Futures Last Price"})
async def binance_futures_get_price(params: SymbolInput, ctx: Context) -> str:
    """Return the latest USD-M futures price via /fapi/v1/ticker/price."""
    try:
        data = await _binance_get(ctx, Market.FUTURES, "/fapi/v1/ticker/price", {"symbol": params.symbol})
        return format_response(data, params.response_format, title=f"Binance Futures Price {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_get_ticker_24hr", annotations={**READ_ANNOTATIONS, "title": "Binance Spot 24hr Ticker"})
async def binance_get_ticker_24hr(params: OptionalSymbolInput, ctx: Context) -> str:
    """24hr rolling ticker stats via /api/v3/ticker/24hr."""
    try:
        q = {"symbol": params.symbol} if params.symbol else None
        data = await _binance_get(ctx, Market.SPOT, "/api/v3/ticker/24hr", q)
        return format_response(data, params.response_format, title="Binance Spot 24hr Ticker")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_ticker_24hr", annotations={**READ_ANNOTATIONS, "title": "Binance Futures 24hr Ticker"})
async def binance_futures_ticker_24hr(params: OptionalSymbolInput, ctx: Context) -> str:
    """24hr rolling ticker stats for USD-M futures via /fapi/v1/ticker/24hr."""
    try:
        q = {"symbol": params.symbol} if params.symbol else None
        data = await _binance_get(ctx, Market.FUTURES, "/fapi/v1/ticker/24hr", q)
        return format_response(data, params.response_format, title="Binance Futures 24hr Ticker")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_get_order_book", annotations={**READ_ANNOTATIONS, "title": "Binance Order Book"})
async def binance_get_order_book(params: OrderBookInput, ctx: Context) -> str:
    """Return order book snapshot plus spread (bps) and top-10 imbalance.

    Uses /api/v3/depth (spot) or /fapi/v1/depth (futures).
    """
    try:
        path = "/api/v3/depth" if params.market == Market.SPOT else "/fapi/v1/depth"
        data = await _binance_get(ctx, params.market, path, {"symbol": params.symbol, "limit": params.limit})
        bids = data.get("bids", [])
        asks = data.get("asks", [])
        stats = depth_imbalance(bids, asks, top_n=min(10, len(bids), len(asks)))
        result = {
            "symbol": params.symbol,
            "market": params.market.value,
            "lastUpdateId": data.get("lastUpdateId"),
            "stats": stats,
            "bids": bids[: params.limit],
            "asks": asks[: params.limit],
        }
        return format_response(result, params.response_format, title=f"Order Book {params.symbol} ({params.market.value})")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_get_recent_trades", annotations={**READ_ANNOTATIONS, "title": "Binance Recent Trades"})
async def binance_get_recent_trades(params: RecentTradesInput, ctx: Context) -> str:
    """Recent trades via /api/v3/trades or /fapi/v1/trades."""
    try:
        path = "/api/v3/trades" if params.market == Market.SPOT else "/fapi/v1/trades"
        data = await _binance_get(ctx, params.market, path, {"symbol": params.symbol, "limit": params.limit})
        return format_response(data, params.response_format, title=f"Recent Trades {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_get_klines", annotations={**READ_ANNOTATIONS, "title": "Binance Klines"})
async def binance_get_klines(params: KlinesInput, ctx: Context) -> str:
    """Klines/candlesticks via /api/v3/klines (spot) or /fapi/v1/klines (futures)."""
    try:
        path = "/api/v3/klines" if params.market == Market.SPOT else "/fapi/v1/klines"
        q: dict[str, Any] = {"symbol": params.symbol, "interval": params.interval, "limit": params.limit}
        if params.startTime:
            q["startTime"] = params.startTime
        if params.endTime:
            q["endTime"] = params.endTime
        data = await _binance_get(ctx, params.market, path, q)
        return format_response(data, params.response_format, title=f"Klines {params.symbol} {params.interval}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_get_agg_trades", annotations={**READ_ANNOTATIONS, "title": "Binance Aggregated Trades"})
async def binance_get_agg_trades(params: AggTradesInput, ctx: Context) -> str:
    """Aggregated trades via /api/v3/aggTrades or /fapi/v1/aggTrades."""
    try:
        path = "/api/v3/aggTrades" if params.market == Market.SPOT else "/fapi/v1/aggTrades"
        data = await _binance_get(ctx, params.market, path, {"symbol": params.symbol, "limit": params.limit})
        return format_response(data, params.response_format, title=f"Agg Trades {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_premium_index", annotations={**READ_ANNOTATIONS, "title": "Binance Futures Premium Index"})
async def binance_futures_premium_index(params: SymbolInput, ctx: Context) -> str:
    """Mark price, index price, and current funding rate via /fapi/v1/premiumIndex."""
    try:
        data = await _binance_get(ctx, Market.FUTURES, "/fapi/v1/premiumIndex", {"symbol": params.symbol})
        return format_response(data, params.response_format, title=f"Premium Index {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_funding_rate_history", annotations={**READ_ANNOTATIONS, "title": "Binance Funding Rate History"})
async def binance_futures_funding_rate_history(params: FundingHistoryInput, ctx: Context) -> str:
    """Historical funding rates via /fapi/v1/fundingRate."""
    try:
        data = await _binance_get(ctx, Market.FUTURES, "/fapi/v1/fundingRate", {"symbol": params.symbol, "limit": params.limit})
        return format_response(data, params.response_format, title=f"Funding History {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_open_interest", annotations={**READ_ANNOTATIONS, "title": "Binance Open Interest"})
async def binance_futures_open_interest(params: SymbolInput, ctx: Context) -> str:
    """Current open interest via /fapi/v1/openInterest."""
    try:
        data = await _binance_get(ctx, Market.FUTURES, "/fapi/v1/openInterest", {"symbol": params.symbol})
        return format_response(data, params.response_format, title=f"Open Interest {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_open_interest_hist", annotations={**READ_ANNOTATIONS, "title": "Binance Open Interest History"})
async def binance_futures_open_interest_hist(params: OiHistInput, ctx: Context) -> str:
    """Historical open interest series via /futures/data/openInterestHist."""
    try:
        data = await _binance_get(ctx, Market.FUTURES, "/futures/data/openInterestHist", {
            "symbol": params.symbol, "period": params.period, "limit": params.limit,
        })
        return format_response(data, params.response_format, title=f"OI History {params.symbol} {params.period}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_futures_top_long_short_ratio", annotations={**READ_ANNOTATIONS, "title": "Binance Top Long/Short Account Ratio"})
async def binance_futures_top_long_short_ratio(params: LongShortInput, ctx: Context) -> str:
    """Top trader long/short account ratio via /futures/data/topLongShortAccountRatio."""
    try:
        data = await _binance_get(ctx, Market.FUTURES, "/futures/data/topLongShortAccountRatio", {
            "symbol": params.symbol, "period": params.period, "limit": params.limit,
        })
        return format_response(data, params.response_format, title=f"Top Long/Short {params.symbol} {params.period}")
    except Exception as e:
        return handle_exchange_error(e)


# endregion

# region ---------- Binance WS tools ----------


def _binance_ws_url(market: Market, stream: str) -> str:
    base = BINANCE_SPOT_WS if market == Market.SPOT else BINANCE_FUTURES_WS
    return f"{base}/ws/{stream}"


def _binance_ws_combined_url(market: Market, streams: list[str]) -> str:
    base = BINANCE_SPOT_WS if market == Market.SPOT else BINANCE_FUTURES_WS
    return f"{base}/stream?streams=" + "/".join(streams)


@mcp.tool(name="binance_ws_collect_stream", annotations={**READ_ANNOTATIONS, "idempotentHint": False, "title": "Binance WS Snapshot"})
async def binance_ws_collect_stream(params: WsStreamInput, ctx: Context) -> str:
    """Connect to a single Binance WebSocket stream and collect messages for duration_sec.

    Spot base: wss://stream.binance.com:9443. Futures base: wss://fstream.binance.com.
    Example streams: 'btcusdt@aggTrade', 'btcusdt@bookTicker', 'btcusdt@depth20@100ms',
    'btcusdt@kline_5m', 'btcusdt@markPrice@1s', '!forceOrder@arr'.

    Caps duration_sec to 60s. If >1000 messages are received, returns the first 500
    and last 500 plus summary stats (count, msgs/sec, first/last timestamp).
    """
    try:
        url = _binance_ws_url(params.market, params.stream)
        msgs = await collect_binance_ws(url, params.duration_sec)
        summary = _summarize_ws(msgs, params.duration_sec)
        payload = {"stream": params.stream, "market": params.market.value, "summary": summary, "messages": _sample_messages(msgs)}
        return format_response(payload, params.response_format, title=f"WS Snapshot {params.stream}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="binance_ws_collect_multi_stream", annotations={**READ_ANNOTATIONS, "idempotentHint": False, "title": "Binance WS Multi-Stream Snapshot"})
async def binance_ws_collect_multi_stream(params: WsMultiStreamInput, ctx: Context) -> str:
    """Connect to the Binance combined-stream endpoint with multiple streams and collect messages."""
    try:
        url = _binance_ws_combined_url(params.market, params.streams)
        msgs = await collect_binance_ws(url, params.duration_sec)
        summary = _summarize_ws(msgs, params.duration_sec)
        payload = {"streams": params.streams, "market": params.market.value, "summary": summary, "messages": _sample_messages(msgs)}
        return format_response(payload, params.response_format, title="WS Multi-Stream Snapshot")
    except Exception as e:
        return handle_exchange_error(e)


# endregion

# region ---------- CoinDCX REST tools ----------


@mcp.tool(name="coindcx_get_markets", annotations={**READ_ANNOTATIONS, "title": "CoinDCX Markets List"})
async def coindcx_get_markets(params: FormatOnly, ctx: Context) -> str:
    """List CoinDCX market symbols via /exchange/v1/markets."""
    try:
        data = await _coindcx_get(ctx, f"{COINDCX_REST}/exchange/v1/markets")
        return format_response(data, params.response_format, title="CoinDCX Markets")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="coindcx_get_market_details", annotations={**READ_ANNOTATIONS, "title": "CoinDCX Market Details"})
async def coindcx_get_market_details(params: FormatOnly, ctx: Context) -> str:
    """Full market metadata via /exchange/v1/markets_details."""
    try:
        data = await _coindcx_get(ctx, f"{COINDCX_REST}/exchange/v1/markets_details")
        return format_response(data, params.response_format, title="CoinDCX Market Details")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="coindcx_get_ticker", annotations={**READ_ANNOTATIONS, "title": "CoinDCX Ticker"})
async def coindcx_get_ticker(params: CoinDcxTickerInput, ctx: Context) -> str:
    """Last prices and 24hr stats via /exchange/ticker. Filters client-side when `market` is supplied."""
    try:
        data = await _coindcx_get(ctx, f"{COINDCX_REST}/exchange/ticker")
        if params.market and isinstance(data, list):
            wanted = params.market.strip().upper()
            data = [row for row in data if str(row.get("market", "")).upper() == wanted]
        return format_response(data, params.response_format, title="CoinDCX Ticker")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="coindcx_get_order_book", annotations={**READ_ANNOTATIONS, "title": "CoinDCX Order Book"})
async def coindcx_get_order_book(params: CoinDcxPairInput, ctx: Context) -> str:
    """Order book snapshot via public.coindcx.com/market_data/orderbook (pair format like 'B-BTC_USDT')."""
    try:
        data = await _coindcx_get(ctx, f"{COINDCX_PUBLIC}/market_data/orderbook", {"pair": params.pair})
        bids_dict = data.get("bids", {}) if isinstance(data, dict) else {}
        asks_dict = data.get("asks", {}) if isinstance(data, dict) else {}
        bids = sorted(([float(p), float(q)] for p, q in bids_dict.items()), key=lambda r: -r[0])
        asks = sorted(([float(p), float(q)] for p, q in asks_dict.items()), key=lambda r: r[0])
        stats = depth_imbalance(bids, asks, top_n=min(10, len(bids), len(asks)))
        result = {
            "pair": params.pair,
            "stats": stats,
            "bids": bids[: params.limit],
            "asks": asks[: params.limit],
        }
        return format_response(result, params.response_format, title=f"CoinDCX Order Book {params.pair}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="coindcx_get_recent_trades", annotations={**READ_ANNOTATIONS, "title": "CoinDCX Recent Trades"})
async def coindcx_get_recent_trades(params: CoinDcxPairInput, ctx: Context) -> str:
    """Recent trade prints via public.coindcx.com/market_data/trade_history."""
    try:
        data = await _coindcx_get(
            ctx,
            f"{COINDCX_PUBLIC}/market_data/trade_history",
            {"pair": params.pair, "limit": params.limit},
        )
        return format_response(data, params.response_format, title=f"CoinDCX Recent Trades {params.pair}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="coindcx_get_candles", annotations={**READ_ANNOTATIONS, "title": "CoinDCX Candles"})
async def coindcx_get_candles(params: CoinDcxCandlesInput, ctx: Context) -> str:
    """Candlestick data via public.coindcx.com/market_data/candles."""
    try:
        q: dict[str, Any] = {"pair": params.pair, "interval": params.interval, "limit": params.limit}
        if params.startTime:
            q["startTime"] = params.startTime
        if params.endTime:
            q["endTime"] = params.endTime
        data = await _coindcx_get(ctx, f"{COINDCX_PUBLIC}/market_data/candles", q)
        return format_response(data, params.response_format, title=f"CoinDCX Candles {params.pair} {params.interval}")
    except Exception as e:
        return handle_exchange_error(e)


# endregion

# region ---------- CoinDCX WS tool ----------


@mcp.tool(name="coindcx_ws_collect_stream", annotations={**READ_ANNOTATIONS, "idempotentHint": False, "title": "CoinDCX WS Snapshot"})
async def coindcx_ws_collect_stream(params: CoinDcxWsInput, ctx: Context) -> str:
    """Connect to CoinDCX Socket.IO stream and collect messages for duration_sec.

    Channels: 'coindcx' (spot trade prints), 'currentPrices@futures', 'depth-update@<pair>'
    (e.g. depth-update@B-BTC_USDT), 'candlestick'. Caps duration_sec to 60s.
    """
    try:
        msgs = await collect_coindcx_ws(params.channel, params.duration_sec)
        summary = {
            "count": len(msgs),
            "duration_sec": params.duration_sec,
            "msgs_per_sec": (len(msgs) / params.duration_sec) if params.duration_sec > 0 else 0.0,
            "first_ts_ms": msgs[0]["ts_ms"] if msgs else None,
            "last_ts_ms": msgs[-1]["ts_ms"] if msgs else None,
        }
        payload = {"channel": params.channel, "summary": summary, "messages": _sample_messages(msgs)}
        return format_response(payload, params.response_format, title=f"CoinDCX WS {params.channel}")
    except Exception as e:
        return handle_exchange_error(e)


# endregion

# region ---------- Cross-exchange tools ----------


async def _fetch_binance_price(ctx: Context, symbol: str) -> float:
    data = await _binance_get(ctx, Market.SPOT, "/api/v3/ticker/price", {"symbol": symbol})
    return float(data["price"])


async def _fetch_coindcx_price(ctx: Context, market: str) -> float:
    data = await _coindcx_get(ctx, f"{COINDCX_REST}/exchange/ticker")
    if not isinstance(data, list):
        raise RuntimeError("CoinDCX ticker returned unexpected payload")
    for row in data:
        if str(row.get("market", "")).upper() == market.upper():
            return float(row.get("last_price") or row.get("ask") or row.get("bid") or 0.0)
    raise RuntimeError(f"CoinDCX market '{market}' not present in ticker response")


@mcp.tool(name="cross_exchange_compare_price", annotations={**READ_ANNOTATIONS, "title": "Cross-Exchange Price Compare"})
async def cross_exchange_compare_price(params: CrossPriceInput, ctx: Context) -> str:
    """Compare last price between Binance and CoinDCX for a given asset.

    Returns both prices, a CoinDCX USDTINR conversion, and a suggested arbitrage
    direction with spread in bps. Quote defaults to USDT.
    """
    try:
        binance_symbol = f"{params.asset}{params.quote}"
        normalize_symbol(binance_symbol)
        coindcx_market = f"{params.asset}{params.quote}"
        bn_price_task = _fetch_binance_price(ctx, binance_symbol)
        cdcx_price_task = _fetch_coindcx_price(ctx, coindcx_market)
        usdt_inr_task = _fetch_coindcx_price(ctx, "USDTINR")
        binance_price, coindcx_price, usdt_inr = await asyncio.gather(
            bn_price_task, cdcx_price_task, usdt_inr_task, return_exceptions=True
        )

        result: dict[str, Any] = {
            "asset": params.asset,
            "quote": params.quote,
            "binance": {"symbol": binance_symbol, "price": None, "error": None},
            "coindcx": {"market": coindcx_market, "price": None, "error": None},
            "usdt_inr": None,
        }
        if isinstance(binance_price, Exception):
            result["binance"]["error"] = str(binance_price)
        else:
            result["binance"]["price"] = binance_price
        if isinstance(coindcx_price, Exception):
            result["coindcx"]["error"] = str(coindcx_price)
        else:
            result["coindcx"]["price"] = coindcx_price
        if not isinstance(usdt_inr, Exception):
            result["usdt_inr"] = usdt_inr

        if result["binance"]["price"] and result["coindcx"]["price"]:
            bp = float(result["binance"]["price"])
            cp = float(result["coindcx"]["price"])
            mid = (bp + cp) / 2.0
            spread_bps = (cp - bp) / mid * 10_000.0 if mid > 0 else None
            result["spread_bps"] = spread_bps
            if spread_bps is not None:
                if spread_bps > 0:
                    result["suggested_direction"] = "Buy on Binance, sell on CoinDCX"
                elif spread_bps < 0:
                    result["suggested_direction"] = "Buy on CoinDCX, sell on Binance"
                else:
                    result["suggested_direction"] = "No spread"
        return format_response(result, params.response_format, title=f"Cross-Exchange Price {params.asset}/{params.quote}")
    except Exception as e:
        return handle_exchange_error(e)


async def _fetch_binance_book(ctx: Context, symbol: str, limit: int = 500) -> dict:
    return await _binance_get(ctx, Market.SPOT, "/api/v3/depth", {"symbol": symbol, "limit": limit})


async def _fetch_coindcx_book(ctx: Context, pair: str) -> dict:
    return await _coindcx_get(ctx, f"{COINDCX_PUBLIC}/market_data/orderbook", {"pair": pair})


@mcp.tool(name="cross_exchange_compare_depth", annotations={**READ_ANNOTATIONS, "title": "Cross-Exchange Depth Compare"})
async def cross_exchange_compare_depth(params: CrossDepthInput, ctx: Context) -> str:
    """Compare bid/ask quantity within depth_pct of mid on Binance vs CoinDCX.

    Sums quantities on each side that sit within `depth_pct` percent of the
    venue's own mid price, then identifies the deeper venue per side.
    """
    try:
        binance_symbol = f"{params.asset}{params.quote}"
        normalize_symbol(binance_symbol)
        pair = coindcx_pair(params.asset, params.quote)

        bn_book, cdcx_book = await asyncio.gather(
            _fetch_binance_book(ctx, binance_symbol),
            _fetch_coindcx_book(ctx, pair),
        )
        bn_bids = bn_book.get("bids", [])
        bn_asks = bn_book.get("asks", [])
        cdcx_bids_dict = cdcx_book.get("bids", {}) if isinstance(cdcx_book, dict) else {}
        cdcx_asks_dict = cdcx_book.get("asks", {}) if isinstance(cdcx_book, dict) else {}
        cdcx_bids = sorted(([float(p), float(q)] for p, q in cdcx_bids_dict.items()), key=lambda r: -r[0])
        cdcx_asks = sorted(([float(p), float(q)] for p, q in cdcx_asks_dict.items()), key=lambda r: r[0])

        bn = depth_within_pct(bn_bids, bn_asks, params.depth_pct)
        cdcx = depth_within_pct(cdcx_bids, cdcx_asks, params.depth_pct)
        deeper_bid = "binance" if bn["bid_qty"] >= cdcx["bid_qty"] else "coindcx"
        deeper_ask = "binance" if bn["ask_qty"] >= cdcx["ask_qty"] else "coindcx"
        result = {
            "asset": params.asset,
            "quote": params.quote,
            "depth_pct": params.depth_pct,
            "binance": {"symbol": binance_symbol, **bn},
            "coindcx": {"pair": pair, **cdcx},
            "deeper_bid_venue": deeper_bid,
            "deeper_ask_venue": deeper_ask,
        }
        return format_response(result, params.response_format, title=f"Depth Compare {params.asset}/{params.quote}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="market_sentiment_analysis", annotations={**READ_ANNOTATIONS, "title": "Market Sentiment Analysis"})
async def market_sentiment_analysis(params: SymbolInput, ctx: Context) -> str:
    """Synthesize futures metrics (Funding, OI, Long/Short) into a sentiment profile.

    Analysis includes:
    - Funding Rate (Aggression)
    - Open Interest trend (Conviction)
    - Long/Short ratio (Crowdedness)
    - Price/OI correlation
    """
    try:
        # Parallel fetch of all required signals
        p_task = _binance_get(ctx, Market.FUTURES, "/fapi/v1/premiumIndex", {"symbol": params.symbol})
        oi_task = _binance_get(ctx, Market.FUTURES, "/futures/data/openInterestHist", {
            "symbol": params.symbol, "period": "5m", "limit": 12  # Last hour in 5m chunks
        })
        ls_task = _binance_get(ctx, Market.FUTURES, "/futures/data/topLongShortAccountRatio", {
            "symbol": params.symbol, "period": "5m", "limit": 2
        })
        price_task = _binance_get(ctx, Market.FUTURES, "/fapi/v1/ticker/price", {"symbol": params.symbol})

        p_idx, oi_hist, ls_hist, last_price = await asyncio.gather(p_task, oi_task, ls_task, price_task)

        # 1. Funding Sentiment
        funding = float(p_idx.get("lastFundingRate", 0))
        funding_desc = "Neutral"
        if funding > 0.0001: funding_desc = "Bullish (Longs paying Shorts)"
        elif funding < -0.0001: funding_desc = "Bearish (Shorts paying Longs)"

        # 2. OI Trend (Conviction)
        oi_now = float(oi_hist[-1]["sumOpenInterest"]) if oi_hist else 0
        oi_prev = float(oi_hist[0]["sumOpenInterest"]) if len(oi_hist) > 1 else oi_now
        oi_change_pct = ((oi_now / oi_prev) - 1) * 100 if oi_prev > 0 else 0
        oi_trend = "Stable"
        if oi_change_pct > 1: oi_trend = "Rising (Increasing Conviction)"
        elif oi_change_pct < -1: oi_trend = "Falling (Position Unwinding)"

        # 3. Long/Short Ratio (Crowdedness)
        ls_ratio = float(ls_hist[-1]["longShortRatio"]) if ls_hist else 1.0
        ls_desc = "Balanced"
        if ls_ratio > 2.0: ls_desc = "Heavily Long (Crowded)"
        elif ls_ratio < 0.5: ls_desc = "Heavily Short (Crowded)"

        # 4. Final Sentiment Synthesis
        sentiment = "Neutral"
        score = 0
        if funding > 0.00005: score += 1
        if funding < -0.00005: score -= 1
        if oi_change_pct > 0.5: score += 1
        if oi_change_pct < -0.5: score -= 1
        
        if score >= 2: sentiment = "Strongly Bullish"
        elif score == 1: sentiment = "Mildly Bullish"
        elif score == -1: sentiment = "Mildly Bearish"
        elif score <= -2: sentiment = "Strongly Bearish"

        result = {
            "symbol": params.symbol,
            "sentiment": sentiment,
            "metrics": {
                "price": float(last_price["price"]),
                "funding_rate": funding,
                "funding_bias": funding_desc,
                "oi_change_1h_pct": round(oi_change_pct, 2),
                "oi_conviction": oi_trend,
                "top_traders_ls_ratio": ls_ratio,
                "ls_positioning": ls_desc
            },
            "interpretation": (
                f"Market sentiment for {params.symbol} is currently {sentiment}. "
                f"Funding is {funding_desc} and Open Interest is {oi_trend} over the last hour. "
                f"Top traders are {ls_desc} with a ratio of {ls_ratio}."
            )
        }
        return format_response(result, params.response_format, title=f"Sentiment Analysis {params.symbol}")
    except Exception as e:
        return handle_exchange_error(e)


@mcp.tool(name="technical_analysis_summary", annotations={**READ_ANNOTATIONS, "title": "Technical Analysis Summary"})
async def technical_analysis_summary(params: KlinesInput, ctx: Context) -> str:
    """Compute basic indicators (RSI, MA) from recent OHLCV data.

    Calculates:
    - RSI (14)
    - Simple Moving Averages (MA20, MA50)
    - Price position relative to MAs
    - Volume trend (last 5 vs previous 15)
    """
    try:
        path = "/api/v3/klines" if params.market == Market.SPOT else "/fapi/v1/klines"
        # Fetch slightly more than requested to calculate indicators
        limit = max(params.limit, 100)
        q: dict[str, Any] = {"symbol": params.symbol, "interval": params.interval, "limit": limit}
        data = await _binance_get(ctx, params.market, path, q)
        
        if not data or len(data) < 20:
            return "Error: Not enough data to calculate indicators (min 20 candles required)."

        closes = [float(c[4]) for c in data]
        volumes = [float(c[5]) for c in data]
        current_price = closes[-1]

        # 1. Simple Moving Averages
        ma20 = sum(closes[-20:]) / 20
        ma50 = sum(closes[-50:]) / 50 if len(closes) >= 50 else None
        
        ma_desc = f"Price is {'above' if current_price > ma20 else 'below'} MA20 ({round(ma20, 4)})"
        if ma50:
            ma_desc += f" and {'above' if current_price > ma50 else 'below'} MA50 ({round(ma50, 4)})"

        # 2. RSI (14)
        deltas = [closes[i] - closes[i-1] for i in range(1, len(closes))]
        gains = [d if d > 0 else 0 for d in deltas]
        losses = [-d if d < 0 else 0 for d in deltas]
        
        avg_gain = sum(gains[-14:]) / 14
        avg_loss = sum(losses[-14:]) / 14
        
        if avg_loss == 0:
            rsi = 100
        else:
            rs = avg_gain / avg_loss
            rsi = 100 - (100 / (1 + rs))
        
        rsi_desc = "Neutral"
        if rsi > 70: rsi_desc = "Overbought"
        elif rsi < 30: rsi_desc = "Oversold"

        # 3. Volume Trend
        vol_now = sum(volumes[-5:]) / 5
        vol_prev = sum(volumes[-20:-5]) / 15 if len(volumes) >= 20 else vol_now
        vol_ratio = vol_now / vol_prev if vol_prev > 0 else 1.0
        vol_desc = "Normal"
        if vol_ratio > 1.5: vol_desc = "High (Spiking)"
        elif vol_ratio < 0.5: vol_desc = "Low (Drying up)"

        result = {
            "symbol": params.symbol,
            "interval": params.interval,
            "indicators": {
                "current_price": current_price,
                "rsi_14": round(rsi, 2),
                "rsi_bias": rsi_desc,
                "ma20": round(ma20, 4),
                "ma50": round(ma50, 4) if ma50 else None,
                "ma_bias": ma_desc,
                "volume_ratio": round(vol_ratio, 2),
                "volume_trend": vol_desc
            },
            "summary": (
                f"On the {params.interval} timeframe, {params.symbol} is {rsi_desc} (RSI: {round(rsi, 1)}). "
                f"{ma_desc}. Volume is {vol_desc}."
            )
        }
        return format_response(result, params.response_format, title=f"Technical Summary {params.symbol} {params.interval}")
    except Exception as e:
        return handle_exchange_error(e)


# endregion

# region ---------- entrypoint ----------


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """Parse CLI flags. `--transport` defaults to env `MCP_TRANSPORT` or `stdio`."""
    env_transport = os.getenv("MCP_TRANSPORT", "stdio").strip() or "stdio"
    parser = argparse.ArgumentParser(
        prog="crypto-exchange-mcp",
        description="Crypto exchange MCP server (Binance + CoinDCX public data).",
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "http", "sse", "streamable-http"],
        default=env_transport,
        help="Transport for MCP. 'http' is an alias for 'streamable-http'. Default: stdio.",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("MCP_HOST", "0.0.0.0"),
        help="Bind host for http/sse transport (default: %(default)s).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("MCP_PORT", "4003")),
        help="Bind port for http/sse transport (default: %(default)s).",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> None:
    """Entrypoint supporting both stdio and HTTP/SSE transports."""
    args = _parse_args(argv)
    transport = args.transport
    if transport == "http":
        transport = "streamable-http"

    if transport == "stdio":
        log.info("starting crypto_exchange_mcp transport=stdio")
        mcp.run()
        return

    # For HTTP/SSE, enable CORS support for browser-based UIs (like MCP Inspector/llama.cpp UI).
    import uvicorn

    log.info(
        "starting crypto_exchange_mcp transport=%s host=%s port=%s with CORS",
        transport, args.host, args.port,
    )

    if transport == "sse":
        app = mcp.sse_app()
    else:
        app = mcp.streamable_http_app()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["mcp-session-id"],
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()

# endregion
