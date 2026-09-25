# OpenCourt

A shared, proof-of-personhood-gated **arbitration layer** any app or DAO can call when a decision
needs human judgement. The protocol resolves disputes; it never knows what a dispute is about.
Built on **pallet-revive (PolkaVM)** on Paseo Asset Hub Next.

- **Differentiator:** juries are gated on proof-of-personhood, turning jury capture from a
  purchasing decision into a coordination problem.
- **Generality lives in configuration, not code** — apps set their own court rules inside a
  protocol-enforced safety envelope. Nobody forks the core.

Full spec in `docs/prd.md`, build state in `STATUS.md`.

## Live on Paseo Asset Hub Next

| Contract | Address |
|---|---|
| ArbitratorCore | `0xd4594022d6a1344b8b5b9a603132ba471e4e7db8` |
| SimpleEscrow | `0x40c58fb8633d4cd85fcb6b2ad989d0622554006e` |
| StakeWeightedEligibility | `0xe32d6bdc699d367867c4c882d0f339a71e07ee56` |

Court: 100 PAS minStake · 10 PAS jurorFee · 30 PAS arbitrationCost · panel 3 · q\* 0.4167.
Every address, the Feature-1 proof court, and the chain-level facts learned while deploying are in
`deployments/paseo-asset-hub-next.json`.

## Layout

```
contracts/    interfaces · core (ArbitratorCore, CourtRegistry, AppealCoordinator) · policies · examples
console/      Vite + React console: court config, dispute explorer, juror flows
sdk/          standalone PAPI client + headless juror daemon
scripts/      deploy.ts · demo-feature1-live.ts · download-binaries.sh
test/         hardhat tests (29 passing)
docs/         prd.md (authoritative) · spec.md · review-round1.md
```

## Setup

```bash
pnpm papi:add          # generate chain descriptors FIRST — package.json depends on them
pnpm install
pnpm download:binaries # fetches the resolc PolkaVM compiler into ./bin
cp .env.example .env   # then fill DEPLOYER_MNEMONIC (testnet only)
```

## Test

```bash
pnpm test              # 29 hardhat tests, local, no chain needed
pnpm console           # console at http://localhost:5173 — reads the live courts
pnpm demo:feature1     # full dispute cycle on the real chain (~15 min of block windows)
```

`pnpm demo:feature1` deploys its own court, funds three jurors, runs a genuine tie, and prints what
each juror was paid against what was expected.

## Deploy

```bash
pnpm compile --network paseo   # solc 0.8.28 -> resolc -> PolkaVM
pnpm deploy                    # PAPI + sr25519 mnemonic
```

Three things this chain does differently from an EVM, all verified rather than assumed:

- `Revive.call` / `Revive.instantiate_with_code` take **`weight_limit`**, not `gas_limit`.
- Constructor args go in **`data`**; `code` is the untouched PolkaVM blob. Appending args to the
  blob is rejected as `Revive::CodeRejected`.
- Contract-side value is in **1e18 EVM decimals** while extrinsic value is in **1e10 planck** —
  divide by 1e8. A config written in planck makes a "100 PAS" stake worth 0.000001 PAS.

## Networks

| | Endpoint |
|---|---|
| Asset Hub Next (WSS) | `wss://paseo-asset-hub-next-rpc.polkadot.io` |
| Asset Hub Next (eth-rpc) | `https://eth-rpc-paseo-next.polkadot.io` (chainId 420420417) |
| Faucet | `https://faucet.polkadot.io/?parachain=1500` (PAS) |

Native token **PAS**, 10 decimals. Stake and fees are native value, not an ERC-20. Block time ~2s.

## Security

`.env` holds a **testnet-only** deployer seed and is gitignored — never commit it, never reuse the
wallet with real funds. Only `.env.example` is tracked.
