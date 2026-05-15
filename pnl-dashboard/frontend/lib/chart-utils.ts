/** Evenly sample rows so the X-axis stays readable (Recharts otherwise renders every point as a tick). */
export function downsampleSeries<T>(rows: T[], maxPoints: number): T[] {
  if (rows.length <= maxPoints || maxPoints < 2) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]!);
  const last = rows[rows.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Short axis labels: avoids `toLocaleDateString()` repeating the same day for intraday snapshots. */
export function formatAxisTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function numericSeriesDomain(values: number[], padRatio = 0.06): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) {
    const p = Math.abs(lo) * 0.001 || 1;
    return [lo - p, hi + p];
  }
  const pad = (hi - lo) * padRatio || 1;
  return [lo - pad, hi + pad];
}
