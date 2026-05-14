/**
 * microstructure.js — Live microstructure panel
 *
 * Renders data from the `microstructure` WS message (snapshotMicrostructure output):
 *   tfi1s / tfi5s / tfi30s  — Trade Flow Imbalance (buy-sell signed vol)
 *   weightedObi5 / 10       — Distance-weighted OBI [-1,+1]
 *   depthPressure10         — Signed depth pressure
 *   spread / spreadBps      — Bid-ask spread
 *   rv1s / rv5s / rv1m      — Rolling realized volatility
 *   bookThinning            — Change in total book volume
 *   cancelIntensity         — Level removals per second
 *   microprice              — Volume-weighted fair mid
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sign = (v) => (v > 0 ? '+' : '');
const fmtVol = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign(v)}${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign(v)}${(v / 1_000).toFixed(1)}K`;
  return `${sign(v)}${v.toFixed(1)}`;
};
const fmtPct = (v, dp = 3) =>
  Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—';

export class MicrostructurePanel {
  constructor() {
    /** Latest snapshot from server */
    this._snap = null;
    /** Smoothed OBI for gauge  (0–1) */
    this._obiRatio = 0.5;
    this._obiTarget = 0.5;
    this._obiRaf = null;
    this._animateObi = this._animateObi.bind(this);

    /** Wall scores computed from latest depth (populated by orderbook manager) */
    this._wallScores = { bid: [], ask: [] }; // [{price, score}]
  }

  /** Called from main.js dispatch on `microstructure` WS message */
  update(snap) {
    this._snap = snap;
    this._render();
    
    // ── Calculate Overall Verdict ──
    let score = 0;
    if (snap.tfi30s && snap.tfi30s.net > 0) score += 1;
    else if (snap.tfi30s && snap.tfi30s.net < 0) score -= 1;
    
    const obiWeighted = snap.weightedObi10 ? snap.weightedObi10.weightedObi : 0;
    if (obiWeighted > 0.1) score += 1.5;
    else if (obiWeighted < -0.1) score -= 1.5;

    if (snap.depthPressure && snap.depthPressure.depthPressure > 0) score += 1;
    else if (snap.depthPressure && snap.depthPressure.depthPressure < 0) score -= 1;

    let verdict = 'NEUTRAL';
    let vClass = 'neutral';
    if (score >= 2.5) { verdict = 'STRONG BULL'; vClass = 'bull'; }
    else if (score > 0.5) { verdict = 'MILD BULL'; vClass = 'bull'; }
    else if (score <= -2.5) { verdict = 'STRONG BEAR'; vClass = 'bear'; }
    else if (score < -0.5) { verdict = 'MILD BEAR'; vClass = 'bear'; }

    const badge = document.getElementById('ms-verdict-badge');
    if (badge) {
      badge.textContent = verdict;
      badge.className = `ms-obi-badge ${vClass}`;
      if (vClass === 'bull') {
        badge.style.background = 'var(--bull-dim)';
        badge.style.color = 'var(--bull)';
        badge.style.border = '1px solid var(--bull-glow)';
      } else if (vClass === 'bear') {
        badge.style.background = 'var(--bear-dim)';
        badge.style.color = 'var(--bear)';
        badge.style.border = '1px solid var(--bear-glow)';
      } else {
        badge.style.background = 'rgba(255,255,255,0.06)';
        badge.style.color = 'var(--text-dim)';
        badge.style.border = 'none';
      }
    }

    // Update OBI gauge smoothly
    const obi = snap?.weightedObi10?.weightedObi ?? snap?.weightedObi5?.weightedObi ?? 0;
    // Map [-1,+1] → [0,1]
    this._obiTarget = clamp((obi + 1) / 2, 0, 1);
    if (this._obiRaf === null) this._obiRaf = requestAnimationFrame(this._animateObi);
  }

  /** Returns smoothed OBI ratio (0–1) for the sentinel gauge canvas */
  getObiRatio() { return this._obiRatio; }

  /** Feed wall scores from orderbook.js for row highlighting */
  setWallScores(walls) { this._wallScores = walls; }

  _animateObi() {
    this._obiRaf = null;
    const diff = this._obiTarget - this._obiRatio;
    if (Math.abs(diff) > 0.001) {
      this._obiRatio += diff * 0.1;
      this._obiRaf = requestAnimationFrame(this._animateObi);
    } else {
      this._obiRatio = this._obiTarget;
    }
  }

  _render() {
    const s = this._snap;
    if (!s) return;

    // ── TFI bar (30s window) ─────────────────────────────────────────────
    this._renderTfi('ms-tfi-30', s.tfi30s, 30);
    this._renderTfi('ms-tfi-5',  s.tfi5s,  5);

    // ── OBI ─────────────────────────────────────────────────────────────
    this._renderObi('ms-obi', s.weightedObi10);

    // ── Depth Pressure ───────────────────────────────────────────────────
    this._renderPressure('ms-pressure', s.depthPressure10);

    // ── Spread ──────────────────────────────────────────────────────────
    this._renderSpread('ms-spread', s.spread, s.spreadBps);

    // ── Realized Vol ─────────────────────────────────────────────────────
    this._renderRV('ms-rv', s.rv1m, s.rv5s, s.rv1s);

    // ── Cancel + Book Thinning ───────────────────────────────────────────
    this._renderDepthHealth('ms-cancel', 'ms-thinning', s.cancelIntensity ?? 0, s.bookThinning ?? 0);

    // ── Microprice deviation ─────────────────────────────────────────────
    this._renderMicroprice('ms-microprice', s.microprice, s.mid);
  }

  _renderTfi(id, tfi, windowSec) {
    const el = document.getElementById(id);
    if (!el || !tfi) return;
    const { tfi: net, buyVol, sellVol } = tfi;
    const total = buyVol + sellVol || 1;
    const buyPct = (buyVol / total) * 100;
    const sellPct = (sellVol / total) * 100;
    const bull = net >= 0;

    el.innerHTML = `
      <div class="ms-tfi-labels">
        <span class="ms-tfi-buy mono-sm">${fmtVol(buyVol)}</span>
        <span class="ms-tfi-net ${bull ? 'bull' : 'bear'} mono-sm">${fmtVol(net)}</span>
        <span class="ms-tfi-sell mono-sm">${fmtVol(sellVol)}</span>
      </div>
      <div class="ms-tfi-bar-wrap">
        <div class="ms-tfi-bar-fill buy" style="width:${buyPct.toFixed(1)}%"></div>
        <div class="ms-tfi-bar-fill sell" style="width:${sellPct.toFixed(1)}%;margin-left:auto"></div>
      </div>`;
  }

  _renderObi(id, obi) {
    const el = document.getElementById(id);
    if (!el || !obi) return;
    const v = obi.weightedObi ?? 0; // [-1,+1]
    const pct = ((v + 1) / 2) * 100; // [0,100]
    const bull = v >= 0;
    el.innerHTML = `
      <div class="ms-obi-value ${bull ? 'bull' : 'bear'} mono-sm">${v >= 0 ? '+' : ''}${v.toFixed(3)}</div>
      <div class="ms-obi-bar-wrap">
        <div class="ms-obi-bar-fill" style="left:${v >= 0 ? 50 : pct}%;width:${Math.abs(v) * 50}%;background:${bull ? 'var(--bull)' : 'var(--bear)'}"></div>
        <div class="ms-obi-center-tick"></div>
      </div>`;
  }

  _renderPressure(id, dp) {
    const el = document.getElementById(id);
    if (!el || !dp) return;
    const { depthPressure, bidPressure, askPressure } = dp;
    const total = bidPressure + askPressure || 1;
    const bidPct = (bidPressure / total) * 100;
    const bull = depthPressure >= 0;
    el.innerHTML = `
      <div class="ms-pressure-label ${bull ? 'bull' : 'bear'} mono-sm">${bull ? '▲ BID' : '▼ ASK'}</div>
      <div class="ms-pressure-bar-wrap">
        <div class="ms-pressure-fill bid" style="width:${bidPct.toFixed(1)}%"></div>
        <div class="ms-pressure-fill ask" style="width:${(100 - bidPct).toFixed(1)}%;margin-left:auto"></div>
      </div>`;
  }

  _renderSpread(id, spread, spreadBps) {
    const el = document.getElementById(id);
    if (!el) return;
    const bps = spreadBps ?? 0;
    // Wide = >2 bps, normal = 0.5–2, tight = <0.5
    const cls = bps > 2 ? 'bear' : bps > 0.5 ? 'neutral' : 'bull';
    const label = bps > 2 ? 'WIDE' : bps > 0.5 ? 'NORMAL' : 'TIGHT';
    el.innerHTML = `
      <span class="ms-spread-val mono-sm">${Number.isFinite(spread) ? spread.toFixed(3) : '—'}</span>
      <span class="ms-spread-bps ${cls} mono-sm">${bps.toFixed(2)} bps</span>
      <span class="ms-spread-badge ${cls}">${label}</span>`;
  }

  _renderRV(id, rv1m, rv5s, rv1s) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = rv1m?.rv ?? 0;
    // Heat: low <0.005, med 0.005–0.02, high >0.02
    const cls = v > 0.02 ? 'rv-high' : v > 0.005 ? 'rv-med' : 'rv-low';
    const label = v > 0.02 ? 'HIGH' : v > 0.005 ? 'MED' : 'LOW';
    const bars = [rv1s?.rv ?? 0, rv5s?.rv ?? 0, rv1m?.rv ?? 0];
    const maxBar = Math.max(...bars, 0.001);
    const barHtml = bars.map((b, i) => {
      const pct = (b / maxBar) * 100;
      const labels = ['1s', '5s', '1m'];
      return `<div class="ms-rv-bar-item">
        <div class="ms-rv-bar-fill ${cls}" style="height:${pct.toFixed(1)}%"></div>
        <div class="ms-rv-bar-lbl">${labels[i]}</div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="ms-rv-bars">${barHtml}</div>
      <div class="ms-rv-right">
        <div class="ms-rv-badge ${cls}">${label}</div>
        <div class="ms-rv-val mono-sm">${fmtPct(v)}</div>
      </div>`;
  }

  _renderDepthHealth(cancelId, thinId, cancelIntensity, bookThinning) {
    const cancelEl = document.getElementById(cancelId);
    const thinEl   = document.getElementById(thinId);
    if (cancelEl) {
      const cls = cancelIntensity > 3 ? 'bear' : cancelIntensity > 1 ? 'neutral' : 'bull';
      cancelEl.innerHTML = `<span class="ms-stat-val ${cls} mono-sm">${cancelIntensity.toFixed(1)}/s</span>`;
    }
    if (thinEl) {
      const pct = (bookThinning * 100);
      const cls = pct < -5 ? 'bear' : pct > 5 ? 'bull' : 'neutral';
      thinEl.innerHTML = `<span class="ms-stat-val ${cls} mono-sm">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
    }
  }

  _renderMicroprice(id, microprice, mid) {
    const el = document.getElementById(id);
    if (!el || !Number.isFinite(microprice) || !Number.isFinite(mid)) return;
    const diff = microprice - mid;
    const cls = diff > 0 ? 'bull' : diff < 0 ? 'bear' : 'neutral';
    el.innerHTML = `<span class="ms-stat-val ${cls} mono-sm">${diff >= 0 ? '+' : ''}${diff.toFixed(4)}</span>`;
  }
}
