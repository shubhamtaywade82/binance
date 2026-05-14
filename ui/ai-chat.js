const MAX_STORED_MESSAGES = 100;
const STORAGE_PREFIX = 'ai-chat-history-';

export class AiChat {
  constructor({ messagesEl, inputEl, sendBtn, clearBtn, contextToggle, getSymbol }) {
    this._messagesEl = messagesEl;
    this._inputEl = inputEl;
    this._sendBtn = sendBtn;
    this._clearBtn = clearBtn;
    this._contextToggle = contextToggle;
    this._getSymbol = getSymbol;
    this._messages = [];
    this._streaming = false;
    this._abortController = null;

    this._loadHistory();
    this._render();
    this._bindEvents();
  }

  _storageKey() {
    return STORAGE_PREFIX + (this._getSymbol() || 'default');
  }

  _loadHistory() {
    try {
      const raw = localStorage.getItem(this._storageKey());
      if (raw) this._messages = JSON.parse(raw).slice(-MAX_STORED_MESSAGES);
    } catch { /* corrupted — start fresh */ }
  }

  _saveHistory() {
    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(this._messages.slice(-MAX_STORED_MESSAGES)));
    } catch { /* quota exceeded */ }
  }

  _bindEvents() {
    this._sendBtn.addEventListener('click', () => this._send());
    this._clearBtn.addEventListener('click', () => this._clear());
    this._inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });
    this._inputEl.addEventListener('input', () => this._autoResize());
  }

  _autoResize() {
    const el = this._inputEl;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  async _send() {
    const text = this._inputEl.value.trim();
    if (!text || this._streaming) return;

    this._messages.push({ role: 'user', content: text });
    this._inputEl.value = '';
    this._inputEl.style.height = 'auto';
    this._render();
    this._scrollToBottom();

    this._streaming = true;
    this._sendBtn.disabled = true;
    this._abortController = new AbortController();

    const assistantIdx = this._messages.length;
    this._messages.push({ role: 'assistant', content: '' });
    this._render();

    try {
      const includeContext = this._contextToggle?.checked !== false;
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this._messages.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
          context: includeContext,
        }),
        signal: this._abortController.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        this._messages[assistantIdx].content = `Error: ${err.error || resp.statusText}`;
        this._render();
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.token) {
              this._messages[assistantIdx].content += payload.token;
              this._renderLastMessage(assistantIdx);
              this._scrollToBottom();
            }
            if (payload.error) {
              this._messages[assistantIdx].content += `\n\nError: ${payload.error}`;
              this._renderLastMessage(assistantIdx);
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this._messages[assistantIdx].content = `Connection error: ${err.message}`;
        this._render();
      }
    } finally {
      this._streaming = false;
      this._sendBtn.disabled = false;
      this._abortController = null;
      this._saveHistory();
    }
  }

  _clear() {
    this._messages = [];
    this._saveHistory();
    this._render();
  }

  _render() {
    const el = this._messagesEl;
    el.innerHTML = '';

    if (!this._messages.length) {
      el.innerHTML = `
        <div class="ai-chat-empty">
          <div class="ai-chat-empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5">
              <path d="M12 2a7 7 0 0 1 7 7c0 3-2 5.5-4 7l-3 4-3-4c-2-1.5-4-4-4-7a7 7 0 0 1 7-7z"/>
              <circle cx="12" cy="9" r="2"/>
            </svg>
          </div>
          <p>Ask about market structure, signals, or strategy ideas.</p>
          <p class="dim">Market context is injected automatically when enabled.</p>
        </div>`;
      return;
    }

    for (let i = 0; i < this._messages.length; i++) {
      el.appendChild(this._createBubble(this._messages[i], i));
    }
  }

  _renderLastMessage(idx) {
    const el = this._messagesEl;
    const existing = el.querySelector(`[data-msg-idx="${idx}"]`);
    if (existing) {
      existing.querySelector('.ai-bubble-content').innerHTML = this._formatContent(this._messages[idx].content);
    } else {
      el.appendChild(this._createBubble(this._messages[idx], idx));
    }
  }

  _createBubble(msg, idx) {
    const div = document.createElement('div');
    div.className = `ai-bubble ai-bubble-${msg.role}`;
    div.setAttribute('data-msg-idx', idx);

    const label = msg.role === 'user' ? 'You' : 'QuantumTrade AI';
    div.innerHTML = `
      <div class="ai-bubble-header">${label}</div>
      <div class="ai-bubble-content">${this._formatContent(msg.content)}</div>`;
    return div;
  }

  _formatContent(text) {
    if (!text) return '<span class="ai-typing">Thinking…</span>';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
    });
  }
}
