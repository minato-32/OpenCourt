/**
 * @getcourt/sdk — standalone PAPI SDK for the GetCourt.
 *
 * Layers:
 *   - transport:  ContractClient (read/write any pallet-revive contract)
 *   - signing:    signerFromMnemonic / deriveKeypair / evmAddress (headless)
 *   - app API:    createDispute / arbitrationCost / currentRuling / getDispute
 *   - juror API:  stake / claimSeat / commitVote / revealVote / finalize
 *   - daemon:     watch seats -> keccak sortition -> commit -> reveal, salt-persisted
 */

export { ContractClient } from './client.js';
export type { ContractClientOpts, WriteResult } from './client.js';
export { signerFromMnemonic, deriveKeypair, evmAddress, evmAddressFromMnemonic } from './signer.js';
export type { Keypair } from './signer.js';

// app + juror API over ArbitratorCore
export { JuryArbitrator, DisputeState, SeatRole } from './arbitrator.js';
export type {
  DisputeView,
  JurorRoundView,
  SeatEntryView,
  CourtConfigView,
  RulingView,
} from './arbitrator.js';

// per-dispute reveal-salt persistence (a lost salt is a slash)
export { SaltKeystore, generateSalt } from './keystore.js';
export type { SaltKeystoreOpts } from './keystore.js';

// headless juror
export { JurorDaemon, abstainDecision } from './daemon.js';
export type { DecisionFn, JurorDaemonOpts } from './daemon.js';
