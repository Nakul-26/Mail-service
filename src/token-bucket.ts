/** Token bucket: up to `ratePerSecond` on average, bursts up to `burst`. Per process. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private ratePerSecond: number,
    private burst = Math.max(1, Math.ceil(ratePerSecond)),
  ) {
    this.tokens = this.burst;
  }
  take(max: number, now = Date.now()): number {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
    const n = Math.min(max, Math.floor(this.tokens));
    this.tokens -= n;
    return n;
  }
  refund(n: number) {
    this.tokens = Math.min(this.burst, this.tokens + n);
  }
}
