/**
 * sentiment.js — Market Sentiment Gauge + VWAP display
 */

import { fmtLtpDisplay } from './ltp-precision.js';

export class SentimentGauge {
  constructor() {
    this.canvas  = document.getElementById('sentiment-gauge');
    this.ctx     = this.canvas?.getContext('2d');
    this.ratio   = 0.5; // 0 = full bear, 1 = full bull
    this.target  = 0.5;
    this.raf     = null;
    this._animate = this._animate.bind(this);
    if (this.canvas) this._start();
  }

  /**
   * Update with bid-ask imbalance ratio (0–1).
   * Can also call with aggTrade pressure.
   */
  update(bidRatio) {
    this.target = Math.max(0, Math.min(1, bidRatio));
    if (this.raf === null) this._start();
  }

  /** Redraw after the gauge becomes visible (tab switch). */
  redraw() {
    this._draw();
  }

  updateVwap(vwap, vol) {
    const vwapEl = document.getElementById('vwap-val');
    const volEl = document.getElementById('vol-val');
    if (vwapEl) {
      vwapEl.textContent =
        vwap != null && Number.isFinite(vwap) ? this._fmtPrice(vwap) : '—';
    }
    if (volEl) {
      volEl.textContent =
        vol != null && Number.isFinite(vol) && vol >= 0 ? this._fmtQty(vol) : '—';
    }
  }

  _start() {
    this.raf = requestAnimationFrame(this._animate);
  }

  _animate() {
    // Smooth interpolation toward target
    const diff = this.target - this.ratio;
    if (Math.abs(diff) > 0.001) {
      this.ratio += diff * 0.08;
      this._draw();
      this.raf = requestAnimationFrame(this._animate);
    } else {
      this.ratio = this.target;
      this._draw();
      this.raf = null;
    }
  }

  _draw() {
    const { ctx, canvas } = this;
    if (!ctx || !canvas) return;
    const parent = canvas.parentElement;
    const W = Math.max(1, parent.clientWidth);
    /** Logical height — must fit arc + thick stroke (center sits just below canvas so the upper semicircle is in view). */
    const H = 100;
    canvas.width  = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
    canvas.style.width  = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(devicePixelRatio, devicePixelRatio);

    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const lineWidth = 18;
    const r = Math.min(W * 0.42, 78);
    /** Pivot below the bottom edge so π→2π is the upper semicircle; tuned so y_top − lineWidth/2 ≥ ~8px. */
    const cy = H + 16;
    const startAngle = Math.PI;
    const endAngle   = 2 * Math.PI;

    // Background arc (dark)
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Gradient arc (bear → bull)
    const grad = ctx.createLinearGradient(0, cy, W, cy);
    grad.addColorStop(0, '#ff1744');
    grad.addColorStop(0.5, 'rgba(255,215,64,0.6)');
    grad.addColorStop(1, '#00e676');

    const fillEnd = startAngle + (this.ratio * Math.PI);
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, fillEnd);
    ctx.strokeStyle = grad;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Needle
    const needleAngle = startAngle + this.ratio * Math.PI;
    const nx = cx + (r) * Math.cos(needleAngle);
    const ny = cy + (r) * Math.sin(needleAngle);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    // Pct display
    const pct = Math.round(this.ratio * 100);
    const pctEl = document.getElementById('sentiment-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;

    // Label
    const labelEl = document.getElementById('sentiment-label');
    if (labelEl) {
      if (this.ratio > 0.65) { labelEl.textContent = 'Bullish'; labelEl.className = 'sentiment-txt bull'; }
      else if (this.ratio < 0.35) { labelEl.textContent = 'Bearish'; labelEl.className = 'sentiment-txt bear'; }
      else { labelEl.textContent = 'Neutral'; labelEl.className = 'sentiment-txt neutral'; }
    }
  }

  _fmtPrice(p) {
    if (p == null || !Number.isFinite(p)) return '—';
    return fmtLtpDisplay(p);
  }
  _fmtQty(q) {
    if (q >= 1000) return `${(q / 1000).toFixed(2)}K`;
    return q.toFixed(3);
  }
}
