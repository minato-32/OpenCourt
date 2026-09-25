/**
 * Drive one case end to end on a deployed court: three jurors stake, claim seats, commit, reveal,
 * and the dispute settles with a real verdict.
 *
 * Jurors are derived from the deployer seed (//j1, //j2 and the root). On a personhood-gated court
 * the deployer is the registry issuer, so the script attests them first — that is the gate doing
 * its job, not a bypass: an unattested account is refused a seat.
 *
 * Votes are 1, 1, 2 so the panel reaches a real majority and the dissenter takes the beta slash.
 * The tie path is already covered by demo-feature1-live.ts.
 *
 * Usage: ts-node scripts/run-case.ts <core> <escrow> [registry] [disputeId to resume]
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
const PAS_PLANCK = 10_000_000_000n;
const WEIGHT = { ref_time: 500_000_000_000n, proof_size: 5_000_000n };
const CALL_DEPOSIT = 2_000_000_000_000n;

const CORE = process.argv[2];
const ESCROW = process.argv[3];
const REGISTRY = process.argv[4];
/** Pass a dispute id to resume an interrupted run instead of opening a new case. */
const RESUME_ID = process.argv[5] ? BigInt(process.argv[5]) : null;
if (!CORE || !ESCROW) throw new Error('usage: run-case.ts <core> <escrow> [registry] [disputeId]');

/** Two votes for release, one for refund: a real majority with a real dissenter. */
const VOTES = [1, 1, 2];

const toSs58 = AccountId().dec;

function account(derivation: string) {
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) throw new Error('DEPLOYER_MNEMONIC not set');
  const kp = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)))(derivation);
  return {
    label: derivation || 'root',
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
const coreAbi = abiOf('core/ArbitratorCore.sol', 'ArbitratorCore');
const escrowAbi = abiOf('examples/SimpleEscrow.sol', 'SimpleEscrow');
const regAbi = abiOf('policies/PersonhoodRegistry.sol', 'PersonhoodRegistry');

/**
 * Submit a call, rebuilding it on each attempt.
 *
 * A long phase wait idles the websocket until the node drops it. After the reconnect a transaction
 * built earlier is signed against chain state that no longer applies and the node rejects it as
 * BadProof. Rebuilding from scratch on retry is the fix; the same applies to a plain disconnect.
 */
async function send(
  signer: PolkadotSigner,
  address: string,
  abi: ethers.InterfaceAbi,
  fn: string,
  args: unknown[],
  valueEvm = 0n,
  attempts = 3,
) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
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
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const transient = /BadProof|Invalid|halt|Terminate|disconnect|WebSocket|timeout/i.test(msg);
      if (!transient || attempt === attempts) throw e;
      console.log(`   ${fn}: ${msg.slice(0, 60)} — retrying (${attempt}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  throw lastErr;
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
  const flags = typeof v?.flags === 'number' ? v.flags : 0;
  if (flags & 1) {
    let reason: string = v.data.asHex();
    try {
      const p = iface.parseError(reason);
      if (p) reason = p.name;
    } catch { /* raw bytes */ }
    throw new Error(`${fn} reverted: ${reason}`);
  }
  return iface.decodeFunctionResult(fn, v.data.asHex());
}

const head = async () => BigInt((await client.getFinalizedBlock()).number);

async function waitFor(target: bigint, what: string) {
  let n = await head();
  if (n >= target) return;
  process.stdout.write(`   waiting to block ${target} (${what}) — at ${n}`);
  while (n < target) {
    await new Promise((r) => setTimeout(r, 6000));
    try {
      const next = await head();
      if (next !== n) {
        n = next;
        process.stdout.write(`, ${n}`);
      }
    } catch {
      // The socket dropped mid-wait; the next poll reconnects.
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');
}

async function fund(from: PolkadotSigner, ss58: string, planck: bigint) {
  const acct = await api.query.System.Account.getValue(ss58);
  if (acct.data.free >= planck) return;
  const r = await api.tx.Balances.transfer_keep_alive({
    dest: MultiAddress.Id(ss58),
    value: planck - acct.data.free,
  }).signAndSubmit(from);
  if (!r.ok) throw new Error(`funding failed: ${JSON.stringify(r.dispatchError)}`);
}

const commitmentOf = (id: bigint, juror: string, choice: number, salt: string) =>
  ethers.solidityPackedKeccak256(['uint256', 'address', 'uint8', 'bytes32'], [id, juror, choice, salt]);

const STATE = ['None', 'Evidence', 'Drawing', 'Committing', 'Revealing', 'Resolved'] as const;

/** Deterministic salt per juror, so a resumed run can still reveal what an earlier run committed. */
const saltFor = (id: bigint, juror: string) =>
  ethers.keccak256(ethers.toUtf8Bytes(`getcourt-demo-salt:${id}:${juror.toLowerCase()}`));

async function main() {
  const issuer = account('');
  const jurors = [issuer, account('//j1'), account('//j2')];
  const payee = account('//payee');

  // Read the struct BY NAME. Positional indices silently pointed at the wrong fields every time
  // CourtConfig gained one — drawWindowBlocks became activationDelayBlocks, panelSize became
  // commitBlocks — and the runner then cranked closeDrawing far too early.
  const cfg: any = (await read(CORE, coreAbi, 'config')) as any;
  const minStake = cfg.minStake as bigint;
  const drawWindow = cfg.drawWindowBlocks as bigint;
  const panelSize = Number(cfg.panelSize);
  console.log('court', CORE, '· minStake', Number(minStake) / 1e18, 'PAS · panel', panelSize);

  console.log('\n1. Jurors');
  for (const j of jurors) {
    await fund(issuer.signer, j.ss58, 160n * PAS_PLANCK);
    if (REGISTRY) {
      const verified = (await read(REGISTRY, regAbi, 'isVerified', [j.h160]))[0] as boolean;
      if (!verified) {
        await send(issuer.signer, REGISTRY, regAbi, 'attest', [j.h160, ethers.id(`getcourt-juror-${j.label}`)]);
      }
    }
    const weight = (await read(CORE, coreAbi, 'weightOf', [j.h160]))[0] as bigint;
    const round = RESUME_ID ? ((await read(CORE, coreAbi, 'jurorRoundOf', [RESUME_ID, j.h160]))[0] as any) : null;
    const seated = round ? Number(round.seatCount) > 0 : false;
    if (weight === 0n && !seated) await send(j.signer, CORE, coreAbi, 'stake', [], minStake);
    const w = (await read(CORE, coreAbi, 'weightOf', [j.h160]))[0] as bigint;
    console.log(`   ${j.label.padEnd(8)} ${j.h160} weight ${w}${seated ? ' · already seated' : ''}`);
  }

  let id: bigint;
  if (RESUME_ID) {
    id = RESUME_ID;
    console.log(`\n2. Resuming dispute ${id}`);
  } else {
    console.log('\n2. Case');
    await fund(issuer.signer, payee.ss58, 20n * PAS_PLANCK);
    await send(issuer.signer, ESCROW, escrowAbi, 'fund', [payee.h160, ''], 20n * PAS_EVM);
    const escrowId = (await read(ESCROW, escrowAbi, 'escrowCount'))[0] as bigint;
    const cost = (await read(CORE, coreAbi, 'arbitrationCost', ['0x']))[0] as bigint;
    await send(issuer.signer, ESCROW, escrowAbi, 'dispute', [escrowId], cost);
    id = (await read(CORE, coreAbi, 'disputeCount'))[0] as bigint;
    console.log(`   escrow ${escrowId} -> dispute ${id}`);

    for (const [i, file] of ['evidence-1-payer-statement.docx', 'evidence-2-payee-response.docx'].entries()) {
      const bytes = fs.readFileSync(path.join(EVIDENCE_DIR, file));
      const hash = '0x' + crypto.createHash('sha256').update(bytes).digest('hex');
      await send(i === 0 ? issuer.signer : payee.signer, CORE, coreAbi, 'submitEvidence', [
        id,
        `/evidence/${file}`,
        hash,
        bytes.length,
      ]);
      console.log(`   evidence ${i + 1} attached (${file})`);
    }
  }

  // Phase-driven so a run interrupted by a dropped socket can be restarted with the dispute id and
  // pick up exactly where it stopped.
  for (;;) {
    const d: any = (await read(CORE, coreAbi, 'getDispute', [id]))[0];
    const state = Number(d.state);
    console.log(`\n-- ${STATE[state]} (seats ${d.seatCount}, revealed ${d.revealedCount})`);

    if (state === 5) {
      const [ruling, tied] = await read(CORE, coreAbi, 'currentRuling', [id]);
      console.log(`   ruling ${ruling} · tied ${tied}`);
      const pas = (v: bigint) => `${(Number(v) / 1e18).toFixed(2)} PAS`;
      for (const [i, j] of jurors.entries()) {
        const paid = (await read(CORE, coreAbi, 'withdrawable', [j.h160]))[0] as bigint;
        const round: any = (await read(CORE, coreAbi, 'jurorRoundOf', [id, j.h160]))[0];
        const voted = round.revealed ? Number(round.choice) : null;
        const line =
          voted === null
            ? 'never revealed'
            : voted === Number(ruling)
              ? 'with the majority'
              : 'against the majority';
        console.log(`   ${j.label.padEnd(8)} voted ${voted ?? '-'} · ${line} · withdrawable ${pas(paid)}`);
      }
      break;
    }

    if (state === 1) {
      // The record is open; close it once its window lapses. Only then is the draw block set.
      await waitFor(BigInt(d.evidenceDeadline) + 1n, 'evidence window closes');
      await send(issuer.signer, CORE, coreAbi, 'openDrawing', [id]);
      console.log('   record frozen, draw opened');
      continue;
    }

    if (state === 2) {
      const drawBlock = BigInt(d.drawBlock);
      if (Number(d.seatCount) < panelSize) {
        await waitFor(drawBlock + 1n, 'draw opens');
        for (const j of jurors) {
          const round: any = (await read(CORE, coreAbi, 'jurorRoundOf', [id, j.h160]))[0];
          if (Number(round.seatCount) > 0) continue;
          try {
            await send(j.signer, CORE, coreAbi, 'claimSeat', [id]);
            console.log(`   ${j.label} claimed a seat`);
          } catch (e: any) {
            console.log(`   ${j.label} could not claim: ${String(e.message).slice(0, 70)}`);
          }
        }
      }
      await waitFor(drawBlock + drawWindow + 1n, 'draw window closes');
      await send(issuer.signer, CORE, coreAbi, 'closeDrawing', [id]);
      console.log('   drawing closed');
      continue;
    }

    if (state === 3) {
      for (const [i, j] of jurors.entries()) {
        const round: any = (await read(CORE, coreAbi, 'jurorRoundOf', [id, j.h160]))[0];
        if (round.committed) continue;
        await send(j.signer, CORE, coreAbi, 'commitVote', [
          id,
          commitmentOf(id, j.h160, VOTES[i], saltFor(id, j.h160)),
        ]);
        console.log(`   ${j.label.padEnd(8)} committed choice ${VOTES[i]}`);
      }
      await waitFor(BigInt(d.commitDeadline) + 1n, 'commit window closes');
      await send(issuer.signer, CORE, coreAbi, 'openReveal', [id]);
      console.log('   reveal opened');
      continue;
    }

    if (state === 4) {
      for (const [i, j] of jurors.entries()) {
        const round: any = (await read(CORE, coreAbi, 'jurorRoundOf', [id, j.h160]))[0];
        if (round.revealed || Number(round.dutySeats) === 0) continue;
        await send(j.signer, CORE, coreAbi, 'revealVote', [id, VOTES[i], saltFor(id, j.h160)]);
        console.log(`   ${j.label.padEnd(8)} revealed ${VOTES[i]}`);
      }
      await waitFor(BigInt(d.revealDeadline) + 1n, 'reveal window closes');
      await send(issuer.signer, CORE, coreAbi, 'finalize', [id]);
      console.log('   finalized');
      continue;
    }

    throw new Error(`unexpected state ${state}`);
  }

  console.log('\nCase settled.');
  console.log('  core      :', CORE);
  console.log('  disputeId :', String(id));
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
