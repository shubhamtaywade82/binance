import { modelProposalSchema, type ModelProposal } from './types';

export interface OllamaGenerateResponse {
  response: string;
}

export class ProposalEngine {
  constructor(
    private readonly ollamaUrl: string,
    private readonly model: string,
  ) {}

  async generate(userPrompt: string, systemPrompt: string): Promise<ModelProposal> {
    const r = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: `${systemPrompt}\n\n${userPrompt}`,
        stream: false,
        format: 'json',
      }),
    });
    if (!r.ok) throw new Error(`ollama_http_${r.status}`);

    const payload = await r.json() as OllamaGenerateResponse;
    const parsed = JSON.parse(payload.response);
    return modelProposalSchema.parse(parsed);
  }
}
