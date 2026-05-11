/**
 * orderbook.js — Order Book Ladder + Depth Mountain Chart
 */

const BULL_COLOR = '#00e676';
const BEAR_COLOR = '#ff1744';

export class OrderBookManager {
  constructor() {
    this.bids = [];
    this.asks = [];
    this.maxRows = 12;
  }

  update({ bids, asks }) {
    this.bids = bids ?? [];
    this.asks = asks ?? [];
    this._render();
    this._updateImbalance();
  }

  _render() {
    const asksEl = document.getElementById('orderbook-asks');
    const bidsEl = document.getElementById('orderbook-bids');
    if (!asksEl || !bidsEl) return;

    // Asks: display top maxRows in reverse (lowest ask at bottom, nearest mid)
    const topAsks = this.asks.slice(0, this.maxRows);
    const maxAskQty = topAsks.reduce((m, r) => Math.max(m, r.qty), 0);
    // Show asks reversed so lowest ask is closest to spread
    const askRows = [...topAsks].reverse();
    asksEl.innerHTML = askRows.map((r, i) => this._rowHtml(r, 'ask', maxAskQty, i)).join('');

    // Bids: top maxRows, highest bid at top
    const topBids = this.bids.slice(0, this.maxRows);
    const maxBidQty = topBids.reduce((m, r) => Math.max(m, r.qty), 0);
    bidsEl.innerHTML = topBids.map((r, i) => this._rowHtml(r, 'bid', maxBidQty, i)).join('');

    // Spread display
    const spreadEl = document.getElementById('book-spread-val');
    if (spreadEl && this.bids[0] && this.asks[0]) {
      const spread = this.asks[0].price - this.bids[0].price;
      spreadEl.textContent = spread.toFixed(4);
    }
  }

  _rowHtml(level, side, maxQty, _idx) {
    const pct = maxQty > 0 ? (level.qty / maxQty * 100).toFixed(1) : '0';
    const cumQty = this._cumulativeQty(side, level.price);
    return `
      <div class="ob-row ${side}">
        <div class="ob-bar" style="width:${pct}%"></div>
        <span class="ob-price">${this._fmtPrice(level.price)}</span>
        <span class="ob-qty">${this._fmtQty(level.qty)}</span>
        <span class="ob-total">${this._fmtQty(cumQty)}</span>
      </div>`;
  }

  _cumulativeQty(side, targetPrice) {
    const arr = side === 'ask' ? this.asks : this.bids;
    let sum = 0;
    for (const l of arr) {
      if (side === 'ask' && l.price > targetPrice) break;
      if (side === 'bid' && l.price < targetPrice) break;
      sum += l.qty;
    }
    return sum;
  }

  _updateImbalance() {
    const bidVol = this.bids.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
    const askVol = this.asks.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
    const total = bidVol + askVol;
    const el = document.getElementById('book-imbalance');
    if (!el || total === 0) return;
    const ratio = bidVol / total;
    if (ratio > 0.6) {
      el.textContent = `BIDS ${(ratio * 100).toFixed(0)}%`;
      el.className = 'imbalance-badge bull';
    } else if (ratio < 0.4) {
      el.textContent = `ASKS ${((1 - ratio) * 100).toFixed(0)}%`;
      el.className = 'imbalance-badge bear';
    } else {
      el.textContent = 'BALANCED';
      el.className = 'imbalance-badge neutral';
    }
  }

  _fmtPrice(p) {
    if (p >= 1000) return p.toFixed(2);
    if (p >= 10)   return p.toFixed(3);
    return p.toFixed(4);
  }
  _fmtQty(q) {
    if (q >= 10000) return `${(q / 1000).toFixed(1)}K`;
    if (q >= 1000)  return `${(q / 1000).toFixed(2)}K`;
    return q.toFixed(2);
  }

  getImbalanceRatio() {
    const bidVol = this.bids.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
    const askVol = this.asks.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
    const total = bidVol + askVol;
    return total > 0 ? bidVol / total : 0.5;
  }
}

/* ── Depth Mountain Chart ────────────────────────────────────────────────── */
export class DepthChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas?.getContext('2d');
    this.bids = [];
    this.asks = [];
    this._ro = null;
    this._init();
  }

  _init() {
    if (!this.canvas) return;
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.canvas.parentElement);
    this._resize();
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    this.canvas.width  = parent.clientWidth  * window.devicePixelRatio;
    this.canvas.height = parent.clientHeight * window.devicePixelRatio;
    this.canvas.style.width  = `${parent.clientWidth}px`;
    this.canvas.style.height = `${parent.clientHeight}px`;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    this._draw();
  }

  update(bids, asks) {
    this.bids = bids ?? [];
    this.asks = asks ?? [];
    this._draw();
  }

  _draw() {
    const { ctx, canvas } = this;
    if (!ctx) return;
    const W = canvas.width  / window.devicePixelRatio;
    const H = canvas.height / window.devicePixelRatio;

    ctx.clearRect(0, 0, W, H);

    if (this.bids.length === 0 || this.asks.length === 0) {
      ctx.fillStyle = 'rgba(136,146,164,0.3)';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for depth…', W / 2, H / 2);
      return;
    }

    // Build cumulative sides
    const cumBids = this._cumulate([...this.bids].reverse()); // sorted lo→hi price
    const cumAsks = this._cumulate(this.asks);                // sorted lo→hi price

    const allPrices = [...cumBids.map(p => p.price), ...cumAsks.map(p => p.price)];
    const minP = Math.min(...allPrices);
    const maxP = Math.max(...allPrices);
    const maxVol = Math.max(
      ...cumBids.map(p => p.cumQty),
      ...cumAsks.map(p => p.cumQty),
    );

    const px = (price) => ((price - minP) / (maxP - minP)) * W;
    const py = (qty)   => H - (qty / maxVol) * H * 0.9;

    // Draw bids (left side, green mountain)
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (const p of cumBids) {
      ctx.lineTo(px(p.price), py(p.cumQty));
    }
    ctx.lineTo(px(cumBids[cumBids.length - 1]?.price ?? minP), H);
    ctx.closePath();
    const bidGrad = ctx.createLinearGradient(0, 0, 0, H);
    bidGrad.addColorStop(0, 'rgba(0,230,118,0.35)');
    bidGrad.addColorStop(1, 'rgba(0,230,118,0.04)');
    ctx.fillStyle = bidGrad;
    ctx.fill();
    ctx.beginPath();
    for (const p of cumBids) ctx.lineTo(px(p.price), py(p.cumQty));
    ctx.strokeStyle = 'rgba(0,230,118,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw asks (right side, red mountain)
    ctx.beginPath();
    ctx.moveTo(px(cumAsks[0]?.price ?? maxP), H);
    for (const p of cumAsks) {
      ctx.lineTo(px(p.price), py(p.cumQty));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    const askGrad = ctx.createLinearGradient(0, 0, 0, H);
    askGrad.addColorStop(0, 'rgba(255,23,68,0.35)');
    askGrad.addColorStop(1, 'rgba(255,23,68,0.04)');
    ctx.fillStyle = askGrad;
    ctx.fill();
    ctx.beginPath();
    for (const p of cumAsks) ctx.lineTo(px(p.price), py(p.cumQty));
    ctx.strokeStyle = 'rgba(255,23,68,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Mid price line
    if (this.bids[0] && this.asks[0]) {
      const mid = (this.bids[0].price + this.asks[0].price) / 2;
      const mx = px(mid);
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, H);
      ctx.strokeStyle = 'rgba(255,215,64,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _cumulate(levels) {
    let sum = 0;
    return levels.map((l) => {
      sum += l.qty;
      return { price: l.price, cumQty: sum };
    });
  }
}
