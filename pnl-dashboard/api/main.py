from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from contextlib import asynccontextmanager
from .db import init_pool, close_pool
from .routers import trades, positions, equity, wallet, predictions
from .broadcaster import broadcaster
from .listener import get_listener

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_pool()
    listener = get_listener()
    await listener.start()
    yield
    await listener.stop()
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

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await broadcaster.connect(websocket)
    try:
        # Keep connection open until client disconnects
        while True:
            # We don't expect messages from the client yet, 
            # but we need to receive to detect disconnect
            await websocket.receive_text()
    except WebSocketDisconnect:
        broadcaster.disconnect(websocket)
    except Exception:
        broadcaster.disconnect(websocket)

@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/docs")

@app.get("/health")
async def health():
    return {"status": "ok"}
