/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { escapeHtml, renderAiBriefMarkdown } from '../ui/ai-brief-render.js';

describe('renderAiBriefMarkdown', () => {
  it('wraps trading keywords in highlight spans after sanitize', () => {
    const md = '- **Bias:** HTF is SHORT vs LONG on LTF (83%).\n- SMC noted.\n\n<script>alert(1)</script>';
    const html = renderAiBriefMarkdown(md);
    expect(html).toContain('ai-hl-short');
    expect(html).toContain('ai-hl-long');
    expect(html).toContain('ai-hl-acro');
    expect(html).toContain('ai-hl-pct');
    expect(html.toLowerCase()).not.toContain('<script>');
  });

  it('does not highlight inside inline code', () => {
    const md = 'Bias `SHORT` only.';
    const html = renderAiBriefMarkdown(md);
    expect(html).toContain('<code>');
    expect(html).not.toContain('ai-hl-short');
  });

  it('returns empty placeholder for blank input', () => {
    expect(renderAiBriefMarkdown('   ')).toContain('ai-brief-empty');
  });
});

describe('escapeHtml', () => {
  it('escapes angle brackets and quotes', () => {
    expect(escapeHtml('<a title="x">')).toBe('&lt;a title=&quot;x&quot;&gt;');
  });
});
