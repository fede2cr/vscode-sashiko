// Copies the release bridge binary next to the bundled extension so the VSIX ships it.
// Pass --target <triple> when cross-compiling; otherwise the host build is used.
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targetFlag = process.argv.indexOf('--target');
const triple = targetFlag === -1 ? undefined : process.argv[targetFlag + 1];

const isWindows = triple ? triple.includes('windows') : process.platform === 'win32';
const name = isWindows ? 'sashiko-vscode-bridge.exe' : 'sashiko-vscode-bridge';
const releaseDir = triple
	? join(root, 'rust', 'target', triple, 'release')
	: join(root, 'rust', 'target', 'release');

const destination = join(root, 'bin', name);
mkdirSync(join(root, 'bin'), { recursive: true });
copyFileSync(join(releaseDir, name), destination);
if (!isWindows) {
	// copyFileSync does not carry the source mode over, and the VSIX must stay executable.
	chmodSync(destination, 0o755);
}
console.log(`staged bin/${name}${triple ? ` (${triple})` : ''}`);
