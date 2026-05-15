from fastapi import APIRouter, Query
from ..db import get_pool

router = APIRouter()

@router.get("")
async def list_predictions(
    limit: int = Query(100, ge=1, le=1000),
    symbol: str | None = None,
):
    pool = await get_pool()
    if symbol:
        rows = await pool.fetch(
            "SELECT * FROM predictions WHERE symbol = $1 ORDER BY timestamp_ms DESC LIMIT $2",
            symbol.upper(), limit
        )
    else:
        rows = await pool.fetch(
            "SELECT * FROM predictions ORDER BY timestamp_ms DESC LIMIT $1",
            limit
        )
    return [dict(r) for r in rows]
