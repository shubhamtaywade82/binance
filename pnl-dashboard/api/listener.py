import asyncio
import json
import os
import asyncpg
from .broadcaster import broadcaster

class PnLListener:
    def __init__(self, dsn: str):
        self.dsn = dsn
        self.conn: asyncpg.Connection | None = None
        self._listen_task: asyncio.Task | None = None

    async def start(self):
        self._listen_task = asyncio.create_task(self._listen_loop())

    async def stop(self):
        if self._listen_task:
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
        
        if self.conn:
            await self.conn.close()

    async def _listen_loop(self):
        while True:
            try:
                self.conn = await asyncpg.connect(self.dsn)
                
                # Register notification handlers
                await self.conn.add_listener('pnl_trades', self._handle_notification)
                await self.conn.add_listener('pnl_positions', self._handle_notification)
                await self.conn.add_listener('pnl_equity', self._handle_notification)
                
                print(f"[listener] Listening for Postgres notifications on {self.dsn}")
                
                # Keep the connection alive
                while True:
                    await asyncio.sleep(60)
                    await self.conn.execute("SELECT 1")
                    
            except (asyncpg.PostgresError, OSError) as e:
                print(f"[listener] Connection error: {e}. Retrying in 5s...")
                if self.conn:
                    try:
                        await self.conn.close()
                    except:
                        pass
                await asyncio.sleep(5)
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[listener] Unexpected error: {e}. Retrying in 5s...")
                await asyncio.sleep(5)

    def _handle_notification(self, connection, pid, channel, payload):
        try:
            data = json.loads(payload)
            # Push to broadcaster in a background task
            asyncio.create_task(broadcaster.broadcast(data))
        except Exception as e:
            print(f"[listener] Error handling notification: {e}")

# Factory for global instance
_listener: PnLListener | None = None

def get_listener() -> PnLListener:
    global _listener
    if _listener is None:
        dsn = os.getenv("POSTGRES_URL", "postgresql://postgres:postgres@localhost:5434/bot")
        _listener = PnLListener(dsn)
    return _listener
