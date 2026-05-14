from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from .db import init_pool, close_pool
from .routers import trades, positions, equity, wallet, predictions

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_pool()
    yield
    await close_pool()

app = FastAPI(title="PnL Dashboard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trades.router, prefix="/trades", tags=["trades"])
app.include_router(positions.router, prefix="/positions", tags=["positions"])
app.include_router(equity.router, prefix="/equity", tags=["equity"])
app.include_router(wallet.router, prefix="/wallet", tags=["wallet"])
app.include_router(predictions.router, prefix="/predictions", tags=["predictions"])

@app.get("/health")
async def health():
    return {"status": "ok"}
