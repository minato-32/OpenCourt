/**
 * Generic pallet-revive contract client over PAPI — the SDK's transport core.
 *
 * Mirrors p2p-market's proven pattern (apps/web/src/lib/host/_p2p-market-call.ts):
 *   - reads  -> ReviveApi.call (dry-run), decoded with an ethers Interface
 *   - writes -> Revive.call extrinsic, signed + submitted with a PAPI signer
 *   - ethers is used ONLY as an ABI codec, never as a wallet/RPC transport.
 *
 * SETUP: generate the typed descriptor once with `pnpm papi:add`.
 */

import { Binary, createClient, type PolkadotSigner } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { ethers } from 'ethers';
import { paseohub } from '@polkadot-api/descriptors';

const DEFAULT_WSS = 'wss://paseo-asset-hub-next-rpc.polkadot.io';
// Read origin for dry-run reads; any account works (Alice dev account).
const DEFAULT_READ_ORIGIN = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const CALL_WEIGHT = { ref_time: 50_000_000_000n, proof_size: 1_000_000n };
const STORAGE_DEPOSIT_LIMIT = 10_000_000_000n;

export interface ContractClientOpts {
  wss?: string;
  readOrigin?: string;
}

/**
 * Result of a state-changing call. `txHash` is the real extrinsic hash; `blockHash`
 * is the finalized block that included it. (Previously the block hash was returned
 * mislabelled as the tx hash — kept as a distinct field now so callers can tell them
 * apart, e.g. to look the tx up in an explorer.)
 */
export interface WriteResult {
  txHash: string;
  blockHash: string;
}

/** A typed handle to one deployed pallet-revive contract. */
export class ContractClient {
  private client: ReturnType<typeof createClient>;
  private api: any = null; // typed via getTypedApi(paseohub) once the descriptor exists
  private iface: ethers.Interface;

  constructor(
    readonly address: string,
    abi: ethers.InterfaceAbi,
    private readonly opts: ContractClientOpts = {},
  ) {
    this.client = createClient(withPolkadotSdkCompat(getWsProvider(opts.wss ?? DEFAULT_WSS)));
    this.api = this.client.getTypedApi(paseohub);
    this.iface = new ethers.Interface(abi);
  }

  private ensureApi(): any {
    if (!this.api) {
      throw new Error(
        'PAPI descriptor missing. Run `pnpm papi:add` to generate @polkadot-api/descriptors.',
      );
    }
    return this.api;
  }

  private h160() {
    return Binary.fromHex(this.address);
  }

  /** Read-only contract call (ReviveApi.call), ABI-decoded. */
  async read(fn: string, params: unknown[] = []): Promise<ethers.Result> {
    const api = this.ensureApi();
    const calldata = this.iface.encodeFunctionData(fn, params);
    const res = await api.apis.ReviveApi.call(
      this.opts.readOrigin ?? DEFAULT_READ_ORIGIN,
      this.h160(),
      0n,
      undefined,
      undefined,
      Binary.fromHex(calldata),
    );
    if (!res.result.success) {
      throw new Error(`${fn} reverted: ${JSON.stringify(res.result.value)}`);
    }
    const data: string = res.result.value.data.asHex();
    // A dispatch can "succeed" (extrinsic ran) yet the EVM frame REVERTED: pallet-revive
    // sets ReturnFlags bit 0 and puts the custom-error selector+args in `data`. That is
    // NOT a decodable function result — decode it as an error and throw before it reaches
    // decodeFunctionResult (which would mis-decode error bytes as a return value).
    if (revertBitSet(res.result.value.flags)) {
      throw decodeRevert(this.iface, fn, data);
    }
    if (data === '0x') {
      throw new Error(`${fn} returned 0x — function missing on deployed bytecode?`);
    }
    return this.iface.decodeFunctionResult(fn, data);
  }

  /** State-changing contract call (Revive.call), signed + submitted. `value` in planck. */
  async write(
    signer: PolkadotSigner,
    fn: string,
    params: unknown[] = [],
    value = 0n,
  ): Promise<WriteResult> {
    const api = this.ensureApi();
    const calldata = this.iface.encodeFunctionData(fn, params);
    const tx = api.tx.Revive.call({
      dest: this.h160(),
      value,
      weight_limit: CALL_WEIGHT,
      storage_deposit_limit: STORAGE_DEPOSIT_LIMIT,
      data: Binary.fromHex(calldata),
    });
    const r = await tx.signAndSubmit(signer);
    if (!r.ok) {
      throw new Error(`${fn} failed: ${JSON.stringify(r.dispatchError)}`);
    }
    // PAPI surfaces the real extrinsic hash (`txHash`) alongside the including block.
    return { txHash: r.txHash, blockHash: r.block.hash };
  }

  /** Current finalized block height — for phase/deadline preconditions. */
  async blockNumber(): Promise<bigint> {
    const b = await this.client.getFinalizedBlock();
    return BigInt(b.number);
  }

  /** Encode a function call without submitting (useful for batching / inspection). */
  encode(fn: string, params: unknown[] = []): string {
    return this.iface.encodeFunctionData(fn, params);
  }

  destroy() {
    this.client.destroy();
  }
}

/**
 * pallet-revive ReturnFlags: bit 0 (value 1) == REVERT. The typed descriptor may
 * surface this as a bigint, a number, or a `{ bits }` wrapper depending on codegen,
 * so normalise defensively.
 */
function revertBitSet(flags: unknown): boolean {
  if (typeof flags === 'bigint') return (flags & 1n) === 1n;
  if (typeof flags === 'number') return (flags & 1) === 1;
  if (flags && typeof flags === 'object' && 'bits' in (flags as Record<string, unknown>)) {
    return (BigInt((flags as { bits: number | bigint }).bits) & 1n) === 1n;
  }
  return false;
}

/** Turn revert-return bytes into a readable Error via the ABI's custom-error table. */
function decodeRevert(iface: ethers.Interface, fn: string, data: string): Error {
  if (data && data !== '0x') {
    try {
      const parsed = iface.parseError(data);
      if (parsed) {
        const args = parsed.args.length ? ` ${JSON.stringify(parsed.args.map((a) => String(a)))}` : '';
        return new Error(`${fn} reverted: ${parsed.name}${args}`);
      }
    } catch {
      // Not a known custom error (or undecodable) — fall through to the raw form.
    }
  }
  return new Error(`${fn} reverted (data=${data})`);
}
