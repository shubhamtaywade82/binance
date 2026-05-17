/**
 * MarketClock — single authoritative time source for the trading core.
 *
 * LIVE  mode: returns Date.now()
 * REPLAY mode: returns the timestamp of the event currently being dispatched
 *              by the replay engine. Lets feature/strategy/risk/ML code use one
 *              `now()` instead of each calling Date.now() and drifting.
 */

export type ClockMode = 'live' | 'replay';

export class MarketClock {
  private mode: ClockMode = 'live';
  private replayTs = 0;

  setMode(mode: ClockMode): void {
    this.mode = mode;
  }

  getMode(): ClockMode {
    return this.mode;
  }

  /** Replay engine calls this before dispatching each event. */
  setReplayTs(ts: number): void {
    this.replayTs = ts;
  }

  now(): number {
    return this.mode === 'replay' ? this.replayTs : Date.now();
  }
}

export const marketClock = new MarketClock();
