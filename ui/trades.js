/**
 * trades.js — Live Trade Tape
 */

export class TradeTapeManager {
  constructor() {
    this.maxRows = 120;
    this.rows = [];
    this.buyCount = 0;
    this.sellCount = 0;
    this.listEl = document.getElementById('trades-list');
    this.buysEl  = document.getElementById('tape-buys');
    this.sellsEl = document.getElementById('tape-sells');
  }

  /** Load historical trades from snapshot */
  loadHistory(trades) {
    if (!trades || trades.length === 0) return;
    for (const t of trades) this._addInternal(t, false);
    this._flush();
  }

  /** Single live trade */
  addTrade(trade) {
    this._addInternal(trade, true);
  }

  _addInternal(trade, animate) {
    const isBuy = !trade.makerSide; // maker=sell aggressor → isBuy=false
    if (isBuy) this.buyCount++;
    else        this.sellCount++;

    this.rows.unshift({ ...trade, isBuy });
    if (this.rows.length > this.maxRows) this.rows.pop();

    if (animate) {
      this._prependRow(trade, isBuy);
      this._trimDom();
      this._updateCounts();
    }
  }

  _flush() {
    if (!this.listEl) return;
    this.listEl.innerHTML = this.rows.map((r) => this._rowHtml(r, r.isBuy, false)).join('');
    this._updateCounts();
  }

  _prependRow(trade, isBuy) {
    if (!this.listEl) return;
    const div = document.createElement('div');
    div.innerHTML = this._rowHtml(trade, isBuy, true);
    const row = div.firstElementChild;
    this.listEl.insertBefore(row, this.listEl.firstChild);
  }

  _trimDom() {
    if (!this.listEl) return;
    while (this.listEl.children.length > this.maxRows) {
      this.listEl.removeChild(this.listEl.lastChild);
    }
  }

  _updateCounts() {
    if (this.buysEl)  this.buysEl.textContent  = this.buyCount;
    if (this.sellsEl) this.sellsEl.textContent = this.sellCount;
  }

  _rowHtml(trade, isBuy, _animate) {
    const side  = isBuy ? 'buy' : 'sell';
    const label = isBuy ? 'BUY' : 'SELL';
    const price = this._fmtPrice(trade.price);
    const qty   = this._fmtQty(trade.qty);
    const ts    = this._fmtTs(trade.ts);
    return `<div class="trade-row ${side}">
      <span class="trade-side ${side}">${label}</span>
      <span class="trade-price">${price}</span>
      <span class="trade-qty">${qty}</span>
      <span class="trade-ts">${ts}</span>
    </div>`;
  }

  _fmtPrice(p) {
    if (p >= 10000) return p.toFixed(1);
    if (p >= 1000)  return p.toFixed(2);
    if (p >= 10)    return p.toFixed(3);
    return p.toFixed(4);
  }
  _fmtQty(q) {
    if (q >= 1000) return `${(q / 1000).toFixed(2)}K`;
    return q.toFixed(3);
  }
  _fmtTs(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  }
}
