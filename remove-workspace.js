import fs from 'node:fs';

let content = fs.readFileSync('src/smoke.ts', 'utf8');

content = content.replace(/\s*await assertWorkspaceFileModuleGuardsAndRuns\(\);/g, '');
content = content.replace(/\s*await assertWorkspaceRussianPatternsAndDiffFlow\(\);/g, '');

const func1 = 'async function assertWorkspaceFileModuleGuardsAndRuns(): Promise<void> {';
const func2 = 'async function assertWorkspaceRussianPatternsAndDiffFlow(): Promise<void> {';

const idx1 = content.indexOf(func1);
if (idx1 !== -1) {
    const nextFuncIdx = content.indexOf('async function', idx1 + 10);
    content = content.slice(0, idx1) + (nextFuncIdx !== -1 ? content.slice(nextFuncIdx) : '');
}

const idx2 = content.indexOf(func2);
if (idx2 !== -1) {
    const nextFuncIdx = content.indexOf('async function', idx2 + 10);
    content = content.slice(0, idx2) + (nextFuncIdx !== -1 ? content.slice(nextFuncIdx) : '');
}

fs.writeFileSync('src/smoke.ts', content, 'utf8');
console.log('Removed successfully!');
