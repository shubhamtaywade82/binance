from config import MAX_POSITION, MAX_DAILY_LOSS


class RiskManager:
    def __init__(self, equity: float) -> None:
        self.position = 0.0
        self.daily_loss = 0.0
        self.equity = equity
        self.killed = False

    def check_kill(self) -> bool:
        if self.equity > 0 and self.daily_loss / self.equity > MAX_DAILY_LOSS:
            self.killed = True
        return self.killed

    def size(self, signal: str) -> float:
        if self.killed:
            return 0.0
        if signal == "HOLD":
            return 0.0
        if signal == "LONG":
            return min(MAX_POSITION, MAX_POSITION - self.position)
        return -min(MAX_POSITION, MAX_POSITION + self.position)

    def record_pnl(self, pnl: float) -> None:
        if pnl < 0:
            self.daily_loss += abs(pnl)
