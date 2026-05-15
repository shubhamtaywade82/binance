-- Real-time triggers for PnL Dashboard
-- Emits NOTIFY on trades, positions, and equity_snapshots

CREATE OR REPLACE FUNCTION notify_pnl_update() RETURNS trigger AS $$
DECLARE
  payload JSONB;
  channel TEXT;
BEGIN
  IF (TG_TABLE_NAME = 'trades') THEN
    channel := 'pnl_trades';
    payload := jsonb_build_object('type', 'trade', 'data', row_to_json(NEW));
  ELSIF (TG_TABLE_NAME = 'positions') THEN
    channel := 'pnl_positions';
    IF (TG_OP = 'DELETE') THEN
        payload := jsonb_build_object('type', 'position_delete', 'symbol', OLD.symbol);
    ELSE
        payload := jsonb_build_object('type', 'position', 'data', row_to_json(NEW));
    END IF;
  ELSIF (TG_TABLE_NAME = 'equity_snapshots') THEN
    channel := 'pnl_equity';
    payload := jsonb_build_object('type', 'equity', 'data', row_to_json(NEW));
  END IF;

  PERFORM pg_notify(channel, payload::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trades Trigger
DROP TRIGGER IF EXISTS trg_notify_trade ON trades;
CREATE TRIGGER trg_notify_trade
AFTER INSERT ON trades
FOR EACH ROW EXECUTE FUNCTION notify_pnl_update();

-- Positions Trigger
DROP TRIGGER IF EXISTS trg_notify_position ON positions;
CREATE TRIGGER trg_notify_position
AFTER INSERT OR UPDATE OR DELETE ON positions
FOR EACH ROW EXECUTE FUNCTION notify_pnl_update();

-- Equity Trigger
DROP TRIGGER IF EXISTS trg_notify_equity ON equity_snapshots;
CREATE TRIGGER trg_notify_equity
AFTER INSERT ON equity_snapshots
FOR EACH ROW EXECUTE FUNCTION notify_pnl_update();
