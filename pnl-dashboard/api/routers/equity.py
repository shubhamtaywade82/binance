from fastapi import APIRouter, Query
from ..db import get_pool

router = APIRouter()

DEFAULT_INR_PER_USDT = 85.0


@router.get("/curve")
async def equity_curve(
    since: int | None = Query(None, description="Unix ms timestamp"),
    limit: int = Query(1000, ge=1, le=10000),
):
    pool = await get_pool()
    if since:
        rows = await pool.fetch(
            "SELECT ts, equity, drawdown, balance, open_positions FROM equity_snapshots WHERE ts > $1 ORDER BY ts LIMIT $2",
            since, limit
        )
    else:
        rows = await pool.fetch(
            "SELECT ts, equity, drawdown, balance, open_positions FROM equity_snapshots ORDER BY ts DESC LIMIT $1",
            limit
        )
        rows = list(reversed(rows))
    return [dict(r) for r in rows]


@router.get("/latest")
async def equity_latest():
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT 1"
    )
    if not row:
        return {}
    out = dict(row)
    fx = float(out.get("inr_per_usdt") or DEFAULT_INR_PER_USDT)
    out["inr_per_usdt"] = fx
    out["balance_inr"] = float(out["balance"]) * fx
    out["equity_inr"] = float(out["equity"]) * fx
    out["used_margin_inr"] = float(out["used_margin"]) * fx
    out["unrealized_pnl_inr"] = float(out["unrealized_pnl"]) * fx
    out["realized_pnl_inr"] = float(out["realized_pnl"]) * fx
    return out
