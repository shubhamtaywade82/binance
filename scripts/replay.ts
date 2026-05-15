import { loadConfig } from '../src/config';
import { defaultEventBus } from '../src/core/events/event-bus';
import { PgWriter } from '../src/persistence/pg-writer';
import { EventStore } from '../src/persistence/event-store';
import { ReplayEngine } from '../src/replay/replay-engine';

const main = async () => {
  const args = process.argv.slice(2);
  const sessionArg = args.find(a => a.startsWith('--session='));
  const speedArg = args.find(a => a.startsWith('--speed='));

  let speed = 1;
  if (speedArg) {
    const val = speedArg.split('=')[1];
    speed = val === 'max' ? Infinity : parseFloat(val);
  }

  const cfg = loadConfig();
  if (!cfg.POSTGRES_URL) {
    console.error('POSTGRES_URL is required for replay.');
    process.exit(1);
  }

  const pgWriter = new PgWriter({ connectionString: cfg.POSTGRES_URL });
  await pgWriter.connect();

  const eventStore = new EventStore(pgWriter, defaultEventBus);
  const engine = new ReplayEngine(eventStore, defaultEventBus);

  // Example: Listen to replay events to verify it's working
  let count = 0;
  defaultEventBus.subscribeAll((event) => {
    count++;
    if (count % 1000 === 0) {
      console.log(`[Replay] Processed ${count} events... last event: ${event.type}`);
    }
  });

  // Since we don't have a "sessions" table yet, we'll just replay the last 24 hours
  // Or parse dates from sessionArg if you want to implement specific windows
  const toTs = Date.now();
  const fromTs = toTs - 24 * 60 * 60 * 1000; 

  console.log(`Starting replay from ${new Date(fromTs).toISOString()} to ${new Date(toTs).toISOString()} at speed ${speed}x`);

  await engine.replay({
    fromTs,
    toTs,
    speedMultiplier: speed
  });

  console.log(`Finished replays. Total events processed: ${count}`);
  await pgWriter.close();
  process.exit(0);
};

main().catch(err => {
  console.error('Replay failed:', err);
  process.exit(1);
});
