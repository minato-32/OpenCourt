/**
 * Seed a demo case on a deployed court: fund an escrow, raise the dispute, and attach the demo
 * evidence documents as on-chain pointers.
 *
 * The pointer is a path served by the app itself (`/evidence/<file>`), not an IPFS CID: the bytes
 * are not pinned anywhere yet, and recording a CID nothing can resolve would be a lie. When the
 * site is published to Bulletin the evidence rides along in the same bundle, so the pointer keeps
 * resolving. Real pinning is a later feature; the sha256 in `contentHash` already lets a juror
 * detect substitution.
 *
 * Usage: pnpm seed:case <coreAddress> <escrowAddress>
 */

import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { AccountId, Binary, createClient, type PolkadotSigner } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { entropyToMiniSecret, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';
import { MultiAddress, paseohub } from '@polkadot-api/descriptors';

const WSS = process.env.PASEO_ASSET_HUB_WSS || 'wss://paseo-asset-hub-next-rpc.polkadot.io';
const ARTIFACTS = path.resolve(__dirname, '../artifacts/contracts');
const EVIDENCE_DIR = path.resolve(__dirname, '../console/public/evidence');
const PAS_EVM = 1_000_000_000_000_000_000n;
const WEIGHT = { ref_time: 500_000_000_000n, proof_size: 5_000_000n };
const CALL_DEPOSIT = 2_000_000_000_000n;

const CORE = process.argv[2];
const ESCROW = process.argv[3];
if (!CORE || !ESCROW) throw new Error('usage: seed-demo-case.ts <coreAddress> <escrowAddress>');

const EVIDENCE = [
  { file: 'evidence-1-payer-statement.docx', by: '' as string }, // payer submits
  { file: 'evidence-2-payee-response.docx', by: 'payee' },
];

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

function abiOf(solFile: string, name: string): ethers.InterfaceAbi {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, solFile, `${name}.json`), 'utf8')).abi;
}

const client = createClient(withPolkadotSdkCompat(getWsProvider(WSS)));
const api = client.getTypedApi(paseohub);

async function send(
  signer: PolkadotSigner,
  address: string,
  abi: ethers.InterfaceAbi,
  fn: string,
  args: unknown[],
  valueEvm = 0n,
) {
  const tx = api.tx.Revive.call({
    dest: Binary.fromHex(address as `0x${string}`) as any,
    value: valueEvm / 100_000_000n,
    weight_limit: WEIGHT,
    storage_deposit_limit: CALL_DEPOSIT,
    data: Binary.fromHex(new ethers.Interface(abi).encodeFunctionData(fn, args) as `0x${string}`),
  });
  const r = await tx.signAndSubmit(signer);
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
  return iface.decodeFunctionResult(fn, (r.result.value as any).data.asHex());
}

/** The payee is a derived account, so it starts empty and cannot pay its own fees. */
async function ensureFunded(from: PolkadotSigner, toSs58Addr: string, planck: bigint) {
  const acct = await api.query.System.Account.getValue(toSs58Addr);
  if (acct.data.free >= planck) return acct.data.free;
  const r = await api.tx.Balances.transfer_keep_alive({
    dest: MultiAddress.Id(toSs58Addr),
    value: planck - acct.data.free,
  }).signAndSubmit(from);
  if (!r.ok) throw new Error(`funding ${toSs58Addr} failed: ${JSON.stringify(r.dispatchError)}`);
  return planck;
}

async function main() {
  const payer = account('');
  const payee = account('//payee');
  const coreAbi = abiOf('core/ArbitratorCore.sol', 'ArbitratorCore');
  const escrowAbi = abiOf('examples/SimpleEscrow.sol', 'SimpleEscrow');

  console.log('payer :', payer.h160);
  console.log('payee :', payee.h160, '\n');

  console.log('0. Funding the payee so it can sign its own evidence');
  const funded = await ensureFunded(payer.signer, payee.ss58, 20n * 10_000_000_000n);
  console.log('   payee balance', Number(funded) / 1e10, 'PAS\n');

  console.log('1. Escrow');
  await send(payer.signer, ESCROW, escrowAbi, 'fund', [payee.h160, ''], 20n * PAS_EVM);
  const escrowId = (await read(ESCROW, escrowAbi, 'escrowCount'))[0] as bigint;
  console.log('   escrow', String(escrowId), 'funded with 20 PAS');

  const cost = (await read(CORE, coreAbi, 'arbitrationCost', ['0x']))[0] as bigint;
  await send(payer.signer, ESCROW, escrowAbi, 'dispute', [escrowId], cost);
  const disputeId = (await read(CORE, coreAbi, 'disputeCount'))[0] as bigint;
  console.log('   dispute', String(disputeId), 'raised, prepaid', Number(cost) / 1e18, 'PAS\n');

  console.log('2. Evidence');
  for (const [i, ev] of EVIDENCE.entries()) {
    const bytes = fs.readFileSync(path.join(EVIDENCE_DIR, ev.file));
    const contentHash = '0x' + crypto.createHash('sha256').update(bytes).digest('hex');
    const uri = `/evidence/${ev.file}`;
    const signer = i === 0 ? payer.signer : payee.signer;

    await send(signer, CORE, coreAbi, 'submitEvidence', [disputeId, uri, contentHash, bytes.length]);
    console.log(`   ${ev.file}`);
    console.log(`     uri    ${uri}`);
    console.log(`     sha256 ${contentHash}`);
    console.log(`     bytes  ${bytes.length}`);
  }

  const records = (await read(CORE, coreAbi, 'getEvidence', [disputeId]))[0] as any[];
  console.log(`\n3. Read back from chain: ${records.length} evidence records`);
  for (const r of records) {
    console.log(`   ${r.submitter}  block ${r.submittedAt}  ${r.uri}`);
  }

  console.log('\nDemo case ready.');
  console.log('  core      :', CORE);
  console.log('  escrow    :', ESCROW);
  console.log('  disputeId :', String(disputeId));
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
