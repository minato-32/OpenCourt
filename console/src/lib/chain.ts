// Browser chain access. Mirrors sdk/src/client.ts but with the web ws-provider.
// Revive.call takes weight_limit (not gas_limit); a revert is a SUCCESSFUL dispatch with flags bit 0 set.
// Contract-side value is 1e18, extrinsic value is 1e10 planck — divide by 1e8.

import { Binary, createClient, type PolkadotSigner } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/web';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { paseohub } from '@polkadot-api/descriptors';
import { ethers } from 'ethers';

export const WSS = 'wss://paseo-asset-hub-next-rpc.polkadot.io';

/** Any account works as a dry-run origin; Alice dev key. */
const READ_ORIGIN = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

const WEIGHT = { ref_time: 500_000_000_000n, proof_size: 5_000_000n };
const STORAGE_DEPOSIT_LIMIT = 500_000_000_000n; // 50 PAS cap per call (planck)

/** Contract side: 1e18 per PAS. */
export const PAS_EVM = 1_000_000_000_000_000_000n;
/** Chain side: 1e10 planck per PAS. */
export const PAS_PLANCK = 10_000_000_000n;
/** Contract-side amount -> planck to transfer. */
export const toPlanck = (evm: bigint) => evm / 100_000_000n;

export const client = createClient(withPolkadotSdkCompat(getWsProvider(WSS)));
export const api = client.getTypedApi(paseohub);

export class ContractRevert extends Error {
  constructor(readonly fn: string, readonly reason: string, readonly data: string) {
    super(`${fn} reverted: ${reason}`);
  }
}

function decodeRevert(iface: ethers.Interface, fn: string, data: string): ContractRevert {
  try {
    const parsed = iface.parseError(data);
    if (parsed) {
      const args = parsed.args.length ? `(${parsed.args.map(String).join(', ')})` : '';
      return new ContractRevert(fn, `${parsed.name}${args}`, data);
    }
  } catch {
    /* not a known custom error */
  }
  return new ContractRevert(fn, data, data);
}

/** flags arrives as a number, bigint, or { bits }. */
function revertBitSet(flags: unknown): boolean {
  if (typeof flags === 'bigint') return (flags & 1n) === 1n;
  if (typeof flags === 'number') return (flags & 1) === 1;
  if (flags && typeof flags === 'object' && 'bits' in (flags as any)) {
    return (BigInt((flags as any).bits) & 1n) === 1n;
  }
  return false;
}

/** Dry-run read. Throws ContractRevert on an EVM-level revert. */
export async function read(
  address: string,
  abi: ethers.InterfaceAbi,
  fn: string,
  params: unknown[] = [],
): Promise<ethers.Result> {
  const iface = new ethers.Interface(abi);
  const r = await api.apis.ReviveApi.call(
    READ_ORIGIN,
    Binary.fromHex(address as `0x${string}`) as any,
    0n,
    undefined,
    undefined,
    Binary.fromHex(iface.encodeFunctionData(fn, params) as `0x${string}`),
  );
  if (!r.result.success) throw new Error(`${fn} dispatch failed: ${JSON.stringify(r.result.value)}`);
  const data = (r.result.value as any).data.asHex();
  if (revertBitSet((r.result.value as any).flags)) throw decodeRevert(iface, fn, data);
  return iface.decodeFunctionResult(fn, data);
}

/** Dry-run a write without submitting, so a button can show why it would fail. Null = would succeed. */
export async function simulate(
  origin: string,
  address: string,
  abi: ethers.InterfaceAbi,
  fn: string,
  params: unknown[] = [],
  value = 0n,
): Promise<ContractRevert | null> {
  const iface = new ethers.Interface(abi);
  const r = await api.apis.ReviveApi.call(
    origin,
    Binary.fromHex(address as `0x${string}`) as any,
    value,
    undefined,
    undefined,
    Binary.fromHex(iface.encodeFunctionData(fn, params) as `0x${string}`),
  );
  if (!r.result.success) return new ContractRevert(fn, JSON.stringify(r.result.value), '0x');
  const data = (r.result.value as any).data.asHex();
  if (revertBitSet((r.result.value as any).flags)) return decodeRevert(iface, fn, data);
  return null;
}

export interface WriteResult {
  txHash: string;
  blockHash: string;
}

/** Signed call. valueEvm is contract-side (1e18) and is converted to planck. */
export async function write(
  signer: PolkadotSigner,
  address: string,
  abi: ethers.InterfaceAbi,
  fn: string,
  params: unknown[] = [],
  valueEvm = 0n,
): Promise<WriteResult> {
  const iface = new ethers.Interface(abi);
  const tx = api.tx.Revive.call({
    dest: Binary.fromHex(address as `0x${string}`) as any,
    value: toPlanck(valueEvm),
    weight_limit: WEIGHT,
    storage_deposit_limit: STORAGE_DEPOSIT_LIMIT,
    data: Binary.fromHex(iface.encodeFunctionData(fn, params) as `0x${string}`),
  });
  const r = await tx.signAndSubmit(signer);
  if (!r.ok) throw new Error(`${fn} failed: ${JSON.stringify(r.dispatchError)}`);
  return { txHash: r.txHash, blockHash: r.block.hash };
}

/** Free balance in planck. */
export async function freeBalance(ss58: string): Promise<bigint> {
  const acct = await api.query.System.Account.getValue(ss58);
  return acct.data.free;
}

/** Watch finalized block height. */
export function watchBlocks(onBlock: (n: number) => void): () => void {
  const sub = client.finalizedBlock$.subscribe((b) => onBlock(b.number));
  return () => sub.unsubscribe();
}
