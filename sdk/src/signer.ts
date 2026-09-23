/**
 * Headless sr25519 signers for the jury SDK.
 *
 * The juror daemon runs without a browser/Host, so it signs its own extrinsics
 * from a keypair derived from a mnemonic (or a keystore file). This is the one
 * real difference from p2p-market, which signs via a Host-injected signer.
 *
 * SECURITY: a juror's vote salt is separate from this key — losing the salt is a
 * slash (see the daemon). Keep mnemonics in env/keystore, never in source.
 */

import { getPolkadotSigner, type PolkadotSigner } from 'polkadot-api/signer';
import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { entropyToMiniSecret, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';
import { ethers } from 'ethers';

export interface Keypair {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
}

/** Derive an sr25519 keypair from a BIP39 mnemonic (path '' = root account). */
export function deriveKeypair(mnemonic: string, path = ''): Keypair {
  const entropy = mnemonicToEntropy(mnemonic);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  return derive(path);
}

/** Build a PAPI signer from a mnemonic — headless, for the deploy script and juror daemon. */
export function signerFromMnemonic(mnemonic: string, path = ''): PolkadotSigner {
  const kp = deriveKeypair(mnemonic, path);
  return getPolkadotSigner(kp.publicKey, 'Sr25519', kp.sign);
}

/**
 * The EVM (H160) address the contract sees as msg.sender for an sr25519 account.
 *
 * Mirrors pallet-revive's AccountId32Mapper fallback (and the deploy script's
 * treasury derivation): keccak256(pubkey)[12..32], EIP-55 checksummed. This is
 * the address every juror-binding value (commit hash, sortition draw) hashes
 * against — derive it from the signer's key rather than hand-supplying it.
 */
export function evmAddress(publicKey: Uint8Array): string {
  return ethers.getAddress('0x' + ethers.keccak256(publicKey).slice(-40));
}

/** The signer's H160 for a mnemonic — the juror address the contract binds to. */
export function evmAddressFromMnemonic(mnemonic: string, path = ''): string {
  return evmAddress(deriveKeypair(mnemonic, path).publicKey);
}
