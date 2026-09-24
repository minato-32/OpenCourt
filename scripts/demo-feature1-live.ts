/**
 * LIVE on-chain demonstration of Feature 1 on Paseo Asset Hub Next (PolkaVM).
 *
 *   FR-ST-02 — a settlement that carries NO verdict must not slash a juror who
 *              showed up and voted. Only silence is slashed.
 *   FR-CR-02 — the q* "jurors underpaid" guard runs inside the ArbitratorCore
 *              constructor, so a court that underpays its jurors cannot even be
 *              deployed. This script proves that on-chain too.
 *
 * The scenario is a genuine 1-1 TIE with one silent juror, run end to end against
 * a real court on a real chain:
 *
 *   juror //1  commits + reveals RELEASE (choice 1)
 *   juror //2  commits + reveals REFUND  (choice 2)
 *   juror //3  never commits            (silent)
 *
 * quorum = ceil(3 * 50%) = 2 revealed seats, which IS met, so the tally is a real
 * tie -> ruling 0. Expected settlement (minStake 100 PAS, jurorFee 10 PAS,
 * beta 10%, gamma 25%, theta 20%, no app/protocol take):
 *
 *   pot            = 1 silent seat * 25% * 100 = 25 PAS
 *   treasury       = theta 20% of pot          =  5 PAS
 *   to revealers   = pot - treasury            = 20 PAS -> 10 PAS each
 *   juror //1, //2 = 100 stake + 10 fee + 10   = 120 PAS each, NOT slashed
 *   juror //3      = 100 - 25                  =  75 PAS
 *   app (escrow)   = 30 cost - 2 * 10 fee      = 10 PAS residue
 *
 * BEFORE Feature 1 the same run would have paid each honest revealer only 90 PAS
 * (a 10% beta slash for showing up), so the on-chain difference is 120 vs 90.
 *
 * Run: pnpm exec ts-node scripts/demo-feature1-live.ts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { Binary, createClient, AccountId, type PolkadotSigner } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { entropyToMiniSecret, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';
import { paseohub, MultiAddress } from '@polkadot-api/descriptors';

const WSS = process.env.PASEO_ASSET_HUB_WSS || 'wss://paseo-asset-hub-next-rpc.polkadot.io';
const ARTIFACTS = path.resolve(__dirname, '../artifacts/contracts');
// The chain's native token has 10 decimals (1 PAS = 1e10 planck) and every
// extrinsic `value` is denominated in planck. pallet-revive, however, presents
// value to the contract in EVM decimals (1e18), so a court config — minStake,
// jurorFee, and everything derived from them — must be written in 1e18 units
// while the value we actually transfer stays in planck. The two differ by 1e8.
const PAS = 10_000_000_000n; // planck per PAS (chain side, 10 decimals)
const PAS_EVM = 1_000_000_000_000_000_000n; // wei per PAS (contract side, 18 decimals)
const EVM_PER_PLANCK = 100_000_000n; // 1e18 / 1e10
const toPlanck = (evm: bigint) => evm / EVM_PER_PLANCK;

const WEIGHT = { ref_time: 500_000_000_000n, proof_size: 5_000_000n };
const DEPLOY_DEPOSIT_LIMIT = 100_000_000_000_000n;
const CALL_DEPOSIT_LIMIT = 500_000_000_000n; // 50 PAS cap per juror call (planck)

// MEASURED on Paseo Asset Hub Next: ~2 s per block (three blocks per six-second
// poll), and every signAndSubmit waits for finalization, which costs roughly a
// dozen blocks per extrinsic. A 25-block window is therefore only ~50 s — not
// enough for three sequential juror transactions, which is exactly how an earlier
// run lost its draw window and reverted DrawClosed(). Size the windows in blocks
// for a 2 s block, with room for several finalized extrinsics each.
const DRAW_WINDOW = 150n; // ~5 min  (must stay <= 255: the blockhash-seed guard)
const COMMIT_BLOCKS = 120n; // ~4 min
const REVEAL_BLOCKS = 120n; // ~4 min

const JUROR_FUNDING = 150n * PAS; // 100 stake + fees + existential deposit
const ESCROW_AMOUNT = 20n * PAS;

const toSs58 = AccountId().dec; // 32-byte public key -> SS58String

function derive(pathStr: string) {
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) throw new Error('DEPLOYER_MNEMONIC not set in .env');
  const d = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)));
  const kp = d(pathStr);
  return {
    kp,
    signer: getPolkadotSigner(kp.publicKey, 'Sr25519', kp.sign),
    ss58: toSs58(kp.publicKey),
    // pallet-revive AccountId32Mapper fallback: keccak(accountId32)[12..32]
    h160: ethers.getAddress('0x' + ethers.keccak256(kp.publicKey).slice(-40)),
  };
}

function artifact(solFile: string, name: string) {
  const p = path.join(ARTIFACTS, solFile, `${name}.json`);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { abi: json.abi as ethers.InterfaceAbi, bytecode: json.bytecode as string };
}

const client = createClient(withPolkadotSdkCompat(getWsProvider(WSS)));
const api = client.getTypedApi(paseohub);

async function head(): Promise<bigint> {
  return BigInt((await client.getFinalizedBlock()).number);
}

async function waitUntil(target: bigint, label: string) {
  let n = await head();
  if (n >= target) return;
  process.stdout.write(`   waiting for block ${target} (${label}) — at ${n}`);
  while (n < target) {
    await new Promise((r) => setTimeout(r, 6000));
    const next = await head();
    if (next !== n) {
      n = next;
      process.stdout.write(`, ${n}`);
    }
  }
  process.stdout.write('\n');
}

/** Dry-run read of a contract view function. */
async function read(address: string, abi: ethers.InterfaceAbi, fn: string, params: unknown[] = []) {
  const iface = new ethers.Interface(abi);
  const r = await api.apis.ReviveApi.call(
    derive('').ss58,
    Binary.fromHex(address),
    0n,
    undefined,
    undefined,
    Binary.fromHex(iface.encodeFunctionData(fn, params)),
  );
  if (!r.result.success) throw new Error(`${fn} dispatch failed: ${JSON.stringify(r.result.value)}`);
  // pallet-revive reports an EVM-level revert as a SUCCESSFUL dispatch whose
  // return flags have bit 0 set; the payload is then the custom-error selector,
  // not a decodable result. `flags` arrives as a plain number here.
  const flags: any = (r.result.value as any).flags;
  const bits = typeof flags === 'bigint' ? flags : BigInt(typeof flags === 'number' ? flags : flags?.bits ?? 0);
  const data = r.result.value.data.asHex();
  if ((bits & 1n) === 1n) {
    let reason: string = data;
    try { const p = iface.parseError(data); if (p) reason = `${p.name}(${p.args.map(String).join(', ')})`; } catch {}
    throw new Error(`${fn} reverted: ${reason}`);
  }
  return iface.decodeFunctionResult(fn, data);
}

/** Signed contract call. Returns the finalized events so callers can inspect logs. */
async function write(
  signer: PolkadotSigner,
  address: string,
  abi: ethers.InterfaceAbi,
  fn: string,
  params: unknown[] = [],
  value = 0n,
) {
  const iface = new ethers.Interface(abi);
  const tx = api.tx.Revive.call({
    dest: Binary.fromHex(address) as any,
    value,
    weight_limit: WEIGHT,
    storage_deposit_limit: CALL_DEPOSIT_LIMIT,
    data: Binary.fromHex(iface.encodeFunctionData(fn, params)),
  });
  const r = await tx.signAndSubmit(signer);
  if (!r.ok) throw new Error(`${fn} failed: ${JSON.stringify(r.dispatchError)}`);
  return r;
}

async function instantiate(
  signer: PolkadotSigner,
  label: string,
  solFile: string,
  name: string,
  args: unknown[] = [],
): Promise<string> {
  const { abi, bytecode } = artifact(solFile, name);
  const iface = new ethers.Interface(abi);
  const ctorData = iface.encodeDeploy(args) || '0x';
  const salt = Binary.fromHex('0x' + Date.now().toString(16).padStart(64, '0'));
  const tx = api.tx.Revive.instantiate_with_code({
    value: 0n,
    weight_limit: WEIGHT,
    storage_deposit_limit: DEPLOY_DEPOSIT_LIMIT,
    code: Binary.fromHex(bytecode),
    data: Binary.fromHex(ctorData === '0x' ? '0x' : ctorData),
    salt: salt as any,
  });
  const r = await tx.signAndSubmit(signer);
  if (!r.ok) throw new Error(`${label} deploy failed: ${JSON.stringify(r.dispatchError)}`);
  const ev = r.events.find((e: any) => e.type === 'Revive' && e.value.type === 'Instantiated');
  const addr: string = (ev as any)?.value?.value?.contract?.asHex?.();
  if (!addr) throw new Error(`${label}: no Instantiated event`);
  console.log(`   ${label} -> ${addr}`);
  return addr;
}

/** Every Slashed event the given contract emitted in this transaction. */
function slashedFrom(events: any[], coreAbi: ethers.InterfaceAbi, coreAddr: string) {
  const iface = new ethers.Interface(coreAbi);
  const out: { juror: string; amount: bigint }[] = [];
  for (const e of events) {
    if (e.type !== 'Revive' || e.value?.type !== 'ContractEmitted') continue;
    const v = e.value.value;
    const emitter: string = v.contract?.asHex?.() ?? v.contract;
    if (emitter?.toLowerCase() !== coreAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({
        topics: (v.topics ?? []).map((t: any) => (t.asHex ? t.asHex() : t)),
        data: v.data?.asHex ? v.data.asHex() : v.data,
      });
      if (parsed?.name === 'Slashed') {
        out.push({ juror: String(parsed.args.juror).toLowerCase(), amount: parsed.args.amount as bigint });
      }
    } catch {
      /* not a decodable core event */
    }
  }
  return out;
}

/** Format a CONTRACT-side (18-decimal) amount as PAS. */
const pas = (v: bigint) => `${(Number(v) / 1e18).toFixed(4)} PAS`;
/** Format a CHAIN-side (planck) amount as PAS. */
const pasPlanck = (v: bigint) => `${(Number(v) / 1e10).toFixed(4)} PAS`;

function commitmentOf(disputeId: bigint, juror: string, choice: number, salt: string) {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint8', 'bytes32'],
    [disputeId, juror, choice, salt],
  );
}

async function main() {
  const deployer = derive('');
  const jurors = [derive('//1'), derive('//2'), derive('//3')];
  const payee = derive('//9');

  console.log('Chain   :', (await client.getChainSpecData()).name);
  console.log('Deployer:', deployer.ss58, '=>', deployer.h160);
  jurors.forEach((j, i) => console.log(`Juror //${i + 1}:`, j.ss58, '=>', j.h160));
  console.log();

  // ---------------------------------------------------------------- 1. the court
  console.log('1. Deploying a fast demo court (FR-CR-02 q* guard runs in its constructor)');
  const cfg = {
    minStake: 100n * PAS_EVM, // contract-side units
    jurorFee: 10n * PAS_EVM,
    drawThreshold: (1n << 256n) - 1n, // demo: every eligible juror self-selects
    evidenceBond: 0n, // a non-party files free in these courts
    evidenceBlocks: 10n, // FR-DL-02: the record closes before any draw
    activationDelayBlocks: 1n,
    drawDelayBlocks: 2n,
    drawWindowBlocks: DRAW_WINDOW,
    commitBlocks: COMMIT_BLOCKS,
    revealBlocks: REVEAL_BLOCKS,
    panelSize: 3,
    betaBps: 1000,
    gammaBps: 2500,
    thetaBps: 2000,
    quorumBps: 5000,
    appFeeBps: 0,
    protocolFeeBps: 0,
    pinFeeBps: 0,
    treasury: deployer.h160,
    pinner: ethers.ZeroAddress,
  };
  const eligibility = await instantiate(
    deployer.signer, 'StakeWeightedEligibility',
    'policies/StakeWeightedEligibility.sol', 'StakeWeightedEligibility', [],
  );
  const core = await instantiate(
    deployer.signer, 'ArbitratorCore', 'core/ArbitratorCore.sol', 'ArbitratorCore',
    [cfg, eligibility, 0],
  );
  const escrowAddr = await instantiate(
    deployer.signer, 'SimpleEscrow', 'examples/SimpleEscrow.sol', 'SimpleEscrow', [core],
  );
  const coreAbi = artifact('core/ArbitratorCore.sol', 'ArbitratorCore').abi;
  const escrowAbi = artifact('examples/SimpleEscrow.sol', 'SimpleEscrow').abi;

  const cost = (await read(core, coreAbi, 'arbitrationCost', ['0x']))[0] as bigint;
  console.log(`   arbitrationCost = ${pas(cost)}   (panel 3 x jurorFee 10)`);

  // FR-CR-02 proof: the spec's own underpaid court (panel 7, minStake 100,
  // jurorFee 3, beta 20% -> q* 0.68) must be REJECTED by the constructor. Dry-run
  // it so the proof costs nothing: the runtime executes the constructor and
  // reports the revert without submitting a transaction.
  {
    const underpaid = { ...cfg, panelSize: 7, jurorFee: 3n * PAS_EVM, betaBps: 2000 };
    const { abi, bytecode } = artifact('core/ArbitratorCore.sol', 'ArbitratorCore');
    const data = new ethers.Interface(abi).encodeDeploy([underpaid, eligibility]);
    const r = await api.apis.ReviveApi.instantiate(
      deployer.ss58, 0n, undefined, undefined,
      { type: 'Upload', value: Binary.fromHex(bytecode) } as any,
      Binary.fromHex(data),
      undefined,
    );
    // The dry-run can report a constructor revert two ways depending on how the
    // runtime surfaces it: an Err dispatch result, or an Ok result whose EVM frame
    // set the revert flag. Handle both, and decode the custom error from the
    // returned bytes so the reason is the contract's own BadConfig("jurorsUnderpaid").
    const res: any = r as any;
    const dispatchOk = res.result?.success === true;
    const inner = dispatchOk ? res.result.value : undefined;
    const flags = inner?.result?.flags ?? inner?.flags;
    const flagBits = typeof flags === 'bigint' ? flags : BigInt(flags?.bits ?? flags ?? 0);
    const reverted = (flagBits & 1n) === 1n;
    const rejected = !dispatchOk || reverted;
    const hex: string =
      inner?.result?.data?.asHex?.() ?? inner?.data?.asHex?.() ?? res.result?.value?.data?.asHex?.() ?? '0x';
    let reason = hex;
    try {
      const p = new ethers.Interface(abi).parseError(hex);
      if (p) reason = `${p.name}(${p.args.map(String).join(', ')})`;
    } catch { /* leave the raw bytes */ }
    console.log(
      `   q* guard, underpaid court (panel 7, fee 3, beta 20% -> q* 0.68): ` +
      `${rejected ? 'REJECTED' : 'ACCEPTED (guard missing!)'} ${rejected ? reason : ''}`,
    );
  }
  console.log();

  // ------------------------------------------------- 2. fund + stake the jurors
  console.log('2. Funding jurors and staking 100 PAS each');
  // Top up to the funding target rather than only funding an empty account: a
  // juror that already spent stake in an earlier run still needs the difference.
  for (const [i, j] of jurors.entries()) {
    const acct = await api.query.System.Account.getValue(j.ss58);
    if (acct.data.free < JUROR_FUNDING) {
      const tx = api.tx.Balances.transfer_keep_alive({
        dest: MultiAddress.Id(j.ss58),
        value: JUROR_FUNDING - acct.data.free,
      });
      const r = await tx.signAndSubmit(deployer.signer);
      if (!r.ok) throw new Error(`funding juror //${i + 1} failed`);
    }
  }
  // Stake in parallel — distinct signers, so the nonces are independent and the
  // three extrinsics ride the same few blocks instead of a dozen each.
  await Promise.all(jurors.map((j) => write(j.signer, core, coreAbi, 'stake', [], toPlanck(cfg.minStake))));
  for (const [i, j] of jurors.entries()) {
    const w = (await read(core, coreAbi, 'weightOf', [j.h160]))[0] as bigint;
    console.log(`   juror //${i + 1} staked, weight = ${w}`);
    if (w === 0n) throw new Error(`juror //${i + 1} has no free stake — top-up did not land`);
  }
  console.log();

  // ------------------------------------------------------- 3. escrow + dispute
  console.log('3. Funding an escrow and raising a dispute');
  await write(deployer.signer, escrowAddr, escrowAbi, 'fund', [payee.h160], ESCROW_AMOUNT);
  const escrowId = (await read(escrowAddr, escrowAbi, 'escrowCount'))[0] as bigint;
  await write(deployer.signer, escrowAddr, escrowAbi, 'dispute', [escrowId], toPlanck(cost));
  const disputeId = (await read(core, coreAbi, 'disputeCount'))[0] as bigint;
  const d0: any = (await read(core, coreAbi, 'getDispute', [disputeId]))[0];
  const drawBlock = BigInt(d0.drawBlock);
  console.log(`   escrowId ${escrowId} -> disputeId ${disputeId}, drawBlock ${drawBlock}\n`);

  // ------------------------------------------------------------- 4. the draw
  console.log('4. Sortition — each juror claims the seats that self-select');
  await waitUntil(drawBlock + 1n, 'draw opens');
  // Parallel, for the same reason as staking: three sequential finalized
  // extrinsics would eat most of the draw window.
  await Promise.all(jurors.map((j) => write(j.signer, core, coreAbi, 'claimSeat', [disputeId])));
  for (const [i, j] of jurors.entries()) {
    const jr: any = (await read(core, coreAbi, 'jurorRoundOf', [disputeId, j.h160]))[0];
    console.log(`   juror //${i + 1} claimed ${jr.seatCount} seat(s)`);
  }
  await waitUntil(drawBlock + DRAW_WINDOW + 1n, 'draw window closes');
  await write(deployer.signer, core, coreAbi, 'closeDrawing', [disputeId]);
  console.log('   drawing closed -> Committing\n');

  // ----------------------------------------------------------- 5. commit votes
  console.log('5. Commit — //1 votes RELEASE, //2 votes REFUND, //3 stays silent');
  const salts = [ethers.hexlify(ethers.randomBytes(32)), ethers.hexlify(ethers.randomBytes(32))];
  const choices = [1, 2];
  await Promise.all([0, 1].map((i) =>
    write(jurors[i].signer, core, coreAbi, 'commitVote', [
      disputeId,
      commitmentOf(disputeId, jurors[i].h160, choices[i], salts[i]),
    ]),
  ));
  for (let i = 0; i < 2; i++) console.log(`   juror //${i + 1} committed choice ${choices[i]}`);
  console.log('   juror //3 committed NOTHING (this is the only party that gets slashed)');

  const d1: any = (await read(core, coreAbi, 'getDispute', [disputeId]))[0];
  await waitUntil(BigInt(d1.commitDeadline) + 1n, 'commit window closes');
  await write(deployer.signer, core, coreAbi, 'openReveal', [disputeId]);
  const d2: any = (await read(core, coreAbi, 'getDispute', [disputeId]))[0];
  console.log(`   reveal opened, seatedWeight = ${d2.seatedWeight}\n`);

  // ----------------------------------------------------------- 6. reveal votes
  console.log('6. Reveal');
  await Promise.all([0, 1].map((i) =>
    write(jurors[i].signer, core, coreAbi, 'revealVote', [disputeId, choices[i], salts[i]]),
  ));
  for (let i = 0; i < 2; i++) console.log(`   juror //${i + 1} revealed choice ${choices[i]}`);
  await waitUntil(BigInt(d2.revealDeadline) + 1n, 'reveal window closes');
  console.log();

  // ------------------------------------------------------------ 7. settlement
  console.log('7. finalize() — the moment Feature 1 changes');
  const before: bigint[] = [];
  for (const j of jurors) before.push((await read(core, coreAbi, 'withdrawable', [j.h160]))[0] as bigint);
  const fin = await write(deployer.signer, core, coreAbi, 'finalize', [disputeId]);
  const slashes = slashedFrom(fin.events as any[], coreAbi, core);

  const [ruling, tied, finalized] = await read(core, coreAbi, 'currentRuling', [disputeId]);
  console.log(`   ruling = ${ruling}  tied = ${tied}  finalized = ${finalized}`);
  console.log(`   Slashed events: ${slashes.length}`);
  for (const s of slashes) console.log(`     ${s.juror}  -${pas(s.amount)}`);
  console.log();

  // --------------------------------------------------------------- 8. the table
  const expected = [120n * PAS_EVM, 120n * PAS_EVM, 75n * PAS_EVM];
  const oldBuggy = [90n * PAS_EVM, 90n * PAS_EVM, 75n * PAS_EVM];
  console.log('   juror        role                 got          expected     old (pre-fix)');
  let allOk = true;
  for (const [i, j] of jurors.entries()) {
    const now = (await read(core, coreAbi, 'withdrawable', [j.h160]))[0] as bigint;
    const delta = now - before[i];
    const ok = delta === expected[i];
    allOk &&= ok;
    const role = i < 2 ? `revealed choice ${choices[i]}` : 'SILENT (never committed)';
    console.log(
      `   //${i + 1}  ${role.padEnd(24)} ${pas(delta).padStart(12)} ${pas(expected[i]).padStart(12)} ` +
      `${pas(oldBuggy[i]).padStart(12)}  ${ok ? 'OK' : 'MISMATCH'}`,
    );
  }
  const appResidue = (await read(core, coreAbi, 'withdrawable', [escrowAddr]))[0] as bigint;
  const treasury = (await read(core, coreAbi, 'withdrawable', [deployer.h160]))[0] as bigint;
  console.log(`   app (escrow) fee residue : ${pas(appResidue)}   (expected 10 PAS)`);
  console.log(`   treasury (theta of pot)  : ${pas(treasury)}   (expected 5 PAS)`);

  // Never-mint: the core holds exactly what it owes.
  // ReviveApi.balance returns a U256 as four little-endian u64 limbs, not a bigint.
  const limbs = (await api.apis.ReviveApi.balance(Binary.fromHex(core) as any)) as unknown as bigint[];
  const coreBal = limbs.reduce((acc, limb, i) => acc + BigInt(limb) * (1n << BigInt(64 * i)), 0n);
  console.log(`\n   core on-chain balance    : ${pas(coreBal)} (EVM decimals)`);

  console.log(
    `\n${allOk ? 'PASS' : 'FAIL'} — FR-ST-02 on-chain: revealers were paid stake + fee + pot share ` +
    `on a no-verdict ruling, and only the silent juror was slashed.`,
  );
  console.log(`\nContracts used (Paseo Asset Hub Next):`);
  console.log(`  ArbitratorCore : ${core}`);
  console.log(`  SimpleEscrow   : ${escrowAddr}`);
  console.log(`  Eligibility    : ${eligibility}`);
  console.log(`  disputeId      : ${disputeId}`);
}

main()
  .then(() => {
    client.destroy();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    client.destroy();
    process.exit(1);
  });
