from fastapi import APIRouter
from ..db import get_pool

router = APIRouter()

DEFAULT_INR_PER_USDT = 85.0


def _inr_fields(row, fx: float) -> dict:
    return {
        "balance_inr": float(row["balance"]) * fx,
        "equity_inr": float(row["equity"]) * fx,
        "used_margin_inr": float(row["used_margin"]) * fx,
        "unrealized_pnl_inr": float(row["unrealized_pnl"]) * fx,
        "realized_pnl_inr": float(row["realized_pnl"]) * fx,
    }


@router.get("")
async def wallet_state():
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT 1"
    )
    if not row:
        return {
            "balance": 0,
            "equity": 0,
            "used_margin": 0,
            "unrealized_pnl": 0,
            "realized_pnl": 0,
            "inr_per_usdt": DEFAULT_INR_PER_USDT,
            "balance_inr": 0,
            "equity_inr": 0,
            "used_margin_inr": 0,
            "unrealized_pnl_inr": 0,
            "realized_pnl_inr": 0,
        }
    fx = float(row["inr_per_usdt"]) if row["inr_per_usdt"] is not None else DEFAULT_INR_PER_USDT
    return {
        "balance": row["balance"],
        "equity": row["equity"],
        "used_margin": row["used_margin"],
        "unrealized_pnl": row["unrealized_pnl"],
        "realized_pnl": row["realized_pnl"],
        "open_positions": row["open_positions"],
        "updated_at": row["ts"],
        "inr_per_usdt": fx,
        **_inr_fields(row, fx),
    }


@router.get("/fx")
async def wallet_fx():
    """Latest INR/USDT rate from the most recent equity snapshot."""
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT ts, inr_per_usdt FROM equity_snapshots WHERE inr_per_usdt IS NOT NULL ORDER BY ts DESC LIMIT 1"
    )
    if not row:
        return {"inr_per_usdt": DEFAULT_INR_PER_USDT, "ts": None, "source": "fallback"}
    return {
        "inr_per_usdt": float(row["inr_per_usdt"]),
        "ts": row["ts"],
        "source": "snapshot",
    }
