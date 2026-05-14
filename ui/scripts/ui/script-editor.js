// Lightweight script editor UI. Renders into a host element that lives in the
// Scripts tab of the right sidebar. Uses a plain <textarea> + a gutter <div> for
// line numbers; no Monaco yet (Phase 2 swap behind this API).

import { tokenize } from '../runtime/lexer.js';
import { parse } from '../runtime/parser.js';

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

    this._bindEvents();
    this._refreshList();
    this._refreshAlerts();
    this._refreshStats();

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
      else if (act === 'toggle') {
        const targetId = target.getAttribute('data-id');
        if (targetId) this.manager.setEnabled(targetId, target.checked);
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
        return `
          <div class="nanopine-row ${active} ${cls}" data-script-id="${s.id}">
            <label class="nanopine-toggle">
              <input type="checkbox" data-act="toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''} />
            </label>
            <span class="nanopine-row-name">${escapeHtml(s.name)}</span>
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
    const status = this.manager.getStatus(id);
    this._renderStatus({ id, error: status.error });
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
