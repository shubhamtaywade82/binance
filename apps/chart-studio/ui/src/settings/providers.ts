import type { ProviderClient, ProviderInfo } from '../provider-client';

export class ProviderSettings {
  private overlay: HTMLElement;
  private list: HTMLElement;
  private bar: HTMLElement;
  private current: ProviderInfo[] = [];

  constructor(private readonly client: ProviderClient) {
    this.overlay = document.getElementById('settings-overlay')!;
    this.list = document.getElementById('provider-list')!;
    this.bar = document.getElementById('providers-bar')!;
    document.getElementById('settings-btn')!.addEventListener('click', () => this.open());
    document.getElementById('close-settings')!.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    void this.refresh();
    setInterval(() => void this.refresh(), 5000);
  }

  async refresh(): Promise<void> {
    const list = await this.client.listProviders();
    this.current = list;
    this.renderBar();
    if (!this.overlay.classList.contains('hidden')) this.renderList();
  }

  open(): void {
    this.renderList();
    this.overlay.classList.remove('hidden');
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  providers(): ProviderInfo[] {
    return this.current;
  }

  private renderBar(): void {
    if (this.current.length === 0) {
      this.bar.innerHTML = '<span>No providers connected</span>';
      return;
    }
    this.bar.innerHTML = this.current.map((p) =>
      `<span><span class="dot ${p.online ? 'online' : 'offline'}"></span>${p.displayName}</span>`
    ).join(' · ');
  }

  private renderList(): void {
    if (this.current.length === 0) {
      this.list.innerHTML = '<li>No providers running. Start an adapter microservice.</li>';
      return;
    }
    this.list.innerHTML = this.current.map((p) => `
      <li>
        <div>
          <strong>${p.displayName}</strong>
          <div style="color: var(--fg-dim); font-size: 11px;">${p.provider}</div>
        </div>
        <div>${p.online ? '🟢 online' : '🔴 offline'}</div>
      </li>
    `).join('');
  }
}
