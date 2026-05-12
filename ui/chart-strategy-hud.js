/**
 * Compact strategy readout drawn over the price chart (pointer-events: none).
 */

import { computeSignalVerdict, DIR_CLASS, DIR_LABEL, fmtSignalPrice } from './signals.js';

export const SIGNAL_HUD_STORAGE_KEY = 'qt_signal_hud';

export const readSignalHudEnabled = () => {
  try {
    return localStorage.getItem(SIGNAL_HUD_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export const storeSignalHudEnabled = (on) => {
  try {
    localStorage.setItem(SIGNAL_HUD_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

const escapeHtml = (s) => {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const matrixGlyph = (dir) => {
  if (dir === 'LONG') return '▲';
  if (dir === 'SHORT') return '▼';
  return '—';
}

export const renderStrategyHud = (container, signals) => {
  if (!container) return;
  if (!signals) {
    container.hidden = true;
    container.textContent = '';
    return;
  }

  const meta = signals.signalMeta ?? {};
  const htfTf = meta.htf ?? '—';
  const trendTf = meta.trendSeriesTf ?? '—';
  const verdict = computeSignalVerdict(signals);
  const confPct = ((signals.ltfConfidence ?? 0) * 100).toFixed(1);
  const score = signals.ltfScore ?? 0;
  const refTf = signals.refPriceTf ?? '—';
  const refP =
    signals.refPrice != null && Number.isFinite(signals.refPrice) ? fmtSignalPrice(signals.refPrice) : '—';

  const smc = signals.smc;
  let smcBlock = 'SMC —';
  if (smc) {
    const obTxt = smc.orderBlock
      ? `${smc.orderBlock.type} ${fmtSignalPrice(smc.orderBlock.low)}–${fmtSignalPrice(smc.orderBlock.high)}`
      : '—';
    const fvgTxt = smc.fvg ? `${smc.fvg.type} FVG` : '—';
    const liq = smc.liquidity;
    const pr = liq?.primaryRejection;
    const book = smc.liquidityOrderBook;
    const ix = smc.sweepCandleIndex;
    const liqBit =
      liq && typeof liq === 'object'
        ? ` · LQ ${String(liq.classification ?? '—')} (${liq.sweepQualityScore ?? 0})${
            pr && pr.raidDirection
              ? ` · raid${pr.raidDirection === 'UP' ? '↑' : '↓'} ${String(pr.liquidityBias ?? '')}`
              : ''
          }${ix != null && Number.isFinite(ix) ? ` · bar#${ix}` : ''}${
            book && Number.isFinite(book.imbalance)
              ? ` · depthΔ ${(Number(book.imbalance) * 100).toFixed(0)}%`
              : ''
          }`
        : '';
    smcBlock = `Score ${smc.score}/5 · Sweep ${smc.liquiditySweep ?? '—'}${liqBit} · OB ${obTxt} · ${fvgTxt} · BOS ${DIR_LABEL[smc.bos] ?? smc.bos} · CH ${DIR_LABEL[smc.choch] ?? smc.choch}`;
  }

  const mtf = signals.solMtf;
  let mtfLine = 'MTF —';
  if (mtf) {
    const dirTxt = escapeHtml(DIR_LABEL[mtf.direction] ?? String(mtf.direction));
    const rs = (mtf.reasons ?? []).slice(0, 5).map((r) => escapeHtml(r)).join(' ');
    mtfLine = `${dirTxt} ${mtf.pass ? '✓ PASS' : '✗ FAIL'}${rs ? ` · ${rs}` : ''}`;
  }

  const ls = signals.ltfSignals;
  let matLine = 'Matrix —';
  if (ls) {
    const v = (x) => (x ? '✓' : '✗');
    matLine = `EMA${matrixGlyph(ls.ema)} MACD${matrixGlyph(ls.macd)} RSI${matrixGlyph(ls.rsi)} ST${matrixGlyph(ls.supertrend)} STR${matrixGlyph(ls.structure)} VOL${v(ls.volume)}`;
  }

  container.hidden = false;
  container.className = `chart-signal-hud chart-signal-hud--${verdict.cls}`;

  const htfCls = DIR_CLASS[signals.htfBias] ?? 'neutral';
  const ltfCls = DIR_CLASS[signals.ltfDirection] ?? 'neutral';

  container.innerHTML = `
    <div class="chart-signal-hud-verdict">${escapeHtml(verdict.text)}</div>
    <div class="chart-signal-hud-row">
      <span class="chart-signal-hud-k">HTF ${escapeHtml(String(htfTf))}</span>
      <span class="chart-signal-hud-tag chart-signal-hud-tag--${htfCls}">${escapeHtml(DIR_LABEL[signals.htfBias] ?? String(signals.htfBias))}</span>
      <span class="chart-signal-hud-sep">·</span>
      <span class="chart-signal-hud-k">Tr ${escapeHtml(String(trendTf))}</span>
      <span class="chart-signal-hud-tag chart-signal-hud-tag--${ltfCls}">${escapeHtml(DIR_LABEL[signals.ltfDirection] ?? String(signals.ltfDirection))}</span>
    </div>
    <div class="chart-signal-hud-row chart-signal-hud-row--dense">
      <span class="chart-signal-hud-k">Conf</span> <span class="chart-signal-hud-val">${escapeHtml(confPct)}%</span>
      <span class="chart-signal-hud-k">(${escapeHtml(String(score))}/5)</span>
      <span class="chart-signal-hud-sep">·</span>
      <span class="chart-signal-hud-k">Ref</span> <span class="chart-signal-hud-val">${escapeHtml(String(refTf))} @ ${escapeHtml(refP)}</span>
    </div>
    <div class="chart-signal-hud-smc">${escapeHtml(smcBlock)}</div>
    <div class="chart-signal-hud-mtf">${mtfLine}</div>
    <div class="chart-signal-hud-matrix mono-sm">${escapeHtml(matLine)}</div>
  `.trim();
}
