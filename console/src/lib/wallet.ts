// Browser wallet: polkadot-js/Talisman extension accounts + their mapped H160.

import {
  connectInjectedExtension,
  getInjectedExtensions,
  type InjectedPolkadotAccount,
} from 'polkadot-api/pjs-signer';
import { ethers } from 'ethers';

export interface WalletAccount {
  name: string;
  ss58: string;
  /** What the contract sees as msg.sender: keccak(accountId32)[12:] per AccountId32Mapper. */
  h160: string;
  account: InjectedPolkadotAccount;
}

export const listExtensions = () => getInjectedExtensions();

/** H160 pallet-revive maps an sr25519 account to. */
export function mappedH160(publicKey: Uint8Array): string {
  return ethers.getAddress('0x' + ethers.keccak256(publicKey).slice(-40));
}

export async function connect(extensionName: string): Promise<WalletAccount[]> {
  const ext = await connectInjectedExtension(extensionName);
  return ext.getAccounts().map((a) => ({
    name: a.name ?? a.address.slice(0, 8),
    ss58: a.address,
    h160: mappedH160(a.polkadotSigner.publicKey),
    account: a,
  }));
}
