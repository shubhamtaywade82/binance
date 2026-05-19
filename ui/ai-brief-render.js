/**
 * AI Brief: Markdown → sanitized HTML with semantic keyword highlights.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

const BASE_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];

const PURIFY_BASE = {
  ALLOWED_TAGS: BASE_TAGS,
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
};

const PURIFY_WITH_SPAN = {
  ALLOWED_TAGS: [...BASE_TAGS, 'span'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
  ALLOW_DATA_ATTR: false,
};

/** Direction / sentiment / verdict / structure tokens (word-boundary matches). */
const HIGHLIGHT_RE =
  /\b(NO TRADE|ENTER NOW|WAIT FOR ENTRY|SCALE IN|SHORT|LONG|BULLISH|BEARISH|NEUTRAL|BUY|SELL)\b|\b(HTF|LTF|SMC|BOS|FVG|CHoCH|OB|SETUP VALID)\b|(\d+(?:\.\d+)?%)/gi;

const SKIP_ANCESTOR = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'KBD', 'SAMP']);

let domPurifyHighlightHooked = false;

const ensureHighlightHook = () => {
  if (domPurifyHighlightHooked) return;
  domPurifyHighlightHooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'SPAN' || !node.hasAttribute('class')) return;
    const allowed = node
      .getAttribute('class')
      .split(/\s+/)
      .filter((c) => c.startsWith('ai-hl-'));
    if (allowed.length) node.setAttribute('class', allowed.join(' '));
    else node.removeAttribute('class');
  });
}

const fragmentWithHighlights = (doc, text) => {
  const re = new RegExp(HIGHLIGHT_RE.source, HIGHLIGHT_RE.flags);
  const frag = doc.createDocumentFragment();
  let last = 0;
  let m;
  let hits = 0;
  while ((m = re.exec(text)) !== null) {
    hits += 1;
    if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
    const span = doc.createElement('span');
    const raw = m[0];
    if (m[1]) {
      const u = m[1].toUpperCase();
      if (u === 'SHORT' || u === 'SELL' || u === 'NO TRADE') span.className = 'ai-hl-dir ai-hl-short';
      else if (u === 'LONG' || u === 'BUY' || u === 'ENTER NOW' || u === 'SCALE IN') span.className = 'ai-hl-dir ai-hl-long';
      else if (u === 'BULLISH') span.className = 'ai-hl-sent ai-hl-bull';
      else if (u === 'BEARISH') span.className = 'ai-hl-sent ai-hl-bear';
      else if (u === 'WAIT FOR ENTRY') span.className = 'ai-hl-sent ai-hl-neutral ai-hl-wait';
      else span.className = 'ai-hl-sent ai-hl-neutral';
    } else if (m[2]) {
      span.className = 'ai-hl-acro';
    } else {
      span.className = 'ai-hl-pct';
    }
    span.textContent = raw;
    frag.appendChild(span);
    last = re.lastIndex;
  }
  if (hits === 0) return null;
  if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
  return frag;
}

const applyKeywordHighlights = (sanitizedHtml) => {
  if (typeof DOMParser === 'undefined') return sanitizedHtml;
  const doc = new DOMParser().parseFromString(
    `<div id="ai-brief-hl-root">${sanitizedHtml}</div>`,
    'text/html',
  );
  const root = doc.getElementById('ai-brief-hl-root');
  if (!root) return sanitizedHtml;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const batch = [];
  let n = walker.nextNode();
  while (n) {
    batch.push(/** @type {Text} */ (n));
    n = walker.nextNode();
  }

  for (const textNode of batch) {
    let el = textNode.parentElement;
    let skip = false;
    while (el) {
      if (SKIP_ANCESTOR.has(el.tagName)) {
        skip = true;
        break;
      }
      el = el.parentElement;
    }
    if (skip) continue;
    const frag = fragmentWithHighlights(doc, textNode.data);
    if (frag && textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
  }

  return root.innerHTML;
}

export const escapeHtml = (s) => {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const renderAiBriefMarkdown = (markdown) => {
  const src = typeof markdown === 'string' ? markdown : '';
  if (!src.trim()) {
    return '<p class="ai-brief-empty">—</p>';
  }
  const raw = marked.parse(src, { async: false });
  if (typeof raw !== 'string') return '';
  const pass1 = DOMPurify.sanitize(raw, PURIFY_BASE);
  ensureHighlightHook();
  const withHl = applyKeywordHighlights(pass1);
  return DOMPurify.sanitize(withHl, PURIFY_WITH_SPAN);
}
