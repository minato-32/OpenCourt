/**
 * Deploy getcourt contracts to Paseo Asset Hub Next via PAPI + an sr25519
 * mnemonic signer.
 *
 * WHY PAPI (not hardhat eth-rpc): the funded deployer is an SS58/sr25519 wallet
 * (DEPLOYER_MNEMONIC / DEPLOYER_ADDRESS, funded by the Paseo faucet). eth-rpc
 * deploys sign with a secp256k1 key whose mapped account is different and
 * unfunded, so we instantiate via the substrate `Revive.instantiate_with_code`
 * extrinsic signed by the sr25519 key instead.
 *
 * pallet-revive calling convention (verified against the paseohub metadata docs
 * for `Revive.instantiate_with_code`): `code` is "the contract code to deploy in
 * raw bytes" and `data` is "the input data to pass to the contract constructor".
 * So the PolkaVM blob goes in `code` UNTOUCHED and the abi-encoded constructor
 * args go in `data`. Appending the args to the blob (the older revive pattern
 * copied from p2p-market) makes the PVM parser see trailing garbage and the
 * runtime rejects the deploy with `Revive::CodeRejected`.
 *
 * SETUP (one-time): `pnpm papi:add` generates @polkadot-api/descriptors.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { Binary, createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { entropyToMiniSecret, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';
import { paseohub } from '@polkadot-api/descriptors';

const WSS = process.env.PASEO_ASSET_HUB_WSS || 'wss://paseo-asset-hub-next-rpc.polkadot.io';
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
const ARTIFACTS = path.resolve(__dirname, '../artifacts/contracts');

// Generous fixed limits for testnet; refine with a dry-run once contracts compile.
const GAS_LIMIT: { ref_time: bigint; proof_size: bigint } = { ref_time: 500_000_000_000n, proof_size: 5_000_000n };
const STORAGE_DEPOSIT_LIMIT = 100_000_000_000_000n;

function requireMnemonic(): string {
  if (!MNEMONIC) {
    throw new Error('DEPLOYER_MNEMONIC not set in .env (testnet seed phrase).');
  }
  return MNEMONIC;
}

/** Derive the deployer sr25519 keypair (public key == the 32-byte AccountId32). */
function buildKeypair() {
  const entropy = mnemonicToEntropy(requireMnemonic());
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  return derive(''); // root account (matches the funded DEPLOYER_ADDRESS)
}

/** Build a headless sr25519 signer from the deployer mnemonic. */
function buildSigner() {
  const kp = buildKeypair();
  return getPolkadotSigner(kp.publicKey, 'Sr25519', kp.sign);
}

/**
 * The deployer's EVM (H160) address as pallet-revive sees it. A native substrate
 * AccountId32 (here, the sr25519 public key) maps to H160 via the fallback
 * AccountId32Mapper: keccak256(accountId)[12..32]. Override with TREASURY_ADDRESS
 * if the funded wallet is instead an eth-derived (0xEE-suffixed) account.
 */
function deployerEvmAddress(): string {
  const override = process.env.TREASURY_ADDRESS;
  if (override) return ethers.getAddress(override);
  const pubkey = buildKeypair().publicKey;
  const hash = ethers.keccak256(pubkey); // 0x + 64 hex
  return ethers.getAddress('0x' + hash.slice(-40));
}

/** ArbitratorCore.CourtConfig — a sane single-court demo (odd panel of 3). */
interface CourtConfig {
  minStake: bigint;
  jurorFee: bigint;
  drawThreshold: bigint;
  evidenceBond: bigint;
  evidenceBlocks: bigint;
  activationDelayBlocks: bigint;
  drawDelayBlocks: bigint;
  drawWindowBlocks: bigint;
  commitBlocks: bigint;
  revealBlocks: bigint;
  panelSize: number;
  betaBps: number;
  gammaBps: number;
  thetaBps: number;
  quorumBps: number;
  commitRequired: boolean;
  minPoolWeightMultiple: number;
  quorumFailure: number;
  tieBreak: number;
  defaultChoice: number;
  appFeeBps: number;
  protocolFeeBps: number;
  pinFeeBps: number;
  treasury: string;
  pinner: string;
}

// DENOMINATION (verified on Paseo Asset Hub Next, not assumed): the chain's
// native token has 10 decimals and extrinsic `value` is in planck, but
// pallet-revive hands value to the contract in EVM decimals (1e18). So every
// contract-side amount — minStake, jurorFee, and the arbitrationCost derived
// from them — is written in 1e18 units, while the value actually transferred in
// an extrinsic is that number divided by 1e8. Writing the config in planck makes
// a "100 PAS" stake worth 0.000001 PAS to the contract.
const PAS_EVM = 1_000_000_000_000_000_000n; // contract-side wei per PAS
export const EVM_PER_PLANCK = 100_000_000n; // divide a contract-side amount by this to get planck

function demoCourtConfig(treasury: string): CourtConfig {
  return {
    minStake: 100n * PAS_EVM, // 100 PAS locked per seat (contract-side units)
    jurorFee: 10n * PAS_EVM, // 10 PAS per rewarded seat (app prepays panelSize * this)
    // Demo: near-max threshold so every eligible juror self-selects and the tiny
    // local panel fills first-come. Lower this for real sortition pressure.
    drawThreshold: (1n << 256n) - 1n,
    evidenceBond: 0n, // a non-party files free in these courts
    evidenceBlocks: 10n, // FR-DL-02: the record closes before any draw
    activationDelayBlocks: 1n, // anti just-in-time staking
    drawDelayBlocks: 2n, // Δ before the draw opens (future-blockhash seed)
    drawWindowBlocks: 50n, // window to collect seat claims
    commitBlocks: 50n,
    revealBlocks: 50n,
    panelSize: 3,
    betaBps: 1000, // incoherence slash (10%)
    gammaBps: 2500, // non-reveal slash (25%, >= beta)
    thetaBps: 2000, // treasury cut of the slashed pot (20%)
    quorumBps: 5000, // >= 50% of the panel must reveal
    commitRequired: true, // secret ballot; open voting is opt-in per court
    minPoolWeightMultiple: 0, // demo: no readiness floor
    quorumFailure: 0, // refuse to rule when the panel produces no verdict
    tieBreak: 0,
    defaultChoice: 0,
    appFeeBps: 0, // demo: no app/protocol take -> cost == panelSize * jurorFee
    protocolFeeBps: 0,
    pinFeeBps: 0,
    treasury, // receives the treasury cut (pull)
    pinner: ethers.ZeroAddress, // no pinning take in the demo court
  };
}

/** Read a compiled Hardhat artifact (abi + creation bytecode) by contract name. */
function loadArtifact(solFile: string, contractName: string): { abi: ethers.InterfaceAbi; bytecode: string } {
  const p = path.join(ARTIFACTS, solFile, `${contractName}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Artifact not found: ${p} — run \`pnpm compile\` first.`);
  }
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  // `hardhat test` recompiles for the EVM and overwrites this directory, so a deploy run right
  // after a test run would ship EVM bytecode and fail as EvmConstructorNonEmptyData. Fail loudly.
  if (!String(json.bytecode).startsWith('0x50564d')) {
    throw new Error(
      `${contractName} artifact is not a PolkaVM blob (missing PVM magic). ` +
        'Run `pnpm compile --network paseo` before deploying.',
    );
  }
  return { abi: json.abi, bytecode: json.bytecode };
}

/** abi-encoded constructor args for `data` ('0x' when the constructor takes none). */
function encodeCtorArgs(abi: ethers.InterfaceAbi, args: unknown[]): string {
  const iface = new ethers.Interface(abi);
  const encoded = iface.encodeDeploy(args); // 0x-prefixed, '0x' when no ctor args
  return encoded === '0x' || encoded === '' ? '0x' : encoded;
}

async function instantiate(
  api: any,
  signer: ReturnType<typeof buildSigner>,
  label: string,
  solFile: string,
  contractName: string,
  args: unknown[] = [],
  value: bigint = 0n,
): Promise<string> {
  const { abi, bytecode } = loadArtifact(solFile, contractName);
  const ctorData = encodeCtorArgs(abi, args);

  // salt: unique per deploy so re-deploys don't collide on the CREATE address.
  const salt = Binary.fromHex('0x' + Date.now().toString(16).padStart(64, '0'));

  const tx = api.tx.Revive.instantiate_with_code({
    value,
    // The runtime field is `weight_limit` (a Weight {ref_time, proof_size}), NOT
    // `gas_limit` — confirmed against the generated paseohub descriptor.
    weight_limit: GAS_LIMIT,
    storage_deposit_limit: STORAGE_DEPOSIT_LIMIT,
    code: Binary.fromHex(bytecode), // the PolkaVM blob, untouched
    data: Binary.fromHex(ctorData), // constructor args live HERE, not in `code`
    salt,
  });

  console.log(`Deploying ${label} (${contractName})…`);
  const result = await tx.signAndSubmit(signer);
  if (!result.ok) {
    throw new Error(`${label} deploy failed: ${JSON.stringify(result.dispatchError)}`);
  }
  // The deployed H160 is emitted in the Revive.Instantiated event.
  const ev = result.events.find(
    (e: any) => e.type === 'Revive' && e.value.type === 'Instantiated',
  );
  const address: string = ev?.value?.value?.contract?.asHex?.() ?? ev?.value?.value?.contract;
  if (!address) throw new Error(`${label}: could not read deployed address from events`);
  console.log(`✅ ${label} → ${address}`);
  return address;
}

async function main() {
  const client = createClient(withPolkadotSdkCompat(getWsProvider(WSS)));
  const api = client.getTypedApi(paseohub);
  const signer = buildSigner();
  const treasury = deployerEvmAddress();
  console.log('Deployer EVM (treasury):', treasury);

  // Deploy order:
  //   1. StakeWeightedEligibility()               — open, stake-only court policy (no ctor args)
  //   2. ArbitratorCore(courtConfig, eligibility) — the main protocol contract
  //   3. SimpleEscrow(arbitrator)                 — the example IArbitrable app
  const eligibility = await instantiate(
    api, signer, 'StakeWeightedEligibility',
    'policies/StakeWeightedEligibility.sol', 'StakeWeightedEligibility', [],
  );
  const arbitrator = await instantiate(
    api, signer, 'ArbitratorCore',
    'core/ArbitratorCore.sol', 'ArbitratorCore', [demoCourtConfig(treasury), eligibility, 0],
  );
  const escrow = await instantiate(
    api, signer, 'SimpleEscrow',
    'examples/SimpleEscrow.sol', 'SimpleEscrow', [arbitrator],
  );

  console.log('\nDeployed:');
  console.log('  StakeWeightedEligibility:', eligibility);
  console.log('  ArbitratorCore:          ', arbitrator);
  console.log('  SimpleEscrow:            ', escrow);
  client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
