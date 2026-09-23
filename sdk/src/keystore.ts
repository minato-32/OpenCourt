/**
 * Salt keystore — a juror's per-dispute reveal secrets.
 *
 * A commit is keccak(disputeId, juror, choice, salt). If the juror loses the
 * salt they cannot reveal, and non-reveal is slashed at gammaBps (>= the
 * incoherence penalty). So the salt is load-bearing: persist it the instant it
 * is generated, before the commit tx is even submitted.
 *
 * This is a deliberately small, dependency-free JSON file. It is NOT encrypted —
 * the salt alone reveals nothing until paired with the on-chain commit and the
 * juror's private key. Keep the file with the same care as the mnemonic anyway.
 *
 * Durability rules this file enforces (each one is a slash if violated):
 *   - Writes are atomic (temp file + rename), so a crash mid-write can never
 *     truncate the JSON and lose every stored salt on the next read.
 *   - A read only treats a MISSING file as empty. A corrupt file is preserved
 *     (moved to `.corrupt`) and the error is raised — it is never silently reset,
 *     which would let the next save wipe every other dispute's salt.
 *   - Salt keys are namespaced by arbitrator address (and chain, if supplied) so
 *     a redeploy at the same dispute ids cannot collide with old secrets.
 *   - saveSalt is append-only per dispute: it never clobbers an existing salt
 *     (a commit binds to exactly one salt for the life of the dispute).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

/** A fresh 32-byte reveal salt as a 0x-hex string. */
export function generateSalt(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

interface KeystoreFile {
  version: 1;
  salts: Record<string, string>; // namespaced key -> salt (0x-hex)
}

export interface SaltKeystoreOpts {
  /** Path to the JSON file. Defaults to $JURY_KEYSTORE or ./.jury-keystore.json. */
  filePath?: string;
  /** Arbitrator contract address — namespaces keys so redeploys don't collide. */
  arbitrator?: string;
  /** Optional chain id (genesis hash / name) — further namespaces keys. */
  chain?: string;
}

export class SaltKeystore {
  readonly filePath: string;
  private readonly arbitrator: string;
  private readonly chain: string;

  constructor(opts: SaltKeystoreOpts | string = {}) {
    const o: SaltKeystoreOpts = typeof opts === 'string' ? { filePath: opts } : opts;
    this.filePath = path.resolve(o.filePath ?? process.env.JURY_KEYSTORE ?? './.jury-keystore.json');
    this.arbitrator = (o.arbitrator ?? 'any').toLowerCase();
    this.chain = (o.chain ?? 'any').toLowerCase();
  }

  /** Namespaced storage key: <chain>:<arbitrator>:<disputeId>. */
  private key(disputeId: bigint | number): string {
    return `${this.chain}:${this.arbitrator}:${String(disputeId)}`;
  }

  private read(): KeystoreFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      // ONLY a missing file is "empty". EACCES/EBUSY/etc must propagate — swallowing
      // them and returning {} would let the next save destroy all stored salts.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, salts: {} };
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<KeystoreFile>;
      return { version: 1, salts: parsed.salts ?? {} };
    } catch (err) {
      // Corrupt (e.g. a truncated legacy write). Preserve it and fail loudly rather
      // than silently resetting to {} and letting the next save wipe everything.
      const corruptPath = `${this.filePath}.corrupt`;
      try {
        fs.renameSync(this.filePath, corruptPath);
      } catch {
        /* best effort — still throw below */
      }
      throw new Error(
        `keystore ${this.filePath} is corrupt — moved to ${corruptPath}. ` +
          `Original parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private write(data: KeystoreFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic: write a sibling temp file (0600) then rename over the target. rename is
    // atomic on POSIX, so a crash leaves either the old file or the new one intact —
    // never a half-written JSON that the next read would treat as corrupt.
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }
  }

  /**
   * Persist `salt` for `disputeId`. APPEND-ONLY: a commit binds to exactly one salt
   * for the life of the dispute, so an existing salt is never overwritten. Storing
   * the same salt again is a no-op; storing a DIFFERENT salt throws, because doing so
   * would strand the on-chain commitment and guarantee a non-reveal slash.
   */
  saveSalt(disputeId: bigint | number, salt: string): void {
    const data = this.read();
    const k = this.key(disputeId);
    const existing = data.salts[k];
    if (existing !== undefined) {
      if (existing !== salt) {
        throw new Error(
          `refusing to overwrite salt for dispute ${disputeId} — the commitment is already ` +
            `bound to a different salt; overwriting would make the vote unrevealable`,
        );
      }
      return; // idempotent
    }
    data.salts[k] = salt;
    this.write(data);
  }

  /** Load a previously saved salt, or undefined if none is stored. */
  loadSalt(disputeId: bigint | number): string | undefined {
    return this.read().salts[this.key(disputeId)];
  }

  /** True if a salt is stored for `disputeId`. */
  hasSalt(disputeId: bigint | number): boolean {
    return this.loadSalt(disputeId) !== undefined;
  }
}
