import asyncio
import json
from fastapi import WebSocket
from typing import Set

class Broadcaster:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        if not self.active_connections:
            return
            
        payload = json.dumps(message)
        # Create a list of tasks for parallel sending
        tasks = [
            asyncio.create_task(self._send_to_client(client, payload))
            for client in self.active_connections
        ]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _send_to_client(self, websocket: WebSocket, payload: str):
        try:
            await websocket.send_text(payload)
        except Exception:
            # Connection might be dead, it will be removed on disconnect
            pass

# Global instance
broadcaster = Broadcaster()
