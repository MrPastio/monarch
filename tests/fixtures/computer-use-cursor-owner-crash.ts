import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ComputerUseControlPlane } from '../../src/modules/computer/control-plane';
import { ComputerUseNativeBridge } from '../../src/modules/computer/native-bridge';

const root = path.resolve(process.argv[2] || 'E:\\Monarch-Test-Tmp\\computer-use-owner-crash');
await mkdir(root, { recursive: true });
const control = new ComputerUseControlPlane(path.join(root, 'control.json'));
control.start('live-owner-crash-fixture');
const bridge = new ComputerUseNativeBridge({
  monarchRoot: path.resolve('E:\\Monarch'),
  runtimeRoot: path.join(root, 'native'),
});
const cursorSession = await bridge.startCursorSession(control.statePath);
process.stdout.write(`${JSON.stringify(cursorSession)}\n`);
process.exit(0);
