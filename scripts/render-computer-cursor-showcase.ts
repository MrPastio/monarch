import path from 'node:path';
import { ComputerUseNativeBridge } from '../src/modules/computer/native-bridge';

const outputPath = path.resolve(
  process.argv[2] || path.join('docs', 'qa', 'oscar-cursor-implementation.png'),
);
const directionOutputPath = path.resolve(
  process.argv[3] || path.join('docs', 'qa', 'oscar-cursor-directions.png'),
);
const bridge = new ComputerUseNativeBridge({
  monarchRoot: process.cwd(),
  runtimeRoot: path.resolve('E:\\Monarch-Test-Tmp\\computer-use-cursor-showcase'),
});
const receipt = await bridge.renderCursorShowcase(outputPath);
const directionReceipt = await bridge.renderCursorDirectionShowcase(directionOutputPath);
process.stdout.write(`${JSON.stringify({ states: receipt, directions: directionReceipt })}\n`);
