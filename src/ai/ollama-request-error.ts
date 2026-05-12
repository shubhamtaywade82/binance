/** Normalize Ollama client errors for dashboard / logs (AbortSignal.timeout message is opaque). */
export function formatOllamaRequestError(err: unknown, timeoutMs: number): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/aborted|timeout/i.test(raw)) {
    return `Ollama timed out after ${timeoutMs}ms — raise AI_REQUEST_TIMEOUT_MS, use a smaller OLLAMA_MODEL, or wait for the model to finish loading (first prompt is slower).`;
  }
  return raw;
}
