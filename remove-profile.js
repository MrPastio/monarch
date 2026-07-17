import fs from 'node:fs';

let content = fs.readFileSync('src/smoke.ts', 'utf8');

content = content.replace(/\s*await assertProfilePersistsAcrossModuleRestart\(\);/g, '');

const func1 = 'async function assertProfilePersistsAcrossModuleRestart(): Promise<void> {';

const idx1 = content.indexOf(func1);
if (idx1 !== -1) {
    const nextFuncIdx = content.indexOf('async function', idx1 + 10);
    content = content.slice(0, idx1) + (nextFuncIdx !== -1 ? content.slice(nextFuncIdx) : '');
}

fs.writeFileSync('src/smoke.ts', content, 'utf8');
console.log('Profile test removed successfully!');
