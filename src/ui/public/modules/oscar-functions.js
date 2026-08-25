const OSCAR_FUNCTIONS = Object.freeze([{
  id: 'computer-use',
  name: 'Computer Use',
  invocation: '@Computer Use',
  description: 'Видеть экран и управлять им собственным курсором Oscar.',
  aliases: ['computer use', 'c.use', 'cu'],
}]);

export function listOscarFunctions(query = '') {
  const needle = normalize(query);
  if (!needle) return [...OSCAR_FUNCTIONS];
  return OSCAR_FUNCTIONS.filter((entry) => [entry.name, entry.invocation, ...entry.aliases]
    .some((candidate) => normalize(candidate).includes(needle)));
}

export function readOscarFunctionQuery(text) {
  const match = String(text || '').match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? String(match[1] || '') : null;
}

export function insertOscarFunctionInvocation(text, invocation) {
  const source = String(text || '');
  const match = source.match(/(?:^|\s)@[^\s@]*$/u);
  if (!match || match.index === undefined) return `${source}${source && !/\s$/u.test(source) ? ' ' : ''}${invocation} `;
  const prefixLength = match.index + (match[0].startsWith(' ') ? 1 : 0);
  return `${source.slice(0, prefixLength)}${invocation} `;
}

export function isComputerUseFunctionInvocation(text) {
  return /^\s*@(?:computer\s+use|c\.use|cu)(?=\s|$)/iu.test(String(text || ''));
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/^@/u, '');
}
