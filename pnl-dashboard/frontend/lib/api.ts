const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001';

export async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const swrFetcher = (path: string) => fetchApi(path);
