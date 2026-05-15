// Lightweight script editor UI. Renders into a host element that lives in the
// Scripts tab of the right sidebar. Uses a plain <textarea> + a gutter <div> for
// line numbers; no Monaco yet (Phase 2 swap behind this API).

import { tokenize, parse } from '@coindcx/indicator-runtime';

export class ScriptEditor {
  /**
   * @param {HTMLElement} root
   * @param {import('./script-manager.js').ScriptManager} manager
   */
  constructor(root, manager) {
    this.root = root;
    this.manager = manager;
    this.activeId = null;

    this.root.classList.add('nanopine-panel');
    this.root.innerHTML = `
      <div class="nanopine-toolbar">
        <button class="nanopine-btn" data-act="new">+ New</button>
        <button class="nanopine-btn" data-act="ai" data-role="ai-btn" title="Generate a script from a natural-language description" hidden>Ask AI</button>
        <button class="nanopine-btn" data-act="export-ts" data-role="ts-btn" title="Download this strategy as a TypeScript stub for live trading" hidden>Export TS</button>
        <button class="nanopine-btn" data-act="sweep" data-role="sweep-btn" title="Run a parameter sweep over int/float inputs" hidden>Sweep</button>
        <button class="nanopine-btn" data-act="walk-forward" data-role="wf-btn" title="Rolling train/test backtest: sweep params on a train window, evaluate the winner on the next test window" hidden>Walk-forward</button>
        <button class="nanopine-btn" data-act="export" title="Download all scripts as JSON">Export</button>
        <button class="nanopine-btn" data-act="import" title="Append scripts from a JSON file">Import</button>
        <input type="file" data-role="import-input" accept="application/json,.json" hidden />
        <span class="nanopine-status" data-role="status"></span>
      </div>
      <div class="nanopine-list" data-role="list"></div>
      <div class="nanopine-editor" data-role="editor-wrap">
        <input class="nanopine-name" data-role="name" placeholder="Script name" />
        <div class="nanopine-edit-row">
          <div class="nanopine-gutter" data-role="gutter"></div>
          <textarea class="nanopine-textarea" data-role="textarea" spellcheck="false"></textarea>
        </div>
        <div class="nanopine-inputs" data-role="inputs"></div>
        <div class="nanopine-actions">
          <button class="nanopine-btn primary" data-act="apply">Apply (Ctrl+Enter)</button>
          <button class="nanopine-btn" data-act="duplicate">Duplicate</button>
          <button class="nanopine-btn danger" data-act="delete">Delete</button>
        </div>
        <div class="nanopine-error" data-role="error"></div>
        <div class="nanopine-stats" data-role="stats" hidden></div>
        <div class="nanopine-alerts" data-role="alerts" hidden>
          <div class="nanopine-alerts-head">
            <strong>Alerts</strong>
            <button class="nanopine-btn" data-act="clear-alerts" title="Clear alert log">Clear</button>
          </div>
          <div class="nanopine-alerts-list" data-role="alerts-list"></div>
        </div>
      </div>
    `;

    this.elList = this.root.querySelector('[data-role="list"]');
    this.elName = this.root.querySelector('[data-role="name"]');
    this.elTextarea = this.root.querySelector('[data-role="textarea"]');
    this.elGutter = this.root.querySelector('[data-role="gutter"]');
    this.elInputs = this.root.querySelector('[data-role="inputs"]');
    this.elError = this.root.querySelector('[data-role="error"]');
    this.elStatus = this.root.querySelector('[data-role="status"]');
    this.elAlerts = this.root.querySelector('[data-role="alerts"]');
    this.elAlertsList = this.root.querySelector('[data-role="alerts-list"]');
    this.elStats = this.root.querySelector('[data-role="stats"]');

    this.elAiBtn = this.root.querySelector('[data-role="ai-btn"]');
    this.elTsBtn = this.root.querySelector('[data-role="ts-btn"]');
    this.elSweepBtn = this.root.querySelector('[data-role="sweep-btn"]');
    this.elWalkForwardBtn = this.root.querySelector('[data-role="wf-btn"]');

    this._bindEvents();
    this._refreshList();
    this._refreshAlerts();
    this._refreshStats();
    this._probeCapabilities();

    manager.addEventListener('change', () => this._refreshList());
    manager.addEventListener('status', (ev) => this._renderStatus(ev.detail));
    manager.addEventListener('alert', () => this._refreshAlerts());
    manager.addEventListener('stats', (ev) => {
      if (!this.activeId || ev.detail.id === this.activeId) this._refreshStats();
    });

    const first = manager.list()[0];
    if (first) this._selectScript(first.id);
  }

  _bindEvents() {
    this.root.addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-act], [data-script-id]');
      if (!target) return;
      const id = target.getAttribute('data-script-id');
      const act = target.getAttribute('data-act');
      if (id) this._selectScript(id);
      if (act === 'new') this._actNew();
      else if (act === 'apply') this._actApply();
      else if (act === 'duplicate') this._actDuplicate();
      else if (act === 'delete') this._actDelete();
      else if (act === 'export') this._actExport();
      else if (act === 'import') this._actImport();
      else if (act === 'ai') this._actAskAi();
      else if (act === 'export-ts') this._actExportTs();
      else if (act === 'sweep') this._actSweep();
      else if (act === 'walk-forward') this._actWalkForward();
      else if (act === 'toggle') {
        const targetId = target.getAttribute('data-id');
        if (targetId) this.manager.setEnabled(targetId, target.checked);
      } else if (act === 'toggle-srv') {
        const targetId = target.getAttribute('data-id');
        if (targetId) this.manager.setServerSide(targetId, target.checked);
      } else if (act === 'clear-alerts') {
        this.manager.alerts.length = 0;
        this._refreshAlerts();
      }
    });

    this.elTextarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        const ta = this.elTextarea;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + 2;
        this._updateGutter();
      }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this._actApply();
      }
    });

    this.elTextarea.addEventListener('input', () => this._updateGutter());
    this.elTextarea.addEventListener('scroll', () => {
      this.elGutter.scrollTop = this.elTextarea.scrollTop;
    });
  }

  _refreshList() {
    const scripts = this.manager.list();
    this.elList.innerHTML = scripts
      .map((s) => {
        const status = this.manager.getStatus(s.id);
        const cls = status.state === 'error' ? 'err' : status.state === 'running' ? 'ok' : '';
        const active = s.id === this.activeId ? 'active' : '';
        const serverChecked = s.runServerSide ? 'checked' : '';
        return `
          <div class="nanopine-row ${active} ${cls}" data-script-id="${s.id}">
            <label class="nanopine-toggle" title="Enable on the chart">
              <input type="checkbox" data-act="toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''} />
            </label>
            <span class="nanopine-row-name">${escapeHtml(s.name)}</span>
            <label class="nanopine-toggle nanopine-toggle-srv" title="Also run server-side for alerts (browser does not need to be open)">
              <input type="checkbox" data-act="toggle-srv" data-id="${s.id}" ${serverChecked} />
              <span class="nanopine-toggle-label">srv</span>
            </label>
            <span class="nanopine-row-state">${escapeHtml(status.state)}</span>
          </div>
        `;
      })
      .join('');
    if (!scripts.find((s) => s.id === this.activeId) && scripts[0]) {
      this._selectScript(scripts[0].id);
    }
  }

  _selectScript(id) {
    this.activeId = id;
    const sc = this.manager.list().find((s) => s.id === id);
    if (!sc) return;
    this.elName.value = sc.name;
    this.elTextarea.value = sc.source;
    this._updateGutter();
    this._renderInputs(sc);
    this.elError.textContent = '';
    this._refreshList();
    this._refreshStats();
    this._refreshContextButtons(sc);
    const status = this.manager.getStatus(id);
    this._renderStatus({ id, error: status.error });
  }

  _refreshContextButtons(sc) {
    const isStrategy = /\bstrategy\s*\(/.test(sc.source || '');
    if (this.elTsBtn) this.elTsBtn.hidden = !isStrategy;
    if (this.elSweepBtn) this.elSweepBtn.hidden = !isStrategy;
    if (this.elWalkForwardBtn) this.elWalkForwardBtn.hidden = !isStrategy;
  }

  _renderInputs(sc) {
    // Pre-parse to discover input declarations. Errors here are tolerated — the
    // Apply button surfaces them in the error footer.
    let inputDecls = [];
    try {
      const tokens = tokenize(sc.source);
      const program = parse(tokens);
      inputDecls = program.body.filter((s) => s.type === 'InputDecl');
    } catch {
      inputDecls = [];
    }
    if (!inputDecls.length) {
      this.elInputs.innerHTML = '';
      return;
    }
    const rows = inputDecls.map((decl) => {
      const current =
        sc.inputs && Object.prototype.hasOwnProperty.call(sc.inputs, decl.name)
          ? sc.inputs[decl.name]
          : declDefault(decl);
      const title = kwargValue(decl.kwargs, 'title') || decl.name;
      return inputRowHtml(decl, title, current);
    });
    this.elInputs.innerHTML = rows.join('');
    this.elInputs.querySelectorAll('input,select').forEach((el) => {
      el.addEventListener('change', () => {
        const name = el.getAttribute('data-input');
        const kind = el.getAttribute('data-kind');
        sc.inputs = sc.inputs || {};
        sc.inputs[name] = coerceInputValue(el.value, kind);
        this.manager.update(sc.id, { inputs: sc.inputs });
      });
    });
  }

  _updateGutter() {
    const lines = this.elTextarea.value.split('\n').length;
    let s = '';
    for (let i = 1; i <= lines; i++) s += `${i}\n`;
    this.elGutter.textContent = s;
  }

  _actNew() {
    const sc = this.manager.create({ name: 'New script', source: '' });
    this._selectScript(sc.id);
  }

  _actApply() {
    if (!this.activeId) return;
    const sc = this.manager.list().find((s) => s.id === this.activeId);
    if (!sc) return;
    sc.source = this.elTextarea.value;
    sc.name = this.elName.value || sc.name;
    // Persist + enable + run. update() persists; setEnabled triggers apply.
    this.manager.update(sc.id, { source: sc.source, name: sc.name });
    this.manager.setEnabled(sc.id, true);
    this.elError.textContent = '';
    this._renderInputs(sc);
  }

  _actDuplicate() {
    if (!this.activeId) return;
    const sc = this.manager.duplicate(this.activeId);
    if (sc) this._selectScript(sc.id);
  }

  async _probeCapabilities() {
    try {
      const r = await fetch('/api/scripts/capabilities');
      if (!r.ok) return;
      const caps = await r.json();
      if (caps?.ai && this.elAiBtn) this.elAiBtn.hidden = false;
    } catch {
      /* offline or backend not running — buttons stay hidden */
    }
  }

  async _actAskAi() {
    const prompt = window.prompt(
      'Describe the script you want (e.g. "RSI 14 with overbought/oversold bgcolor and alerts")',
    );
    if (!prompt) return;
    this._setStatus('Generating…');
    try {
      const r = await fetch('/api/scripts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const body = await r.json();
      if (!r.ok) {
        this.elError.textContent = `AI: ${body.error || 'failed'}`;
        this.elError.classList.add('has-error');
        return;
      }
      const sc = this.manager.create({
        name: prompt.slice(0, 40),
        source: body.source,
      });
      this._selectScript(sc.id);
    } catch (err) {
      this.elError.textContent = `AI: ${err instanceof Error ? err.message : String(err)}`;
      this.elError.classList.add('has-error');
    } finally {
      this._setStatus('');
    }
  }

  _actExportTs() {
    if (!this.activeId) return;
    const sc = this.manager.list().find((s) => s.id === this.activeId);
    if (!sc) return;
    try {
      const ts = this.manager.exportAsTypescript(sc.id);
      if (!ts) return;
      const blob = new Blob([ts.source], { type: 'text/typescript' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = ts.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this.elError.textContent = `Export TS: ${err instanceof Error ? err.message : String(err)}`;
      this.elError.classList.add('has-error');
    }
  }

  async _actSweep() {
    if (!this.activeId) return;
    const sc = this.manager.list().find((s) => s.id === this.activeId);
    if (!sc) return;
    let ranges;
    try {
      ranges = await this.manager.collectSweepRanges(sc.id);
    } catch (err) {
      this.elError.textContent = `Sweep: ${err instanceof Error ? err.message : String(err)}`;
      this.elError.classList.add('has-error');
      return;
    }
    if (!ranges || !ranges.length) {
      this.elError.textContent =
        'Sweep needs at least one int/float input. Add `name = input.int(default, title=...)` to your script.';
      this.elError.classList.add('has-error');
      return;
    }
    const promptText = ranges
      .map(
        (r) =>
          `${r.name} (${r.kind}, default ${r.default}): start, end, step  e.g.  ${r.default - 5},${r.default + 5},1`,
      )
      .join('\n');
    const input = window.prompt(`Enter ranges (one line each):\n\n${promptText}`, '');
    if (!input) return;
    const lines = input.split('\n').map((l) => l.trim()).filter((l) => l);
    if (lines.length !== ranges.length) {
      this.elError.textContent = `Sweep: expected ${ranges.length} lines, got ${lines.length}`;
      this.elError.classList.add('has-error');
      return;
    }
    const parsed = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].split(',').map((s) => Number(s.trim()));
      if (m.length !== 3 || m.some((n) => !Number.isFinite(n))) {
        this.elError.textContent = `Sweep: line ${i + 1} must be "start,end,step"`;
        this.elError.classList.add('has-error');
        return;
      }
      parsed.push({ name: ranges[i].name, kind: ranges[i].kind, start: m[0], end: m[1], step: m[2] });
    }
    this._setStatus('Sweeping…');
    try {
      const results = await this.manager.runSweep(sc.id, parsed);
      this._renderSweep(results);
    } catch (err) {
      this.elError.textContent = `Sweep: ${err instanceof Error ? err.message : String(err)}`;
      this.elError.classList.add('has-error');
    } finally {
      this._setStatus('');
    }
  }

  async _actWalkForward() {
    if (!this.activeId) return;
    const sc = this.manager.list().find((s) => s.id === this.activeId);
    if (!sc) return;
    let ranges;
    try {
      ranges = await this.manager.collectSweepRanges(sc.id);
    } catch (err) {
      this.elError.textContent = `Walk-forward: ${err instanceof Error ? err.message : String(err)}`;
      this.elError.classList.add('has-error');
      return;
    }
    if (!ranges || !ranges.length) {
      this.elError.textContent =
        'Walk-forward needs at least one int/float input. Add `name = input.int(default, title=...)` to your script.';
      this.elError.classList.add('has-error');
      return;
    }
    const dimsPrompt = ranges
      .map(
        (r) =>
          `${r.name} (${r.kind}, default ${r.default}): start, end, step  e.g.  ${r.default - 5},${r.default + 5},1`,
      )
      .join('\n');
    const dimsInput = window.prompt(`Enter param ranges (one line each):\n\n${dimsPrompt}`, '');
    if (!dimsInput) return;
    const lines = dimsInput.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length !== ranges.length) {
      this.elError.textContent = `Walk-forward: expected ${ranges.length} lines, got ${lines.length}`;
      this.elError.classList.add('has-error');
      return;
    }
    const parsed = [];
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(',').map((s) => Number(s.trim()));
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
        this.elError.textContent = `Walk-forward: line ${i + 1} must be "start,end,step"`;
        this.elError.classList.add('has-error');
        return;
      }
      parsed.push({
        name: ranges[i].name,
        kind: ranges[i].kind,
        start: parts[0],
        end: parts[1],
        step: parts[2],
      });
    }
    const windowsInput = window.prompt(
      'Window sizes: trainBars, testBars, stepBars  (e.g.  500,100,100)',
      '500,100,100',
    );
    if (!windowsInput) return;
    const w = windowsInput.split(',').map((s) => Number(s.trim()));
    if (w.length !== 3 || w.some((n) => !Number.isFinite(n))) {
      this.elError.textContent =
        'Walk-forward: window sizes must be "trainBars, testBars, stepBars"';
      this.elError.classList.add('has-error');
      return;
    }
    this._setStatus('Walk-forward running…');
    try {
      const windows = await this.manager.runWalkForward(sc.id, parsed, {
        trainBars: w[0],
        testBars: w[1],
        stepBars: w[2],
      });
      this._renderWalkForward(windows);
    } catch (err) {
      this.elError.textContent = `Walk-forward: ${err instanceof Error ? err.message : String(err)}`;
      this.elError.classList.add('has-error');
    } finally {
      this._setStatus('');
    }
  }

  _renderWalkForward(windows) {
    if (!windows || !windows.length) {
      this.elStats.hidden = false;
      this.elStats.innerHTML = `
        <div class="nanopine-stats-head"><strong>Walk-forward</strong><span class="dim">no windows produced</span></div>
        <div class="dim">Try a longer history, smaller windows, or wider input ranges.</div>
      `;
      return;
    }
    const inputCols = Object.keys(windows[0].bestInputs);
    let trainSum = 0;
    let testSum = 0;
    const rows = windows
      .map((w) => {
        const tr = w.trainStats?.totalPnl ?? 0;
        const te = w.testStats?.totalPnl ?? 0;
        trainSum += tr;
        testSum += te;
        const inputCells = inputCols
          .map((c) => `<td>${escapeHtml(w.bestInputs[c])}</td>`)
          .join('');
        const trCls = tr >= 0 ? 'pos' : 'neg';
        const teCls = te >= 0 ? 'pos' : 'neg';
        return `<tr>
          <td>${w.trainStart}-${w.trainEnd}</td>
          <td>${w.trainEnd}-${w.testEnd}</td>
          ${inputCells}
          <td class="${trCls}">${tr.toFixed(2)}</td>
          <td class="${teCls}">${te.toFixed(2)}</td>
          <td>${((w.testStats?.winRate ?? 0) * 100).toFixed(1)}%</td>
        </tr>`;
      })
      .join('');
    const inputHeaders = inputCols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    const oosShare = trainSum !== 0 ? (testSum / Math.abs(trainSum)) * 100 : 0;
    this.elStats.hidden = false;
    this.elStats.innerHTML = `
      <div class="nanopine-stats-head"><strong>Walk-forward</strong><span class="dim">${windows.length} window${windows.length === 1 ? '' : 's'}</span></div>
      <div class="nanopine-stats-grid">
        <div><span class="lbl">Sum train PnL</span><span class="val ${trainSum >= 0 ? 'pos' : 'neg'}">${trainSum.toFixed(2)}</span></div>
        <div><span class="lbl">Sum test PnL</span><span class="val ${testSum >= 0 ? 'pos' : 'neg'}">${testSum.toFixed(2)}</span></div>
        <div><span class="lbl">OOS / IS</span><span class="val">${oosShare.toFixed(1)}%</span></div>
        <div><span class="lbl">Windows</span><span class="val">${windows.length}</span></div>
      </div>
      <table class="nanopine-sweep">
        <thead>
          <tr><th>Train</th><th>Test</th>${inputHeaders}<th>Train PnL</th><th>Test PnL</th><th>Win</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  _renderSweep(results) {
    if (!results || !results.length) return;
    // Use the stats panel slot.
    const top = results.slice(0, 30);
    const cols = Object.keys(top[0].inputs);
    const rows = top
      .map((r) => {
        const inputCells = cols.map((c) => `<td>${escapeHtml(r.inputs[c])}</td>`).join('');
        const cls = (r.stats?.totalPnl ?? 0) >= 0 ? 'pos' : 'neg';
        return `<tr>
          ${inputCells}
          <td class="${cls}">${(r.stats?.totalPnl ?? 0).toFixed(2)}</td>
          <td>${((r.stats?.winRate ?? 0) * 100).toFixed(1)}%</td>
          <td>${r.stats?.trades ?? 0}</td>
          <td class="neg">${((r.stats?.maxDrawdown ?? 0) * 100).toFixed(1)}%</td>
        </tr>`;
      })
      .join('');
    this.elStats.hidden = false;
    this.elStats.innerHTML = `
      <div class="nanopine-stats-head"><strong>Sweep — top ${top.length}</strong><span class="dim">${results.length} runs</span></div>
      <table class="nanopine-sweep">
        <thead>
          <tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}<th>PnL</th><th>Win</th><th>Trades</th><th>MaxDD</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  _setStatus(text) {
    if (this.elStatus) this.elStatus.textContent = text || '';
  }

  _actExport() {
    const payload = this.manager.exportAll();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nanopine-scripts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _actImport() {
    const input = this.root.querySelector('[data-role="import-input"]');
    if (!input) return;
    input.value = '';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ''));
          const imported = this.manager.importMany(parsed);
          if (imported.length) this._selectScript(imported[0].id);
        } catch (err) {
          this.elError.textContent = `Import failed: ${(err instanceof Error ? err.message : String(err))}`;
          this.elError.classList.add('has-error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  _actDelete() {
    if (!this.activeId) return;
    const ok = window.confirm('Delete this script?');
    if (!ok) return;
    this.manager.delete(this.activeId);
    this.activeId = null;
    this._refreshList();
    const first = this.manager.list()[0];
    if (first) this._selectScript(first.id);
    else {
      this.elTextarea.value = '';
      this.elName.value = '';
      this.elInputs.innerHTML = '';
      this._updateGutter();
    }
  }

  _renderStatus(detail) {
    if (detail.id && detail.id !== this.activeId) {
      this._refreshList();
      return;
    }
    if (detail.error) {
      const loc =
        detail.error.line != null
          ? ` (line ${detail.error.line}${detail.error.col != null ? ', col ' + detail.error.col : ''})`
          : '';
      this.elError.textContent = `${detail.error.name || 'Error'}: ${detail.error.message}${loc}`;
      this.elError.classList.add('has-error');
      if (detail.error.line != null) this._highlightLine(detail.error.line, detail.error.col);
    } else {
      this.elError.textContent = '';
      this.elError.classList.remove('has-error');
    }
    this._refreshList();
  }

  _highlightLine(line, col) {
    const lines = this.elTextarea.value.split('\n');
    if (line < 1 || line > lines.length) return;
    let pos = 0;
    for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
    const colOffset = Math.max(0, (col || 1) - 1);
    const start = pos + Math.min(colOffset, lines[line - 1].length);
    const end = pos + lines[line - 1].length;
    try {
      this.elTextarea.focus();
      this.elTextarea.setSelectionRange(start, end);
    } catch {
      /* ignore */
    }
  }

  _refreshStats() {
    if (!this.elStats) return;
    if (!this.activeId) {
      this.elStats.hidden = true;
      return;
    }
    const blob = this.manager.getStats(this.activeId);
    if (!blob || !blob.stats) {
      this.elStats.hidden = true;
      this.elStats.innerHTML = '';
      return;
    }
    const s = blob.stats;
    const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
    const money = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
    const cellClass = s.totalPnl >= 0 ? 'pos' : 'neg';
    this.elStats.hidden = false;
    this.elStats.innerHTML = `
      <div class="nanopine-stats-head"><strong>Backtest</strong><span class="dim">${s.trades} trade${s.trades === 1 ? '' : 's'}</span></div>
      <div class="nanopine-stats-grid">
        <div><span class="lbl">Net PnL</span><span class="val ${cellClass}">${money(s.totalPnl)}</span></div>
        <div><span class="lbl">Return</span><span class="val ${cellClass}">${pct(s.totalReturn)}</span></div>
        <div><span class="lbl">Win rate</span><span class="val">${pct(s.winRate)}</span></div>
        <div><span class="lbl">Max DD</span><span class="val neg">${pct(s.maxDrawdown)}</span></div>
        <div><span class="lbl">Avg win</span><span class="val pos">${money(s.avgWin)}</span></div>
        <div><span class="lbl">Avg loss</span><span class="val neg">${money(s.avgLoss)}</span></div>
        <div><span class="lbl">Final eq</span><span class="val">${money(s.finalEquity)}</span></div>
        <div><span class="lbl">Open</span><span class="val">${s.openPosition ? `${s.openPosition.side} @ ${s.openPosition.entryPrice.toFixed(2)}` : 'flat'}</span></div>
      </div>
    `;
  }

  _refreshAlerts() {
    if (!this.elAlerts) return;
    const alerts = this.manager.alerts || [];
    if (!alerts.length) {
      this.elAlerts.hidden = true;
      this.elAlertsList.innerHTML = '';
      return;
    }
    this.elAlerts.hidden = false;
    const rows = alerts.slice(0, 20).map((a) => {
      const t = new Date(a.at).toLocaleTimeString();
      return `<div class="nanopine-alert-row" title="${escapeAttr(a.scriptName)} — bar ${a.bar}">
        <span class="when">${t}</span>
        <span>${escapeHtml(a.scriptName)}: ${escapeHtml(a.message)}</span>
      </div>`;
    });
    this.elAlertsList.innerHTML = rows.join('');
  }
}

function declDefault(decl) {
  const arg0 = decl.args[0];
  if (!arg0) return null;
  if (arg0.type === 'Number') return arg0.value;
  if (arg0.type === 'String') return arg0.value;
  if (arg0.type === 'Bool') return arg0.value;
  return null;
}

function kwargValue(kwargs, name) {
  const kw = kwargs.find((k) => k.name === name);
  if (!kw) return null;
  if (kw.value.type === 'String') return kw.value.value;
  if (kw.value.type === 'Number') return String(kw.value.value);
  return null;
}

function coerceInputValue(raw, kind) {
  if (kind === 'int') return Math.round(Number(raw));
  if (kind === 'float') return Number(raw);
  if (kind === 'bool') return raw === 'true' || raw === true;
  return raw;
}

function inputRowHtml(decl, title, current) {
  const id = decl.name;
  if (decl.kind === 'int' || decl.kind === 'float') {
    const step = decl.kind === 'int' ? '1' : 'any';
    return `<label class="nanopine-input-row">
      <span>${escapeHtml(title)}</span>
      <input type="number" step="${step}" data-input="${id}" data-kind="${decl.kind}" value="${escapeAttr(current)}" />
    </label>`;
  }
  if (decl.kind === 'bool') {
    return `<label class="nanopine-input-row">
      <span>${escapeHtml(title)}</span>
      <select data-input="${id}" data-kind="bool">
        <option value="true"${current ? ' selected' : ''}>true</option>
        <option value="false"${!current ? ' selected' : ''}>false</option>
      </select>
    </label>`;
  }
  // string / source
  const opts = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
  if (decl.kind === 'source') {
    return `<label class="nanopine-input-row">
      <span>${escapeHtml(title)}</span>
      <select data-input="${id}" data-kind="source">
        ${opts.map((o) => `<option value="${o}"${o === current ? ' selected' : ''}>${o}</option>`).join('')}
      </select>
    </label>`;
  }
  return `<label class="nanopine-input-row">
    <span>${escapeHtml(title)}</span>
    <input type="text" data-input="${id}" data-kind="string" value="${escapeAttr(current)}" />
  </label>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}
