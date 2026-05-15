from fastapi import APIRouter
from ..db import get_pool

router = APIRouter()

@router.get("")
async def list_positions():
    pool = await get_pool()
    rows = await pool.fetch("SELECT * FROM positions ORDER BY opened_at DESC")
    return [dict(r) for r in rows]
