import { EventBus } from '../core/events/event-bus';
import { EventStore } from '../persistence/event-store';

export interface ReplayOptions {
  fromTs: number;
  toTs: number;
  speedMultiplier?: number;
  types?: string[];
}

export class ReplayEngine {
  constructor(
    private readonly eventStore: EventStore,
    private readonly eventBus: EventBus
  ) {}

  public async replay(options: ReplayOptions): Promise<void> {
    console.log(`[ReplayEngine] Fetching events from ${options.fromTs} to ${options.toTs}...`);
    const events = await this.eventStore.fetchEvents(options.fromTs, options.toTs, options.types);
    console.log(`[ReplayEngine] Found ${events.length} events. Starting playback...`);

    if (events.length === 0) return;

    const speed = options.speedMultiplier || 1;
    
    if (speed === Infinity) {
      // Run synchronously as fast as possible
      for (const event of events) {
        this.eventBus.publish(event);
      }
      return;
    }

    // Playback with original timing spacing (adjusted by speedMultiplier)
    let lastEventTs = events[0].ts;
    let lastRealTs = Date.now();

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const deltaVirtual = event.ts - lastEventTs;
      
      if (deltaVirtual > 0) {
        const deltaReal = deltaVirtual / speed;
        const now = Date.now();
        const elapsedSinceLast = now - lastRealTs;
        const sleepTime = deltaReal - elapsedSinceLast;
        
        if (sleepTime > 0) {
          await new Promise(r => setTimeout(r, sleepTime));
        }
      }
      
      this.eventBus.publish(event);
      
      lastEventTs = event.ts;
      lastRealTs = Date.now();
    }
    
    console.log(`[ReplayEngine] Replay complete.`);
  }
}
