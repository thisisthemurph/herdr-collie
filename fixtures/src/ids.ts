// Deterministic ULIDs and timestamps for fixtures, so regenerating them gives identical files.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(n: bigint, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[Number(n % 32n)] + out;
    n /= 32n;
  }
  return out;
}

/** A real ULID: 48-bit millisecond time, then 80 bits from `seq`. Sorts by time, then seq. */
export function ulidAt(ms: number, seq: number): string {
  return encode(BigInt(ms), 10) + encode(BigInt(seq), 16);
}

/** A clock that starts at `start` and moves forward by `stepMs` per tick. */
export class FixtureClock {
  private ms: number;
  private seq = 0;
  constructor(
    start: string,
    private readonly stepMs = 1000,
  ) {
    this.ms = Date.parse(start);
  }
  /** Advances the clock and returns the new timestamp. */
  tick(ms = this.stepMs): string {
    this.ms += ms;
    return this.now();
  }
  now(): string {
    return new Date(this.ms).toISOString();
  }
  /** Seconds-precision timestamp, as config files use. */
  nowSeconds(): string {
    return `${this.now().slice(0, 19)}Z`;
  }
  id(): string {
    this.seq += 1;
    return ulidAt(this.ms, this.seq);
  }
}
