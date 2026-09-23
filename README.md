# Generic Jury Protocol

A shared, proof-of-personhood-gated **arbitration layer** any app or DAO can call when a
decision needs human judgement. The protocol resolves disputes; it never knows what a dispute
is about. Built on **pallet-revive (PolkaVM)** on Paseo Asset Hub Next.

- **Differentiator:** juries are gated on proof-of-personhood (via the on-chain `ZKPassportRegistry`),
  turning jury capture from a purchasing decision into a coordination problem.
- **Generality lives in configuration, not code** — apps set their own court rules inside a
  protocol-enforced safety envelope. Nobody forks the core.

See the full spec in `docs/` and the build plan in `STATUS.md`.

## Layout
```
jury-protocol/
├── contracts/
│   ├── interfaces/   IArbitrator · IArbitrable · IEligibility
│   ├── core/         ArbitratorCore (dispute FSM · stake escrow · sortition · vote booth · settlement)
│   ├── policies/     PopGatedEligibility · StakeWeightedEligibility
│   └── examples/     SimpleEscrow (a minimal IArbitrable app)
├── scripts/          download-binaries.sh · deploy.ts (PAPI + mnemonic)
├── sdk/              standalone PAPI client + juror daemon (Phase 1.5)
└── test/             Hardhat tests + invariants
```

## Quickstart
```bash
pnpm install
pnpm download:binaries          # fetches the resolc PolkaVM compiler into ./bin
cp .env.example .env            # then fill in DEPLOYER_MNEMONIC (testnet only)
pnpm compile
pnpm test
pnpm deploy                     # deploy to Paseo Asset Hub via PAPI + mnemonic
```

## Networks
| | Endpoint |
|---|---|
| Asset Hub Next (eth-rpc) | `https://eth-rpc-paseo-next.polkadot.io` (EVM chainId **420420417**) |
| Asset Hub Next (WSS) | `wss://paseo-asset-hub-next-rpc.polkadot.io` |
| Explorer | `https://blockscout-paseo-next.polkadot.io` |
| Faucet | `https://faucet.polkadot.io/?parachain=1500` (PAS) |

Native token: **PAS** (10 decimals). Stake and fees are native value (`msg.value`), not an ERC-20.

## Security
`.env` holds a **testnet-only** deployer seed and is **gitignored** — never commit it, never reuse
the wallet on mainnet or with real funds. Only `.env.example` (placeholders) is tracked.
