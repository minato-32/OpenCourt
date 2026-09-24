/**
 * Deploy the personhood-gated court stack to Paseo Asset Hub Next and attest the test jurors.
 *
 * Order: PersonhoodRegistry -> PopGatedEligibility -> ArbitratorCore -> SimpleEscrow, then one
 * attest() per juror so the gate has somebody to let through.
 *
 * Conventions this chain enforces, all verified: `weight_limit` not `gas_limit`, constructor args
 * in `data` with `code` left as the raw blob, contract-side amounts in 1e18 and extrinsic value in
 * 1e10 planck.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { AccountId, Binary, createClient, type PolkadotSigner } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { entropyToMiniSecret, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';
import { paseohub } from '@polkadot-api/descriptors';

const WSS = process.env.PASEO_ASSET_HUB_WSS || 'wss://paseo-asset-hub-next-rpc.polkadot.io';
const ARTIFACTS = path.resolve(__dirname, '../artifacts/contracts');
const PAS_EVM = 1_000_000_000_000_000_000n;

const WEIGHT = { ref_time: 500_000_000_000n, proof_size: 5_000_000n };
const DEPLOY_DEPOSIT = 100_000_000_000_000n;
const CALL_DEPOSIT = 500_000_000_000n;

/** Blocks a revoked credential waits before it may bind again. ~10 min at 2s blocks. */
const REBIND_COOLDOWN_BLOCKS = 300n;

/** Jurors to attest. The deployer is derived; the other two are the funded test wallets. */
const JUROR_SS58 = [
  '5HmVZH7Y1uK2fbLpf3zsnNmbD1kfpqmGKk9ef9pgGWqpb9xv',
  '5C5BYYZjhA6WaTkJzPw19ak5oNS6eERH11Fq9CwyrvsS6ttN',
];

const toSs58 = AccountId().dec;
const toPubkey = AccountId().enc;

function deployer() {
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) throw new Error('DEPLOYER_MNEMONIC not set in .env');
  const kp = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)))('');
  return {
    signer: getPolkadotSigner(kp.publicKey, 'Sr25519', kp.sign),
    ss58: toSs58(kp.publicKey),
    h160: h160Of(kp.publicKey),
  };
}

/** pallet-revive AccountId32Mapper fallback: keccak(accountId32)[12..32]. */
function h160Of(publicKey: Uint8Array): string {
  return ethers.getAddress('0x' + ethers.keccak256(publicKey).slice(-40));
}

function artifact(solFile: string, name: string) {
  const p = path.join(ARTIFACTS, solFile, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`Artifact missing: ${p} — run pnpm compile --network paseo`);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  // `hardhat test` recompiles for the EVM and overwrites this directory, so a deploy run right
  // after a test run would ship EVM bytecode and fail as EvmConstructorNonEmptyData. Fail loudly.
  if (!String(json.bytecode).startsWith('0x50564d')) {
    throw new Error(
      `${name} artifact is not a PolkaVM blob (missing PVM magic). ` +
        'Run `pnpm compile --network paseo` before deploying.',
    );
  }
  return { abi: json.abi as ethers.InterfaceAbi, bytecode: json.bytecode as string };
}

const client = createClient(withPolkadotSdkCompat(getWsProvider(WSS)));
const api = client.getTypedApi(paseohub);

async function instantiate(
  signer: PolkadotSigner,
  label: string,
  solFile: string,
  name: string,
  args: unknown[] = [],
): Promise<string> {
  const { abi, bytecode } = artifact(solFile, name);
  const data = new ethers.Interface(abi).encodeDeploy(args) || '0x';
  const salt = Binary.fromHex(('0x' + Date.now().toString(16).padStart(64, '0')) as `0x${string}`);
  const tx = api.tx.Revive.instantiate_with_code({
    value: 0n,
    weight_limit: WEIGHT,
    storage_deposit_limit: DEPLOY_DEPOSIT,
    code: Binary.fromHex(bytecode as `0x${string}`),
    data: Binary.fromHex((data === '0x' ? '0x' : data) as `0x${string}`),
    salt: salt as any,
  });
  const r = await tx.signAndSubmit(signer);
  if (!r.ok) throw new Error(`${label} deploy failed: ${JSON.stringify(r.dispatchError)}`);
  const ev = r.events.find((e: any) => e.type === 'Revive' && e.value.type === 'Instantiated');
  const addr: string = (ev as any)?.value?.value?.contract?.asHex?.();
  if (!addr) throw new Error(`${label}: no Instantiated event`);
  console.log(`   ${label.padEnd(24)} -> ${addr}`);
  return addr;
}

async function call(signer: PolkadotSigner, address: string, abi: ethers.InterfaceAbi, fn: string, args: unknown[]) {
  const tx = api.tx.Revive.call({
    dest: Binary.fromHex(address as `0x${string}`) as any,
    value: 0n,
    weight_limit: WEIGHT,
    storage_deposit_limit: CALL_DEPOSIT,
    data: Binary.fromHex(new ethers.Interface(abi).encodeFunctionData(fn, args) as `0x${string}`),
  });
  const r = await tx.signAndSubmit(signer);
  if (!r.ok) throw new Error(`${fn} failed: ${JSON.stringify(r.dispatchError)}`);
}

async function read(address: string, abi: ethers.InterfaceAbi, fn: string, args: unknown[] = []) {
  const iface = new ethers.Interface(abi);
  const r = await api.apis.ReviveApi.call(
    deployer().ss58,
    Binary.fromHex(address as `0x${string}`) as any,
    0n,
    undefined,
    undefined,
    Binary.fromHex(iface.encodeFunctionData(fn, args) as `0x${string}`),
  );
  return iface.decodeFunctionResult(fn, (r.result.value as any).data.asHex());
}

/** One court, personhood gated. Same economics as the canonical court so q* stays 0.4167. */
function courtConfig(treasury: string) {
  return {
    minStake: 100n * PAS_EVM,
    jurorFee: 10n * PAS_EVM,
    drawThreshold: (1n << 256n) - 1n,
    evidenceBond: 0n, // a non-party files free in these courts
    evidenceBlocks: 10n, // FR-DL-02: the record closes before any draw
    activationDelayBlocks: 1n,
    drawDelayBlocks: 2n,
    drawWindowBlocks: 150n,
    commitBlocks: 120n,
    revealBlocks: 120n,
    panelSize: 3,
    betaBps: 1000,
    gammaBps: 2500,
    thetaBps: 2000,
    quorumBps: 5000,
    appFeeBps: 0,
    protocolFeeBps: 0,
    treasury,
  };
}

async function main() {
  const dep = deployer();
  console.log('Deployer:', dep.ss58, '->', dep.h160, '\n');

  console.log('1. Personhood stack');
  const registry = await instantiate(
    dep.signer, 'PersonhoodRegistry', 'policies/PersonhoodRegistry.sol', 'PersonhoodRegistry',
    [dep.h160, REBIND_COOLDOWN_BLOCKS],
  );
  const eligibility = await instantiate(
    dep.signer, 'PopGatedEligibility', 'policies/PopGatedEligibility.sol', 'PopGatedEligibility', [registry],
  );
  const core = await instantiate(
    dep.signer, 'ArbitratorCore', 'core/ArbitratorCore.sol', 'ArbitratorCore',
    [courtConfig(dep.h160), eligibility, 0],
  );
  const escrow = await instantiate(
    dep.signer, 'SimpleEscrow', 'examples/SimpleEscrow.sol', 'SimpleEscrow', [core],
  );

  const regAbi = artifact('policies/PersonhoodRegistry.sol', 'PersonhoodRegistry').abi;
  const popAbi = artifact('policies/PopGatedEligibility.sol', 'PopGatedEligibility').abi;

  console.log('\n2. Attesting jurors');
  const jurors = [dep.h160, ...JUROR_SS58.map((s) => h160Of(toPubkey(s)))];
  for (const [i, juror] of jurors.entries()) {
    const already = (await read(registry, regAbi, 'isVerified', [juror]))[0] as boolean;
    if (already) {
      console.log(`   juror ${i + 1} ${juror} already attested`);
      continue;
    }
    const credential = ethers.id(`getcourt-demo-credential-${i + 1}`);
    await call(dep.signer, registry, regAbi, 'attest', [juror, credential]);
    const ok = (await read(registry, regAbi, 'isVerified', [juror]))[0] as boolean;
    console.log(`   juror ${i + 1} ${juror} attested -> isVerified ${ok}`);
  }

  console.log('\n3. Gate check through the policy the court actually reads');
  for (const [i, juror] of jurors.entries()) {
    const eligible = (await read(eligibility, popAbi, 'isEligible', [juror]))[0] as boolean;
    console.log(`   juror ${i + 1} eligible: ${eligible}`);
  }
  const stranger = '0x0000000000000000000000000000000000000abc';
  const strangerEligible = (await read(eligibility, popAbi, 'isEligible', [stranger]))[0] as boolean;
  console.log(`   unattested stranger eligible: ${strangerEligible}  (must be false)`);

  console.log('\nPersonhood court deployed:');
  console.log('  PersonhoodRegistry  :', registry);
  console.log('  PopGatedEligibility :', eligibility);
  console.log('  ArbitratorCore      :', core);
  console.log('  SimpleEscrow        :', escrow);
  console.log('  rebind cooldown     :', String(REBIND_COOLDOWN_BLOCKS), 'blocks');
}

main()
  .then(() => {
    client.destroy();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    client.destroy();
    process.exit(1);
  });
