"""Pure-function unit tests for helpers in crypto_exchange_mcp.

No live network. Covers response formatter, symbol normalizer, interval
validator, depth math, CoinDCX pair builder, and Binance error parsing.
"""
from __future__ import annotations

import json

import httpx
import pytest

from crypto_exchange_mcp import (
    ResponseFormat,
    VALID_KLINE_INTERVALS,
    _parse_binance_error,
    coindcx_pair,
    depth_imbalance,
    depth_within_pct,
    detect_coindcx_error,
    format_response,
    normalize_coindcx_pair,
    normalize_symbol,
    validate_kline_interval,
)


# ---- format_response ----

def test_format_response_json_returns_string():
    out = format_response({"a": 1, "b": [1, 2]}, ResponseFormat.JSON)
    assert isinstance(out, str)
    assert json.loads(out) == {"a": 1, "b": [1, 2]}


def test_format_response_markdown_dict_title_present():
    out = format_response({"price": 100.5, "symbol": "BTCUSDT"}, "markdown", title="Test Title")
    assert out.startswith("# Test Title")
    assert "price" in out and "100.5" in out


def test_format_response_markdown_list_truncates():
    payload = list(range(50))
    out = format_response(payload, ResponseFormat.MARKDOWN)
    assert "50 items" in out
    assert "30 more items omitted" in out


def test_format_response_markdown_dict_truncates_many_keys():
    payload = {f"k{i}": i for i in range(40)}
    out = format_response(payload, "markdown")
    assert "20 more fields omitted" in out


def test_format_response_accepts_string_format():
    out = format_response({"x": 1}, "json")
    assert json.loads(out) == {"x": 1}


# ---- normalize_symbol ----

def test_normalize_symbol_strips_and_uppercases():
    assert normalize_symbol(" btcusdt ") == "BTCUSDT"


@pytest.mark.parametrize("bad", ["", "  ", "BTC USDT", "btc/usdt", "x"])
def test_normalize_symbol_rejects_invalid(bad):
    with pytest.raises(ValueError):
        normalize_symbol(bad)


# ---- validate_kline_interval ----

def test_validate_kline_interval_accepts_all_whitelist():
    for it in VALID_KLINE_INTERVALS:
        assert validate_kline_interval(it) == it


@pytest.mark.parametrize("bad", ["2m", "10m", "7d", "1y", "", "1H"])
def test_validate_kline_interval_rejects(bad):
    with pytest.raises(ValueError):
        validate_kline_interval(bad)


# ---- depth math ----

def test_depth_imbalance_basic():
    bids = [["100", "2"], ["99", "1"]]
    asks = [["101", "1"], ["102", "1"]]
    stats = depth_imbalance(bids, asks, top_n=2)
    assert stats["bid_qty"] == pytest.approx(3.0)
    assert stats["ask_qty"] == pytest.approx(2.0)
    assert stats["imbalance"] == pytest.approx(0.2)
    assert stats["best_bid"] == 100.0
    assert stats["best_ask"] == 101.0
    assert stats["spread"] == pytest.approx(1.0)
    assert stats["mid"] == pytest.approx(100.5)
    assert stats["spread_bps"] == pytest.approx(1 / 100.5 * 10_000.0)


def test_depth_imbalance_empty():
    stats = depth_imbalance([], [])
    assert stats["bid_qty"] == 0.0
    assert stats["imbalance"] == 0.0
    assert stats["best_bid"] is None


def test_depth_within_pct_filters_by_distance():
    bids = [["100", "5"], ["90", "10"]]
    asks = [["101", "4"], ["120", "20"]]
    out = depth_within_pct(bids, asks, depth_pct=5.0)
    assert out["mid"] == pytest.approx(100.5)
    # only 100 stays in bid (90 is outside 5%); only 101 stays in ask
    assert out["bid_qty"] == pytest.approx(5.0)
    assert out["ask_qty"] == pytest.approx(4.0)


# ---- coindcx pair builder ----

def test_coindcx_pair_builds_expected_format():
    assert coindcx_pair("btc") == "B-BTC_USDT"
    assert coindcx_pair("eth", "usdt") == "B-ETH_USDT"
    assert coindcx_pair("SOL", "inr") == "B-SOL_INR"


def test_normalize_coindcx_pair_accepts_valid():
    assert normalize_coindcx_pair("b-btc_usdt") == "B-BTC_USDT"


@pytest.mark.parametrize("bad", ["BTCUSDT", "B_BTC_USDT", "X-BTC-USDT", ""])
def test_normalize_coindcx_pair_rejects(bad):
    with pytest.raises(ValueError):
        normalize_coindcx_pair(bad)


# ---- error parsing ----

def test_parse_binance_error_extracts_code_msg():
    resp = httpx.Response(400, json={"code": -1121, "msg": "Invalid symbol."})
    assert "code=-1121" in _parse_binance_error(resp)
    assert "Invalid symbol" in _parse_binance_error(resp)


def test_detect_coindcx_error_detects_status_field():
    payload = {"status": "error", "message": "Pair not found"}
    assert "Pair not found" in detect_coindcx_error(payload)


def test_detect_coindcx_error_returns_none_on_success():
    assert detect_coindcx_error({"status": "ok", "data": []}) is None
    assert detect_coindcx_error([{"market": "BTCUSDT"}]) is None
