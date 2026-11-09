// ULID generation: 48-bit millisecond time, then 80 random bits, in Crockford base32.
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new ULID. Ids sort by creation time to the millisecond. */
export function newUlid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of random.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits % 32n)] + rand;
    bits /= 32n;
  }
  return time + rand;
}

/** RFC 3339 UTC with milliseconds, the event `ts` format. */
export const eventTs = (now: number = Date.now()): string => new Date(now).toISOString();
