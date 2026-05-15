import os
import asyncpg

pool: asyncpg.Pool | None = None

async def init_pool():
    global pool
    dsn = os.getenv("POSTGRES_URL", "postgresql://postgres:postgres@localhost:5434/bot")
    pool = await asyncpg.create_pool(dsn, min_size=2, max_size=10)

async def close_pool():
    global pool
    if pool:
        await pool.close()
        pool = None

async def get_pool() -> asyncpg.Pool:
    if pool is None:
        raise RuntimeError("Database pool not initialized")
    return pool
