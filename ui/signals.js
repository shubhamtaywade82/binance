/**
 * signals.js — Strategy Signals Panel
 * Renders: HTF bias, LTF trend, SMC analysis, MTF stack, trend matrix
 */

const DIR_CLASS = { LONG: 'bull', SHORT: 'bear', BULLISH: 'bull', BEARISH: 'bear', NONE: 'neutral' };
const DIR_LABEL = { LONG: '▲ LONG', SHORT: '▼ SHORT', BULLISH: '▲ BULL', BEARISH: '▼ BEAR', NONE: '— NONE' };

export class SignalsPanel {
  constructor() {
    this.lastSignals = null;
  }

  update(signals) {
    this.lastSignals = signals;
    this._render(signals);
  }

  _render(s) {
    if (!s) return;

    // HTF Bias
    this._setVal('sig-htf', s.htfBias, DIR_LABEL[s.htfBias] ?? s.htfBias, DIR_CLASS[s.htfBias] ?? 'neutral');
    // LTF
    this._setVal('sig-ltf', s.ltfDirection, DIR_LABEL[s.ltfDirection] ?? s.ltfDirection, DIR_CLASS[s.ltfDirection] ?? 'neutral');
    // Confidence
    const confPct = ((s.ltfConfidence ?? 0) * 100).toFixed(1);
    const confEl = document.getElementById('sig-conf');
    if (confEl) {
      confEl.textContent = `${confPct}% (${s.ltfScore ?? 0}/5)`;
      confEl.className = 'sig-value ' + (s.ltfConfidence >= 0.65 ? 'bull' : s.ltfConfidence >= 0.45 ? 'neutral' : 'bear');
    }

    const refTfEl = document.getElementById('sig-ref-tf');
    if (refTfEl) {
      const tf = s.refPriceTf ?? '—';
      const rp = s.refPrice != null && Number.isFinite(s.refPrice) ? this._fmtPrice(s.refPrice) : '—';
      refTfEl.textContent = `${tf} @ ${rp}`;
    }

    // SMC
    const smc = s.smc;
    if (smc) {
      const scoreEl = document.getElementById('sig-smc-score');
      if (scoreEl) {
        scoreEl.textContent = `${smc.score}/5`;
        scoreEl.className = 'sig-value ' + (smc.score >= 3 ? 'bull' : smc.score >= 1 ? 'neutral' : 'bear');
      }
      this._setVal('sig-sweep', null, smc.liquiditySweep ?? '—', smc.liquiditySweep !== 'NONE' ? 'bull' : 'neutral');
      this._setVal('sig-ob', null,
        smc.orderBlock ? `${smc.orderBlock.type} @ ${this._fmtPrice(smc.orderBlock.low)}–${this._fmtPrice(smc.orderBlock.high)}` : '—',
        smc.orderBlock ? DIR_CLASS[smc.orderBlock.type] : 'neutral');
      this._setVal('sig-fvg', null,
        smc.fvg ? `${smc.fvg.type} FVG` : '—',
        smc.fvg ? DIR_CLASS[smc.fvg.type] : 'neutral');
      this._setVal('sig-bos', null, DIR_LABEL[smc.bos] ?? '—', DIR_CLASS[smc.bos] ?? 'neutral');
      this._setVal('sig-choch', null, DIR_LABEL[smc.choch] ?? '—', DIR_CLASS[smc.choch] ?? 'neutral');
    }

    // MTF
    const mtf = s.solMtf;
    if (mtf) {
      this._setVal('sig-mtf-dir', null, DIR_LABEL[mtf.direction] ?? mtf.direction, DIR_CLASS[mtf.direction] ?? 'neutral');
      this._setVal('sig-mtf-pass', null, mtf.pass ? '✓ PASS' : '✗ FAIL', mtf.pass ? 'bull' : 'bear');
      const rEl = document.getElementById('sig-mtf-reasons');
      if (rEl && mtf.reasons) {
        rEl.innerHTML = mtf.reasons.map((r) => {
          const fail = r.includes('fail') || r.includes('weak') || r.includes('mismatch') || r.includes('insufficient');
          return `<span class="reason-tag${fail ? ' fail' : ''}">${r}</span>`;
        }).join('');
      }
    } else {
      this._setVal('sig-mtf-dir', null, '—', 'neutral');
      this._setVal('sig-mtf-pass', null, '—', 'neutral');
    }

    // Trend Matrix
    const signals = s.ltfSignals;
    if (signals) {
      this._setMatrix('mat-ema',    signals.ema,       DIR_CLASS[signals.ema]    ?? 'neutral');
      this._setMatrix('mat-macd',   signals.macd,      DIR_CLASS[signals.macd]   ?? 'neutral');
      this._setMatrix('mat-rsi',    signals.rsi,       DIR_CLASS[signals.rsi]    ?? 'neutral');
      this._setMatrix('mat-st',     signals.supertrend,DIR_CLASS[signals.supertrend] ?? 'neutral');
      this._setMatrix('mat-struct', signals.structure, DIR_CLASS[signals.structure]  ?? 'neutral');
      this._setMatrix('mat-vol',    signals.volume ? 'LONG' : 'SHORT',
        signals.volume ? 'bull' : 'bear', signals.volume ? '✓' : '✗');
    }

    // Overall verdict
    const verdict = this._computeVerdict(s);
    const vEl = document.getElementById('signal-verdict');
    if (vEl) {
      vEl.textContent = verdict.text;
      vEl.className = `verdict-badge ${verdict.cls}`;
    }
  }

  _computeVerdict(s) {
    if (!s) return { text: 'NEUTRAL', cls: 'neutral' };
    const htf  = s.htfBias;
    const ltf  = s.ltfDirection;
    const conf = s.ltfConfidence ?? 0;
    const pass = s.solMtf?.pass;

    if (pass) return { text: `MTF ${s.solMtf.direction}`, cls: DIR_CLASS[s.solMtf.direction] ?? 'neutral' };
    if (htf === ltf && htf !== 'NONE' && conf >= 0.6) {
      return { text: `${htf} SIGNAL`, cls: DIR_CLASS[htf] };
    }
    if (htf !== 'NONE' && htf === ltf) return { text: `WATCH ${htf}`, cls: DIR_CLASS[htf] };
    return { text: 'NEUTRAL', cls: 'neutral' };
  }

  _setVal(id, _key, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `sig-value ${cls}`;
  }

  _setMatrix(id, dir, cls, overrideText) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `matrix-item ${cls}`;
    const valEl = el.querySelector('.mat-val');
    if (valEl) valEl.textContent = overrideText ?? (dir === 'LONG' ? '▲' : dir === 'SHORT' ? '▼' : '—');
  }

  _fmtPrice(p) {
    if (!p) return '—';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 10)   return p.toFixed(3);
    return p.toFixed(4);
  }
}
