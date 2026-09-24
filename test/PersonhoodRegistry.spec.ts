import { expect } from 'chai';
import { ethers } from 'hardhat';
import { mine } from '@nomicfoundation/hardhat-network-helpers';

// PersonhoodRegistry backs the PoP-gated courts. It does not verify a proof; it enforces the
// binding rules the deployed reference registry left open — one credential to one wallet, one
// wallet to one credential, and a cooldown so a revoked credential cannot immediately walk to a
// new address and pack a panel.

const COOLDOWN = 20n;
const CRED_A = ethers.id('passport-a');
const CRED_B = ethers.id('passport-b');

async function deploy() {
  const [issuer, alice, bob, outsider] = await ethers.getSigners();
  const Reg = await ethers.getContractFactory('PersonhoodRegistry');
  const reg = (await Reg.deploy(issuer.address, COOLDOWN)) as any;
  await reg.waitForDeployment();
  return { reg, issuer, alice, bob, outsider };
}

describe('PersonhoodRegistry', () => {
  it('attests a wallet and reports it verified', async () => {
    const { reg, alice } = await deploy();
    expect(await reg.isVerified(alice.address)).to.equal(false);

    await expect(reg.attest(alice.address, CRED_A))
      .to.emit(reg, 'Attested')
      .withArgs(alice.address, CRED_A);

    expect(await reg.isVerified(alice.address)).to.equal(true);
    expect(await reg.credentialOf(alice.address)).to.equal(CRED_A);
    expect(await reg.walletOf(CRED_A)).to.equal(alice.address);
  });

  it('refuses a second credential on the same wallet and a second wallet on the same credential', async () => {
    const { reg, alice, bob } = await deploy();
    await (await reg.attest(alice.address, CRED_A)).wait();

    await expect(reg.attest(alice.address, CRED_B)).to.be.revertedWithCustomError(reg, 'WalletAlreadyBound');
    await expect(reg.attest(bob.address, CRED_A)).to.be.revertedWithCustomError(reg, 'CredentialAlreadyBound');
  });

  it('only the issuer may attest, revoke, or hand over the issuer role', async () => {
    const { reg, alice, outsider } = await deploy();
    await expect(reg.connect(outsider).attest(alice.address, CRED_A)).to.be.revertedWithCustomError(reg, 'NotIssuer');
    await (await reg.attest(alice.address, CRED_A)).wait();
    await expect(reg.connect(outsider).revoke(alice.address)).to.be.revertedWithCustomError(reg, 'NotIssuer');
    await expect(reg.connect(outsider).transferIssuer(outsider.address)).to.be.revertedWithCustomError(reg, 'NotIssuer');
  });

  it('parks a revoked credential for the cooldown, then lets it rebind', async () => {
    const { reg, alice, bob } = await deploy();
    await (await reg.attest(alice.address, CRED_A)).wait();

    const tx = await reg.revoke(alice.address);
    const rc = await tx.wait();
    const revokedBlock = BigInt(rc!.blockNumber);
    expect(await reg.isVerified(alice.address)).to.equal(false);
    expect(await reg.rebindableAt(CRED_A)).to.equal(revokedBlock + COOLDOWN);

    // The whole point: the credential cannot hop straight to another wallet.
    await expect(reg.attest(bob.address, CRED_A))
      .to.be.revertedWithCustomError(reg, 'RebindTooSoon')
      .withArgs(revokedBlock + COOLDOWN);

    await mine(Number(COOLDOWN));
    await (await reg.attest(bob.address, CRED_A)).wait();
    expect(await reg.isVerified(bob.address)).to.equal(true);
    expect(await reg.walletOf(CRED_A)).to.equal(bob.address);
  });

  it('rejects zero wallet and zero credential', async () => {
    const { reg, alice } = await deploy();
    await expect(reg.attest(ethers.ZeroAddress, CRED_A)).to.be.revertedWithCustomError(reg, 'ZeroAddress');
    await expect(reg.attest(alice.address, ethers.ZeroHash)).to.be.revertedWithCustomError(reg, 'ZeroCredential');
    await expect(reg.revoke(alice.address)).to.be.revertedWithCustomError(reg, 'NotBound');
  });

  it('gates a PoP court: an unattested juror cannot claim a seat, an attested one can', async () => {
    const { reg, issuer, alice, bob } = await deploy();

    const Pop = await ethers.getContractFactory('PopGatedEligibility');
    const pop = (await Pop.deploy(await reg.getAddress())) as any;
    await pop.waitForDeployment();

    expect(await pop.weightOf(alice.address, 0n)).to.equal(0n);
    await (await reg.attest(alice.address, CRED_A)).wait();
    expect(await pop.weightOf(alice.address, 0n)).to.equal(1n);

    // Revocation removes eligibility immediately, without touching any court.
    await (await reg.revoke(alice.address)).wait();
    expect(await pop.weightOf(alice.address, 0n)).to.equal(0n);

    // Issuer handover works and the new issuer can attest.
    await (await reg.transferIssuer(bob.address)).wait();
    await expect(reg.connect(issuer).attest(bob.address, CRED_B)).to.be.revertedWithCustomError(reg, 'NotIssuer');
    await (await reg.connect(bob).attest(bob.address, CRED_B)).wait();
    expect(await pop.weightOf(bob.address, 0n)).to.equal(1n);
  });
});
