"""Standalone Python ML bot — async event loop wiring all components."""

import asyncio
import aiohttp
from ingestion.ws_client import start_ws
from engine.orderbook import OrderBook
from engine.features import FeatureEngine
from model.inference import Model
from strategy.decision import decide
from strategy.risk import RiskManager
from execution.binance import place_order
from config import SYMBOL, MODEL_PATH


async def main() -> None:
    queue: asyncio.Queue = asyncio.Queue()
    ob = OrderBook()
    features = FeatureEngine()
    risk = RiskManager(equity=1000.0)

    try:
        model = Model(MODEL_PATH)
        print(f"Model loaded from {MODEL_PATH}")
    except FileNotFoundError:
        print(f"Model not found at {MODEL_PATH}. Run train.py first.")
        return

    asyncio.create_task(start_ws(queue))

    async with aiohttp.ClientSession() as session:
        while True:
            msg = await queue.get()
            stream = msg.get("stream", "")
            data = msg.get("data", {})

            if "depth" in stream:
                ob.update(data)
            if "aggTrade" in stream:
                features.on_trade(
                    float(data["p"]),
                    float(data["q"]),
                    is_maker_sell=data["m"],
                )
            if "markPrice" in stream:
                rate = float(data.get("r", 0))
                if rate != 0:
                    features.on_funding(rate)

            fvec = features.compute(ob)
            if not fvec:
                continue

            if risk.check_kill():
                continue

            pred = model.predict(fvec)
            signal = decide(pred, fvec["vol_1m"])
            qty = risk.size(signal)

            if qty != 0:
                print(f"TRADE {signal} qty={abs(qty):.4f} p_up={pred['p_up']:.2f} p_down={pred['p_down']:.2f}")
                result = await place_order(session, SYMBOL, signal, abs(qty))
                print(f"ORDER: {result}")


if __name__ == "__main__":
    asyncio.run(main())
