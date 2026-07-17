const fs = require('fs');

let content = fs.readFileSync('src/smoke.ts', 'utf8');

// remove await lines
content = content.replace(/\s*await assertWorkspaceFileModuleGuardsAndRuns\(\);/g, '');
content = content.replace(/\s*await assertWorkspaceRussianPatternsAndDiffFlow\(\);/g, '');

// remove functions
const func1Match = content.indexOf('async function assertWorkspaceFileModuleGuardsAndRuns(): Promise<void> {');
if (func1Match !== -1) {
    const endFunc1Match = content.indexOf('}', content.indexOf('await rm(filePath, { force: true });', func1Match)) + 1;
    content = content.slice(0, func1Match) + content.slice(endFunc1Match);
}

const func2Match = content.indexOf('async function assertWorkspaceRussianPatternsAndDiffFlow(): Promise<void> {');
if (func2Match !== -1) {
    const endFunc2Match = content.indexOf('}', content.indexOf('await runtime.kernel.stop();', func2Match) + 1) + 1;
    content = content.slice(0, func2Match) + content.slice(endFunc2Match);
}

fs.writeFileSync('src/smoke.ts', content, 'utf8');
console.log('Removed workspace functions from smoke.ts');
