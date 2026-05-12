/**
 * orderbook.js — Mirrored order book ladder (per-level depth bars in-grid)
 */

import { aggregateAsks, aggregateBids, defaultTickChoices } from './book-aggregate.js';
import { getLtpDecimalPlaces } from './ltp-precision.js';

export class OrderBookManager {
  constructor() {
    this.bids = [];
    this.asks = [];
    this.maxRows = 28;
    this.markPrice = null;
    this.tick = 0.01;
    this.filterSide = 'all';
    this.amountMode = 'vol';
    this._precisionBound = false;
    this._wired = false;
    /** @type {(() => void) | null} */
    this._docCloseUnsub = null;
  }

  /** @returns {{ trigger: HTMLButtonElement; menu: HTMLElement; label: HTMLElement; wrap: HTMLElement } | null} */
  _precisionEls() {
    const trigger = document.getElementById('book-precision-trigger');
    const menu = document.getElementById('book-precision-menu');
    const label = document.getElementById('book-precision-label');
    const wrap = document.getElementById('book-precision-wrap');
    if (!trigger || !menu || !label || !wrap) return null;
    return { trigger, menu, label, wrap };
  }

  _syncPrecisionLabel() {
    const els = this._precisionEls();
    if (!els) return;
    for (const node of els.menu.querySelectorAll('[role="option"]')) {
      const v = Number(node.getAttribute('data-value'));
      if (Number.isFinite(v) && Math.abs(v - this.tick) < 1e-12) {
        els.label.textContent = node.textContent?.trim() ?? String(this.tick);
        return;
      }
    }
    els.label.textContent = String(this.tick);
  }

  _setOptionSelection() {
    const els = this._precisionEls();
    if (!els) return;
    els.menu.querySelectorAll('[role="option"]').forEach((node) => {
      const v = Number(node.getAttribute('data-value'));
      const on = Number.isFinite(v) && Math.abs(v - this.tick) < 1e-12;
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  _closePrecisionMenu() {
    const els = this._precisionEls();
    if (!els) return;
    els.menu.hidden = true;
    els.trigger.setAttribute('aria-expanded', 'false');
    if (this._docCloseUnsub) {
      this._docCloseUnsub();
      this._docCloseUnsub = null;
    }
  }

  _openPrecisionMenu() {
    const els = this._precisionEls();
    if (!els) return;
    els.menu.hidden = false;
    els.trigger.setAttribute('aria-expanded', 'true');
    this._setOptionSelection();
    if (this._docCloseUnsub) return;
    const onDoc = (e) => {
      if (!els.wrap.contains(e.target)) this._closePrecisionMenu();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') this._closePrecisionMenu();
    };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    this._docCloseUnsub = () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  /** Wire controls once the Live tab DOM exists. */
  init() {
    if (this._wired) return;
    const els = this._precisionEls();
    const root = document.getElementById('book-panel');
    if (!els || !root) return;
    this._wired = true;

    els.trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (els.menu.hidden) this._openPrecisionMenu();
      else this._closePrecisionMenu();
    });

    els.menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[role="option"]');
      if (!btn || !els.menu.contains(btn)) return;
      const v = Number(btn.getAttribute('data-value'));
      if (!Number.isFinite(v) || v <= 0) return;
      this.tick = v;
      this._syncPrecisionLabel();
      this._setOptionSelection();
      this._render();
      this._closePrecisionMenu();
    });

    root.querySelectorAll('[data-book-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-book-filter');
        if (!v) return;
        this.filterSide = v;
        root.querySelectorAll('[data-book-filter]').forEach((b) => b.classList.toggle('is-on', b === btn));
        this._render();
      });
    });

    root.querySelectorAll('[data-book-amt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-book-amt');
        if (!v) return;
        this.amountMode = v;
        root.querySelectorAll('[data-book-amt]').forEach((b) => b.classList.toggle('is-on', b === btn));
        this._render();
      });
    });
  }

  setMarkPrice(p) {
    if (p == null || !Number.isFinite(p)) return;
    this.markPrice = p;
    this._syncMarkDom();
  }

  update({ bids, asks }) {
    this.bids = bids ?? [];
    this.asks = asks ?? [];
    this._ensurePrecisionOptions();
    this._render();
    this._updateImbalance();
    this._syncMarkDom();
  }

  _midRef() {
    const b = this.bids[0];
    const a = this.asks[0];
    if (b && a) return (b.price + a.price) / 2;
    if (this.markPrice != null) return this.markPrice;
    if (b) return b.price;
    if (a) return a.price;
    return null;
  }

  _ensurePrecisionOptions() {
    const els = this._precisionEls();
    if (!els) return;
    const mid = this._midRef();
    if (mid == null) return;

    if (!this._precisionBound) {
      const choices = defaultTickChoices(mid);
      els.menu.innerHTML = choices
        .map(
          (c) =>
            `<button type="button" class="book-precision-option" role="option" data-value="${c.value}">${c.label}</button>`,
        )
        .join('');
      const hasCurrent = choices.some((c) => Math.abs(c.tick - this.tick) < 1e-12);
      if (!hasCurrent) {
        const nearest = choices.reduce((best, c) =>
          Math.abs(c.tick - 0.01) < Math.abs(best.tick - 0.01) ? c : best,
        choices[0]);
        this.tick = nearest.tick;
      }
      this._syncPrecisionLabel();
      this._setOptionSelection();
      this._precisionBound = true;
    }
  }

  _tickDecimals() {
    const t = this.tick;
    if (!Number.isFinite(t) || t <= 0) return 4;
    if (t >= 1) return 0;
    return Math.min(10, Math.max(0, Math.ceil(-Math.log10(t))));
  }

  _fmtPrice(p) {
    if (p == null || !Number.isFinite(p)) return '—';
    const fromTick = this._tickDecimals();
    const fromInst = getLtpDecimalPlaces();
    const d = Math.min(10, Math.max(fromTick, fromInst));
    return p.toFixed(d);
  }

  _fmtAmt(q) {
    if (q == null || !Number.isFinite(q)) return '—';
    return q.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  _syncMarkDom() {
    const valEl = document.getElementById('book-mark-val');
    const spreadEl = document.getElementById('book-spread-inline');
    if (valEl) {
      if (this.markPrice != null && Number.isFinite(this.markPrice)) {
        valEl.textContent = this._fmtPrice(this.markPrice);
        valEl.classList.remove('is-empty');
      } else if (this.bids[0] && this.asks[0]) {
        const mid = (this.bids[0].price + this.asks[0].price) / 2;
        valEl.textContent = this._fmtPrice(mid);
        valEl.classList.remove('is-empty');
      } else {
        valEl.textContent = '—';
        valEl.classList.add('is-empty');
      }
    }
    if (spreadEl && this.bids[0] && this.asks[0]) {
      const spread = this.asks[0].price - this.bids[0].price;
      spreadEl.textContent = ` · Spread ${spread.toFixed(this._tickDecimals())}`;
    } else if (spreadEl) {
      spreadEl.textContent = '';
    }
  }

  _render() {
    const body = document.getElementById('orderbook-mirrored');
    if (!body) return;

    const tick = this.tick;
    const aggB = aggregateBids(this.bids, tick);
    const aggA = aggregateAsks(this.asks, tick);
    const rows = Math.min(this.maxRows, Math.max(aggB.length, aggA.length));

    const bidVol = aggB.slice(0, rows).map((r) => r.qty);
    const askVol = aggA.slice(0, rows).map((r) => r.qty);
    const maxBid = bidVol.reduce((m, q) => Math.max(m, q), 0) || 1;
    const maxAsk = askVol.reduce((m, q) => Math.max(m, q), 0) || 1;

    let bidCum = 0;
    const bidCums = aggB.slice(0, rows).map((r) => {
      bidCum += r.qty;
      return bidCum;
    });
    let askCum = 0;
    const askCums = aggA.slice(0, rows).map((r) => {
      askCum += r.qty;
      return askCum;
    });
    const maxBidC = bidCums.reduce((m, q) => Math.max(m, q), 0) || 1;
    const maxAskC = askCums.reduce((m, q) => Math.max(m, q), 0) || 1;

    const parts = [];
    for (let i = 0; i < rows; i++) {
      const b = aggB[i];
      const a = aggA[i];
      const bidQty = b ? (this.amountMode === 'depth' ? bidCums[i] : b.qty) : null;
      const askQty = a ? (this.amountMode === 'depth' ? askCums[i] : a.qty) : null;
      const bidMax = this.amountMode === 'depth' ? maxBidC : maxBid;
      const askMax = this.amountMode === 'depth' ? maxAskC : maxAsk;

      const bidPct = b && bidQty != null ? Math.min(100, (bidQty / bidMax) * 100) : 0;
      const askPct = a && askQty != null ? Math.min(100, (askQty / askMax) * 100) : 0;

      const showBid = this.filterSide !== 'ask';
      const showAsk = this.filterSide !== 'bid';

      const bidAmt = b && showBid ? this._fmtAmt(bidQty) : '';
      const askAmt = a && showAsk ? this._fmtAmt(askQty) : '';
      const bidPrice = b && showBid ? this._fmtPrice(b.price) : '';
      const askPrice = a && showAsk ? this._fmtPrice(a.price) : '';

      parts.push(`
      <div class="ob-mir-row">
        <span class="ob-mir-amt bid ${showBid ? '' : 'is-muted'}">${bidAmt}</span>
        <div class="ob-mir-bar-cell bid ${showBid ? '' : 'is-muted'}">
          ${b && showBid ? `<div class="ob-mir-bar bid" style="width:${bidPct.toFixed(1)}%"></div>` : ''}
        </div>
        <span class="ob-mir-price bid ${showBid ? '' : 'is-muted'}">${bidPrice}</span>
        <span class="ob-mir-price ask ${showAsk ? '' : 'is-muted'}">${askPrice}</span>
        <div class="ob-mir-bar-cell ask ${showAsk ? '' : 'is-muted'}">
          ${a && showAsk ? `<div class="ob-mir-bar ask" style="width:${askPct.toFixed(1)}%"></div>` : ''}
        </div>
        <span class="ob-mir-amt ask ${showAsk ? '' : 'is-muted'}">${askAmt}</span>
      </div>`);
    }

    body.innerHTML = parts.join('') || '<div class="ob-mir-empty">Waiting for depth…</div>';
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

  getImbalanceRatio() {
    const bidVol = this.bids.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
    const askVol = this.asks.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
    const total = bidVol + askVol;
    return total > 0 ? bidVol / total : 0.5;
  }
}
