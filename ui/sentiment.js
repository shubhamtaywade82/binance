/**
 * sentiment.js — Market Sentiment horizontal bar + VWAP display
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

  /** Redraw after the bar becomes visible (tab switch). */
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
    // Let CSS width: 100% dictate the layout width, so it respects parent padding.
    canvas.style.width = '100%';
    const W = Math.max(1, canvas.clientWidth);
    const H = 38;
    
    // Set internal resolution
    canvas.width = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);

    ctx.clearRect(0, 0, W, H);

    const padX = 6;
    const barH = 16;
    const y = (H - barH) / 2;
    const barW = W - 2 * padX;
    const rad = Math.min(7, barH / 2);
    const centerX = padX + barW / 2;
    const markerX = padX + this.ratio * barW;

    const trackPath = () => {
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(padX, y, barW, barH, rad);
      } else {
        ctx.rect(padX, y, barW, barH);
      }
    };

    trackPath();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();

    /** Clip to a horizontal segment [x0, x1] inside the bar (for center-out fill). */
    const clipSegment = (x0, x1) => {
      const left = Math.min(x0, x1);
      const w = Math.max(0, Math.abs(x1 - x0));
      ctx.beginPath();
      ctx.rect(left, y, w, barH);
    };

    if (markerX > centerX + 0.5) {
      ctx.save();
      trackPath();
      ctx.clip();
      clipSegment(centerX, markerX);
      ctx.clip();
      const grad = ctx.createLinearGradient(centerX, 0, padX + barW, 0);
      grad.addColorStop(0, 'rgba(255,215,64,0.85)');
      grad.addColorStop(1, '#00e676');
      ctx.fillStyle = grad;
      ctx.fillRect(centerX, y, markerX - centerX, barH);
      ctx.restore();
    } else if (markerX < centerX - 0.5) {
      ctx.save();
      trackPath();
      ctx.clip();
      clipSegment(markerX, centerX);
      ctx.clip();
      const grad = ctx.createLinearGradient(padX, 0, centerX, 0);
      grad.addColorStop(0, '#ff1744');
      grad.addColorStop(1, 'rgba(255,215,64,0.85)');
      ctx.fillStyle = grad;
      ctx.fillRect(markerX, y, centerX - markerX, barH);
      ctx.restore();
    }

    // Neutral axis at center (matches "0" row above bar)
    ctx.beginPath();
    ctx.moveTo(centerX, y - 2);
    ctx.lineTo(centerX, y + barH + 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(markerX, y - 2);
    ctx.lineTo(markerX, y + barH + 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Skew from 50/50: −100 … +100 (bid-notional share vs top-of-book depth)
    const skewPts = Math.round((this.ratio - 0.5) * 200);
    const pctEl = document.getElementById('sentiment-pct');
    if (pctEl) {
      pctEl.textContent = skewPts === 0 ? '0' : skewPts > 0 ? `+${skewPts}` : String(skewPts);
      pctEl.setAttribute('title', 'Bid-share skew vs 50/50 (notional, top 10 bid vs ask levels)');
    }

    const labelEl = document.getElementById('sentiment-label');
    if (labelEl) {
      if (skewPts > 30) {
        labelEl.textContent = 'Bullish';
        labelEl.className = 'sentiment-txt bull';
      } else if (skewPts < -30) {
        labelEl.textContent = 'Bearish';
        labelEl.className = 'sentiment-txt bear';
      } else {
        labelEl.textContent = 'Neutral';
        labelEl.className = 'sentiment-txt neutral';
      }
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
