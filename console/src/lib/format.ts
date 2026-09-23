// Display helpers. Contract-side amounts are 1e18; chain-side balances are 1e10 planck.

import { PAS_EVM, PAS_PLANCK } from './chain';

export function pas(v: bigint, dp = 4): string {
  const neg = v < 0n;
  const x = neg ? -v : v;
  const whole = x / PAS_EVM;
  const frac = ((x % PAS_EVM) * 10n ** BigInt(dp)) / PAS_EVM;
  return `${neg ? '-' : ''}${whole}.${frac.toString().padStart(dp, '0')} PAS`;
}

export function pasPlanck(v: bigint, dp = 4): string {
  const whole = v / PAS_PLANCK;
  const frac = ((v % PAS_PLANCK) * 10n ** BigInt(dp)) / PAS_PLANCK;
  return `${whole}.${frac.toString().padStart(dp, '0')} PAS`;
}

export const short = (addr: string, n = 6) =>
  addr.length > 2 * n ? `${addr.slice(0, n)}…${addr.slice(-4)}` : addr;

export const bps = (v: number) => `${(v / 100).toFixed(v % 100 === 0 ? 0 : 2)}%`;

/** Blocks left as a human duration, using the chain's measured block time. */
export function blocksLeft(target: bigint, head: number, blockSeconds: number): string {
  const n = Number(target) - head;
  if (n <= 0) return 'elapsed';
  const secs = n * blockSeconds;
  if (secs < 90) return `${n} blocks (~${secs}s)`;
  if (secs < 5400) return `${n} blocks (~${Math.round(secs / 60)}m)`;
  return `${n} blocks (~${(secs / 3600).toFixed(1)}h)`;
}
