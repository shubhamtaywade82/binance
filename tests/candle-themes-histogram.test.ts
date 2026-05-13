import { describe, expect, it } from 'vitest';
import { getCandleTheme, getHistogramBarColors } from '../ui/candle-themes.js';

describe('getHistogramBarColors', () => {
  it('uses candle body colors for Outline (border + translucent bodies)', () => {
    const t = getCandleTheme('outline');
    const v = getHistogramBarColors(t);
    expect(v.up).toBe(t.candle.upColor);
    expect(v.down).toBe(t.candle.downColor);
  });

  it('uses candle body colors for Hollow bull (translucent up)', () => {
    const t = getCandleTheme('hollow');
    const v = getHistogramBarColors(t);
    expect(v.up).toBe(t.candle.upColor);
    expect(v.down).toBe(t.candle.downColor);
  });

  it('uses theme volume tint for Quantum (no candle borders)', () => {
    const t = getCandleTheme('quantum');
    const v = getHistogramBarColors(t);
    expect(v.up).toBe(t.volumeUp);
    expect(v.down).toBe(t.volumeDown);
  });

  it('uses theme volume for TV dark (bordered but solid bodies)', () => {
    const t = getCandleTheme('trading-dark');
    const v = getHistogramBarColors(t);
    expect(v.up).toBe(t.volumeUp);
    expect(v.down).toBe(t.volumeDown);
  });
});
