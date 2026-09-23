import { expect } from 'chai';
import { ethers } from 'hardhat';

/// Never-mint conservation invariant. After a dispute has fully settled, the core
/// only ever holds value it was handed: escrowed juror stake (free `staked` +
/// per-seat stake already routed to `withdrawable`) plus prepaid fees (routed to
/// `withdrawable`). Nothing is minted. So the core's on-chain balance must EXACTLY
/// equal the sum of every participant's pullable `withdrawable` plus their remaining
/// free `staked`. Call after every settlement.
///
/// `accounts` must include every address that could hold a `withdrawable` or
/// `staked` balance in the scenario: jurors, the app, the treasury, and any payer.
export async function assertConservation(core: any, accounts: string[]) {
  const coreBal = await ethers.provider.getBalance(await core.getAddress());
  let sum = 0n;
  const seen = new Set<string>();
  for (const a of accounts) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue; // dedupe so shared addresses aren't double-counted
    seen.add(key);
    sum += await core.withdrawable(a);
    sum += await core.staked(a);
  }
  expect(sum, 'core balance must equal Σ withdrawable + Σ staked (never-mint)').to.equal(coreBal);
}
