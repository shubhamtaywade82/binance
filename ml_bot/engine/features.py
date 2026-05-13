import numpy as np
from collections import deque
from engine.orderbook import OrderBook


class FeatureEngine:
    def __init__(self, window: int = 300) -> None:
        self.prices: deque[float] = deque(maxlen=window)
        self.buy_vol: deque[float] = deque(maxlen=window)
        self.sell_vol: deque[float] = deque(maxlen=window)
        self.oi_hist: deque[float] = deque(maxlen=120)
        self.funding_rates: deque[float] = deque(maxlen=480)

    def on_trade(self, price: float, qty: float, is_maker_sell: bool) -> None:
        self.prices.append(price)
        if is_maker_sell:
            self.buy_vol.append(qty)
        else:
            self.sell_vol.append(qty)

    def on_oi(self, oi: float) -> None:
        self.oi_hist.append(oi)

    def on_funding(self, rate: float) -> None:
        self.funding_rates.append(rate)

    def compute(self, ob: OrderBook) -> dict | None:
        bid, ask = ob.top()
        if bid == 0 or ask == 0:
            return None

        mid = (bid + ask) / 2
        spread = ask - bid

        bids, asks = ob.top_levels(10)
        bid_vol5 = sum(q for _, q in bids[:5])
        ask_vol5 = sum(q for _, q in asks[:5])
        total5 = bid_vol5 + ask_vol5 + 1e-9
        obi5 = (bid_vol5 - ask_vol5) / total5

        bid_vol10 = sum(q for _, q in bids[:10])
        ask_vol10 = sum(q for _, q in asks[:10])
        total10 = bid_vol10 + ask_vol10 + 1e-9
        obi10 = (bid_vol10 - ask_vol10) / total10

        bid_vol_top = bids[0][1] if bids else 0.0
        ask_vol_top = asks[0][1] if asks else 0.0
        microprice = (ask * bid_vol_top + bid * ask_vol_top) / (bid_vol_top + ask_vol_top + 1e-9)

        buy_v = sum(self.buy_vol)
        sell_v = sum(self.sell_vol)
        tfi_1s = buy_v - sell_v

        prices = np.array(self.prices) if self.prices else np.array([mid])
        rets = np.diff(np.log(prices)) if len(prices) > 1 else np.array([0.0])

        vol_1m = float(np.std(rets[-60:])) if len(rets) >= 60 else 0.0
        ret_1m = float(np.sum(rets[-60:])) if len(rets) >= 60 else 0.0
        ret_5m = float(np.sum(rets[-300:])) if len(rets) >= 300 else 0.0
        rv_1m = float(np.sqrt(np.mean(rets[-60:] ** 2))) if len(rets) >= 60 else 0.0
        rv_5m = float(np.sqrt(np.mean(rets[-300:] ** 2))) if len(rets) >= 300 else 0.0

        oi_delta = 0.0
        oi_zscore = 0.0
        oi = 0.0
        if len(self.oi_hist) >= 2:
            oi = self.oi_hist[-1]
            deltas = np.diff(list(self.oi_hist))
            oi_delta = float(deltas[-1])
            std = float(deltas.std())
            oi_zscore = float((oi_delta - deltas.mean()) / (std + 1e-9)) if std > 0 else 0.0

        funding_zscore = 0.0
        funding_rate = self.funding_rates[-1] if self.funding_rates else 0.0
        if len(self.funding_rates) >= 2:
            rates = np.array(self.funding_rates)
            f_std = float(rates.std())
            funding_zscore = float((funding_rate - rates.mean()) / (f_std + 1e-9)) if f_std > 0 else 0.0

        vol_regime_flag = 1 if rv_1m > 2 * rv_5m and rv_5m > 0 else 0
        trend_strength = abs(ret_1m) / vol_1m if vol_1m > 0 else 0.0

        return {
            "mid_price": mid,
            "bid_price": bid,
            "ask_price": ask,
            "spread": spread,
            "obi_5": obi5,
            "obi_10": obi10,
            "microprice": microprice,
            "trade_imbalance_1s": tfi_1s,
            "ret_1m": ret_1m,
            "ret_5m": ret_5m,
            "vol_1m": vol_1m,
            "rv_1m": rv_1m,
            "rv_5m": rv_5m,
            "oi": oi,
            "oi_delta_1m": oi_delta,
            "oi_zscore": oi_zscore,
            "funding_rate": funding_rate,
            "funding_zscore": funding_zscore,
            "vol_regime_flag": vol_regime_flag,
            "trend_strength": trend_strength,
        }
