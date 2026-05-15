import time
import hmac
import hashlib
import aiohttp
from config import API_KEY, API_SECRET, BASE_URL


def _sign(params: dict) -> str:
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    sig = hmac.new(API_SECRET.encode(), qs.encode(), hashlib.sha256).hexdigest()
    return f"{qs}&signature={sig}"


async def place_order(
    session: aiohttp.ClientSession,
    symbol: str,
    side: str,
    qty: float,
) -> dict:
    params = {
        "symbol": symbol.upper(),
        "side": "BUY" if side == "LONG" else "SELL",
        "type": "MARKET",
        "quantity": round(qty, 3),
        "timestamp": int(time.time() * 1000),
    }
    qs = _sign(params)
    async with session.post(
        f"{BASE_URL}/fapi/v1/order?{qs}",
        headers={"X-MBX-APIKEY": API_KEY},
    ) as res:
        return await res.json()
