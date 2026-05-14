from fastapi import APIRouter
from ..db import get_pool

router = APIRouter()

@router.get("")
async def wallet_state():
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT 1"
    )
    if not row:
        return {"balance": 0, "equity": 0, "used_margin": 0, "unrealized_pnl": 0, "realized_pnl": 0}
    return {
        "balance": row["balance"],
        "equity": row["equity"],
        "used_margin": row["used_margin"],
        "unrealized_pnl": row["unrealized_pnl"],
        "realized_pnl": row["realized_pnl"],
        "open_positions": row["open_positions"],
        "updated_at": row["ts"],
    }
