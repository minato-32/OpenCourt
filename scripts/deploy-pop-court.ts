/**
 * Deploy the PoP-GATED court variant to Paseo Asset Hub Next.
 *
 * Identical harness to scripts/deploy.ts, but swaps the eligibility policy:
 * instead of the open StakeWeightedEligibility, it deploys PopGatedEligibility
 * bound to an already-deployed ZKPassportRegistry (ZKPASSPORT_REGISTRY_ADDRESS).
 * That turns jury capture from "buy more stake" into "acquire more people".
 *
 * SETUP (one-time): generate the typed descriptor for Asset Hub Next:
 *   pnpm papi add paseohub -w wss://paseo-asset-hub-next-rpc.polkadot.io
 * then `import { paseohub } from "@polkadot-api/descriptors"`.
 * Until the descriptor exists this file will not type-check — that is expected
 * pre-`papi add`.
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
// After `papi add paseohub`:  import { paseohub } from '@polkadot-api/descriptors';

const WSS = process.env.PASEO_ASSET_HUB_WSS || 'wss://paseo-asset-hub-next-rpc.polkadot.io';
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
const ARTIFACTS = path.resolve(__dirname, '../artifacts/contracts');

const GAS_LIMIT = { ref_time: 500_000_000_000n, proof_size: 5_000_000n };
const STORAGE_DEPOSIT_LIMIT = 100_000_000_000_000n;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} not set in .env`);
  return value;
}

function buildKeypair() {
  const entropy = mnemonicToEntropy(requireEnv('DEPLOYER_MNEMONIC', MNEMONIC));
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  return derive('');
}

function buildSigner() {
  const kp = buildKeypair();
  return getPolkadotSigner(kp.publicKey, 'Sr25519', kp.sign);
}

/** pallet-revive AccountId32Mapper fallback: keccak256(accountId)[12..32]. */
function deployerEvmAddress(): string {
  const override = process.env.TREASURY_ADDRESS;
  if (override) return ethers.getAddress(override);
  const hash = ethers.keccak256(buildKeypair().publicKey);
  return ethers.getAddress('0x' + hash.slice(-40));
}

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
  appFeeBps: number;
  protocolFeeBps: number;
  treasury: string;
}

function demoCourtConfig(treasury: string): CourtConfig {
  return {
    minStake: 1_000_000_000_000n,
    jurorFee: 100_000_000_000n,
    drawThreshold: (1n << 256n) - 1n,
    evidenceBond: 0n, // a non-party files free in these courts
    evidenceBlocks: 10n, // FR-DL-02: the record closes before any draw
    activationDelayBlocks: 1n,
    drawDelayBlocks: 2n,
    drawWindowBlocks: 50n,
    commitBlocks: 50n,
    revealBlocks: 50n,
    panelSize: 3,
    betaBps: 1000,
    gammaBps: 2500,
    thetaBps: 2000,
    quorumBps: 5000,
    appFeeBps: 0, // demo: no app/protocol take -> cost == panelSize * jurorFee
    protocolFeeBps: 0,
    treasury,
  };
}

function loadArtifact(solFile: string, contractName: string): { abi: ethers.InterfaceAbi; bytecode: string } {
  const p = path.join(ARTIFACTS, solFile, `${contractName}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Artifact not found: ${p} — run \`pnpm compile\` first.`);
  }
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode };
}

function buildInitCode(abi: ethers.InterfaceAbi, bytecode: string, args: unknown[]): string {
  const iface = new ethers.Interface(abi);
  const encodedArgs = iface.encodeDeploy(args);
  return ethers.concat([bytecode, encodedArgs]);
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
  const code = buildInitCode(abi, bytecode, args);
  const salt = Binary.fromHex('0x' + Date.now().toString(16).padStart(64, '0'));

  const tx = api.tx.Revive.instantiate_with_code({
    value,
    gas_limit: GAS_LIMIT,
    storage_deposit_limit: STORAGE_DEPOSIT_LIMIT,
    code: Binary.fromHex(code),
    data: Binary.fromHex('0x'), // MUST be empty — args live in `code`
    salt,
  });

  console.log(`Deploying ${label} (${contractName})…`);
  const result = await tx.signAndSubmit(signer);
  if (!result.ok) {
    throw new Error(`${label} deploy failed: ${JSON.stringify(result.dispatchError)}`);
  }
  const ev = result.events.find(
    (e: any) => e.type === 'Revive' && e.value.type === 'Instantiated',
  );
  const address: string = ev?.value?.value?.contract?.asHex?.() ?? ev?.value?.value?.contract;
  if (!address) throw new Error(`${label}: could not read deployed address from events`);
  console.log(`✅ ${label} → ${address}`);
  return address;
}

async function main() {
  const zkRegistry = ethers.getAddress(
    requireEnv('ZKPASSPORT_REGISTRY_ADDRESS', process.env.ZKPASSPORT_REGISTRY_ADDRESS),
  );

  const client = createClient(withPolkadotSdkCompat(getWsProvider(WSS)));
  // const api = client.getTypedApi(paseohub);   // after `papi add paseohub`
  const api: any = null;
  if (!api) {
    throw new Error(
      'PAPI descriptor missing. Run: pnpm papi add paseohub -w ' + WSS + ' then uncomment the getTypedApi line.',
    );
  }
  const signer = buildSigner();
  const treasury = deployerEvmAddress();
  console.log('Deployer EVM (treasury):', treasury);
  console.log('ZKPassportRegistry (PoP gate):', zkRegistry);

  // Deploy order (PoP-gated variant):
  //   1. PopGatedEligibility(zkRegistry)          — one-person-one-vote gate
  //   2. ArbitratorCore(courtConfig, eligibility) — the main protocol contract
  //   3. SimpleEscrow(arbitrator)                 — the example IArbitrable app
  const eligibility = await instantiate(
    api, signer, 'PopGatedEligibility',
    'policies/PopGatedEligibility.sol', 'PopGatedEligibility', [zkRegistry],
  );
  const arbitrator = await instantiate(
    api, signer, 'ArbitratorCore',
    'core/ArbitratorCore.sol', 'ArbitratorCore', [demoCourtConfig(treasury), eligibility, 0],
  );
  const escrow = await instantiate(
    api, signer, 'SimpleEscrow',
    'examples/SimpleEscrow.sol', 'SimpleEscrow', [arbitrator],
  );

  console.log('\nDeployed (PoP-gated court):');
  console.log('  PopGatedEligibility:', eligibility);
  console.log('  ArbitratorCore:     ', arbitrator);
  console.log('  SimpleEscrow:       ', escrow);
  client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
