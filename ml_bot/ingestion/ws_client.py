import asyncio
import websockets
import orjson
from config import WS_STREAMS

URL = "wss://fstream.binance.com/stream?streams=" + "/".join(WS_STREAMS)


async def start_ws(queue: asyncio.Queue) -> None:
    while True:
        try:
            async with websockets.connect(URL, ping_interval=20) as ws:
                async for msg in ws:
                    await queue.put(orjson.loads(msg))
        except Exception as exc:
            print(f"WS error, reconnecting: {exc}")
            await asyncio.sleep(2)
