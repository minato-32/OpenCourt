/**
 * Deploy the current contract set and mint the court through CourtRegistry, so the court carries a
 * real courtId and the registry records its provenance.
 *
 * Order: PersonhoodRegistry -> PopGatedEligibility -> CourtRegistry -> createCourt -> SimpleEscrow,
 * then attest the demo jurors.
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
const CALL_DEPOSIT = 5_000_000_000_000n;
const REBIND_COOLDOWN_BLOCKS = 300n;

/** Jurors to attest: the deployer plus the two derived accounts the case runner uses. */
const JUROR_PATHS = ['', '//j1', '//j2'];

const toSs58 = AccountId().dec;

function account(derivation: string) {
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) throw new Error('DEPLOYER_MNEMONIC not set');
  const kp = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)))(derivation);
  return {
    signer: getPolkadotSigner(kp.publicKey, 'Sr25519', kp.sign),
    ss58: toSs58(kp.publicKey),
    h160: ethers.getAddress('0x' + ethers.keccak256(kp.publicKey).slice(-40)),
  };
}

function artifact(solFile: string, name: string) {
  const p = path.join(ARTIFACTS, solFile, `${name}.json`);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!String(json.bytecode).startsWith('0x50564d')) {
    throw new Error(`${name} is not a PolkaVM blob — run \`pnpm compile:pvm\` first.`);
  }
  return { abi: json.abi as ethers.InterfaceAbi, bytecode: json.bytecode as string };
}

const client = createClient(withPolkadotSdkCompat(getWsProvider(WSS)));
const api = client.getTypedApi(paseohub);

async function instantiate(signer: PolkadotSigner, label: string, solFile: string, name: string, args: unknown[] = []) {
  const { abi, bytecode } = artifact(solFile, name);
  const data = new ethers.Interface(abi).encodeDeploy(args) || '0x';
  const salt = Binary.fromHex(('0x' + Date.now().toString(16).padStart(64, '0')) as `0x${string}`);
  const r = await api.tx.Revive.instantiate_with_code({
    value: 0n,
    weight_limit: WEIGHT,
    storage_deposit_limit: DEPLOY_DEPOSIT,
    code: Binary.fromHex(bytecode as `0x${string}`),
    data: Binary.fromHex((data === '0x' ? '0x' : data) as `0x${string}`),
    salt: salt as any,
  }).signAndSubmit(signer);
  if (!r.ok) throw new Error(`${label} failed: ${JSON.stringify(r.dispatchError)}`);
  const ev = r.events.find((e: any) => e.type === 'Revive' && e.value.type === 'Instantiated');
  const addr: string = (ev as any)?.value?.value?.contract?.asHex?.();
  if (!addr) throw new Error(`${label}: no Instantiated event`);
  console.log(`   ${label.padEnd(24)} -> ${addr}`);
  return addr;
}

/**
 * Put a contract's code on chain without instantiating it.
 *
 * A factory like CourtRegistry does `new ArbitratorCore(...)`, which on pallet-revive resolves a
 * code HASH that must already exist — unlike the EVM, where the child's bytecode is carried inside
 * the creator's own code. Skip this and createCourt reverts with `CodeNotFound`.
 */
async function uploadCode(signer: PolkadotSigner, label: string, solFile: string, name: string) {
  const { bytecode } = artifact(solFile, name);
  const r = await api.tx.Revive.upload_code({
    code: Binary.fromHex(bytecode as `0x${string}`),
    storage_deposit_limit: DEPLOY_DEPOSIT,
  }).signAndSubmit(signer);
  if (!r.ok) {
    const err = JSON.stringify(r.dispatchError);
    // Already uploaded by an earlier deploy: the code hash is what matters, not who put it there.
    if (!err.includes('DuplicateContract')) throw new Error(`${label} upload failed: ${err}`);
    console.log(`   ${label.padEnd(24)} code already on chain`);
    return;
  }
  console.log(`   ${label.padEnd(24)} code uploaded`);
}

async function send(signer: PolkadotSigner, address: string, abi: ethers.InterfaceAbi, fn: string, args: unknown[]) {
  const r = await api.tx.Revive.call({
    dest: Binary.fromHex(address as `0x${string}`) as any,
    value: 0n,
    weight_limit: WEIGHT,
    storage_deposit_limit: CALL_DEPOSIT,
    data: Binary.fromHex(new ethers.Interface(abi).encodeFunctionData(fn, args) as `0x${string}`),
  }).signAndSubmit(signer);
  if (!r.ok) throw new Error(`${fn} failed: ${JSON.stringify(r.dispatchError)}`);
  return r;
}

async function read(address: string, abi: ethers.InterfaceAbi, fn: string, args: unknown[] = []) {
  const iface = new ethers.Interface(abi);
  const r = await api.apis.ReviveApi.call(
    account('').ss58,
    Binary.fromHex(address as `0x${string}`) as any,
    0n,
    undefined,
    undefined,
    Binary.fromHex(iface.encodeFunctionData(fn, args) as `0x${string}`),
  );
  const v = r.result.value as any;
  if ((typeof v?.flags === 'number' ? v.flags : 0) & 1) throw new Error(`${fn} reverted`);
  return iface.decodeFunctionResult(fn, v.data.asHex());
}

function courtConfig(treasury: string) {
  return {
    minStake: 100n * PAS_EVM,
    jurorFee: 10n * PAS_EVM,
    drawThreshold: (1n << 256n) - 1n,
    evidenceBond: 5n * PAS_EVM, // a non-party files at a price; refundable once the case ends
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
    pinFeeBps: 0,
    treasury,
    pinner: ethers.ZeroAddress,
  };
}

async function main() {
  const dep = account('');
  console.log('Deployer:', dep.h160, '\n');

  console.log('1. Policy stack');
  const registry = await instantiate(dep.signer, 'PersonhoodRegistry', 'policies/PersonhoodRegistry.sol', 'PersonhoodRegistry', [dep.h160, REBIND_COOLDOWN_BLOCKS]);
  const eligibility = await instantiate(dep.signer, 'PopGatedEligibility', 'policies/PopGatedEligibility.sol', 'PopGatedEligibility', [registry]);

  console.log('\n2. Court, minted through the registry');
  await uploadCode(dep.signer, 'ArbitratorCore', 'core/ArbitratorCore.sol', 'ArbitratorCore');
  const courtRegistry = await instantiate(dep.signer, 'CourtRegistry', 'core/CourtRegistry.sol', 'CourtRegistry');
  const regAbi = artifact('core/CourtRegistry.sol', 'CourtRegistry').abi;
  await send(dep.signer, courtRegistry, regAbi, 'createCourt', [courtConfig(dep.h160), eligibility]);

  const courtCount = (await read(courtRegistry, regAbi, 'courtCount'))[0] as bigint;
  const court = (await read(courtRegistry, regAbi, 'courts', [courtCount])) as any;
  const core = court[0] as string;
  console.log(`   courtId ${courtCount} -> ArbitratorCore ${core}`);
  const [known, verified] = await read(courtRegistry, regAbi, 'courtVerified', [courtCount]);
  console.log(`   registry provenance: known ${known}, verified ${verified}`);

  const escrow = await instantiate(dep.signer, 'SimpleEscrow', 'examples/SimpleEscrow.sol', 'SimpleEscrow', [core]);

  console.log('\n3. Court reads back');
  const coreAbi = artifact('core/ArbitratorCore.sol', 'ArbitratorCore').abi;
  console.log('   courtId          :', String((await read(core, coreAbi, 'courtId'))[0]));
  console.log('   policyDescriptor :', (await read(core, coreAbi, 'policyDescriptor'))[0]);
  console.log('   arbitrationCost  :', Number((await read(core, coreAbi, 'arbitrationCost', ['0x']))[0]) / 1e18, 'PAS');

  console.log('\n4. Attesting jurors');
  const personhoodAbi = artifact('policies/PersonhoodRegistry.sol', 'PersonhoodRegistry').abi;
  for (const [i, p] of JUROR_PATHS.entries()) {
    const j = account(p);
    const already = (await read(registry, personhoodAbi, 'isVerified', [j.h160]))[0] as boolean;
    if (!already) {
      await send(dep.signer, registry, personhoodAbi, 'attest', [j.h160, ethers.id(`getcourt-v2-juror-${i + 1}`)]);
    }
    const weight = (await read(eligibility, [
      { type: 'function', name: 'weightOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint96' }], outputs: [{ type: 'uint256' }] },
    ], 'weightOf', [j.h160, courtCount]))[0] as bigint;
    console.log(`   ${(p || 'root').padEnd(6)} ${j.h160} policy weight ${weight}`);
  }

  console.log('\nDeployed:');
  console.log('  PersonhoodRegistry  :', registry);
  console.log('  PopGatedEligibility :', eligibility);
  console.log('  CourtRegistry       :', courtRegistry);
  console.log('  ArbitratorCore      :', core);
  console.log('  SimpleEscrow        :', escrow);
  console.log('  courtId             :', String(courtCount));
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
