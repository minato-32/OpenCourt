/**
 * Copy the compiled ABIs the SDK and console import out of hardhat's artifacts.
 *
 * ABIs are backend-independent, so this is safe to run after an EVM test compile as well as after
 * `compile:pvm`. Only the `abi` field is copied — never bytecode, which must come from resolc.
 */

import fs from 'fs';
import path from 'path';

const ARTIFACTS = path.resolve(__dirname, '../artifacts/contracts');
const OUT = path.resolve(__dirname, '../sdk/src/abi');

const TARGETS: Record<string, string> = {
  'ArbitratorCore': 'core/ArbitratorCore.sol',
  'CourtRegistry': 'core/CourtRegistry.sol',
  'AppealCoordinator': 'core/AppealCoordinator.sol',
  'SimpleEscrow': 'examples/SimpleEscrow.sol',
};

for (const [name, solFile] of Object.entries(TARGETS)) {
  const src = path.join(ARTIFACTS, solFile, `${name}.json`);
  const { abi } = JSON.parse(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(abi, null, 2) + '\n');
  console.log(`${name.padEnd(20)} ${abi.length} entries`);
}
