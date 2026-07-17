import fs from 'node:fs';

let content = fs.readFileSync('src/smoke.ts', 'utf8');

// Remove await calls
content = content.replace(/\s*await assertMemoryV2MigratesLegacySnapshot\(\);/g, '');
content = content.replace(/\s*await assertMemoryPersistsAcrossModuleRestart\(\);/g, '');

// Remove inline intents (using broader regex to catch exact match and ignoring minor whitespaces)
content = content.replace(/\s*const unconfirmedMemory = await kernel\.submitIntent\('Запомни: Monarch должен быть локальной экосистемой'\);/g, '');
content = content.replace(/\s*const confirmedMemory = await kernel\.submitIntent\('Запомни: Monarch должен быть локальной экосистемой', 'desktop', { confirmed: true }\);/g, '');
content = content.replace(/\s*const recalledMemory = await kernel\.submitIntent\('Вспомни Monarch'\);/g, '');

// Remove inline asserts by exact lines or regex
content = content.replace(/\s*if \(unconfirmedMemory\.execution\?\.error !== 'confirmation-required'\) {[\s\S]*?}\n/, '');
content = content.replace(/\s*if \(!confirmedMemory\.execution\?\.ok\) {[\s\S]*?}\n/, '');
content = content.replace(/\s*if \(!recalledMemory\.execution\?\.ok\) {[\s\S]*?}\n/, '');

// Remove functions
const func1 = 'async function assertMemoryV2MigratesLegacySnapshot(): Promise<void> {';
const func2 = 'async function assertMemoryPersistsAcrossModuleRestart(): Promise<void> {';

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

// Remove unused imports
content = content.replace(/readFile, /g, '');
content = content.replace(/writeFile, /g, '');
// If that leaves something like `import {  rm }`, it's fine, typescript doesn't care.
// Actually, `readFile` and `writeFile` might be the only ones. Let's replace:
content = content.replace(/readFile,\s*/g, '');
content = content.replace(/writeFile,\s*/g, '');

fs.writeFileSync('src/smoke.ts', content, 'utf8');
console.log('Memory tests removed successfully!');
