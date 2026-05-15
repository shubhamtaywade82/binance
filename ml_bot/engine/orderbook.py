class OrderBook:
    def __init__(self) -> None:
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}

    def update(self, data: dict) -> None:
        for p, q in data.get("b", []):
            p, q = float(p), float(q)
            if q == 0:
                self.bids.pop(p, None)
            else:
                self.bids[p] = q
        for p, q in data.get("a", []):
            p, q = float(p), float(q)
            if q == 0:
                self.asks.pop(p, None)
            else:
                self.asks[p] = q

    def top(self) -> tuple[float, float]:
        bid = max(self.bids) if self.bids else 0.0
        ask = min(self.asks) if self.asks else 0.0
        return bid, ask

    def top_levels(self, n: int = 10) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
        bids = sorted(self.bids.items(), reverse=True)[:n]
        asks = sorted(self.asks.items())[:n]
        return bids, asks
