from fastapi import APIRouter, Query
from ..db import get_pool

router = APIRouter()

@router.get("")
async def list_trades(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    symbol: str | None = None,
    side: str | None = None,
):
    pool = await get_pool()
    conditions = []
    params = []
    idx = 1

    if symbol:
        conditions.append(f"symbol = ${idx}")
        params.append(symbol.upper())
        idx += 1
    if side:
        conditions.append(f"side = ${idx}")
        params.append(side.upper())
        idx += 1

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params.extend([limit, offset])

    rows = await pool.fetch(
        f"SELECT * FROM trades {where} ORDER BY timestamp_ms DESC LIMIT ${idx} OFFSET ${idx+1}",
        *params
    )
    return [dict(r) for r in rows]

@router.get("/stats")
async def trade_stats():
    pool = await get_pool()
    row = await pool.fetchrow("""
        SELECT
            COUNT(*) AS total_trades,
            COALESCE(SUM(net_pnl), 0) AS total_pnl,
            COUNT(*) FILTER (WHERE net_pnl > 0) AS winning_trades,
            COUNT(*) FILTER (WHERE net_pnl < 0) AS losing_trades,
            COALESCE(AVG(net_pnl) FILTER (WHERE net_pnl > 0), 0) AS avg_win,
            COALESCE(AVG(ABS(net_pnl)) FILTER (WHERE net_pnl < 0), 0) AS avg_loss,
            COALESCE(SUM(fees), 0) AS total_fees,
            COALESCE(SUM(funding), 0) AS total_funding
        FROM trades
    """)
    result = dict(row)
    total = result["total_trades"]
    wins = result["winning_trades"]
    result["win_rate"] = wins / total if total > 0 else 0
    avg_loss = result["avg_loss"]
    result["profit_factor"] = result["avg_win"] / avg_loss if avg_loss > 0 else 0
    return result
