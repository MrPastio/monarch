const SKILL_COPY = Object.freeze({
  'monarch-file-guardian': {
    name: 'Работа с файлами',
    description: 'Найти, разобрать, переместить или восстановить файлы и проверить результат.',
  },
  'monarch-security-guardian': {
    name: 'Проверка безопасности',
    description: 'Проверить безопасность Monarch и компьютера, не обходя подтверждения.',
  },
  'monarch-skill-author': {
    name: 'Создание навыков',
    description: 'Создать, проверить или улучшить локальный навык Oscar.',
  },
  'monarch-telegram-operator': {
    name: 'Управление Telegram',
    description: 'Настроить и проверить локальное подключение Telegram.',
  },
});

export function skillUserFacingName(skill) {
  const name = String(skill?.name || '').trim().toLowerCase();
  if (SKILL_COPY[name]?.name) return SKILL_COPY[name].name;
  const fallback = String(skill?.displayName || skill?.name || 'Навык')
    .replace(/^Monarch\s+/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Навык';
  return fallback.charAt(0).toLocaleUpperCase('ru') + fallback.slice(1);
}

export function skillUserFacingDescription(skill) {
  const name = String(skill?.name || '').trim().toLowerCase();
  if (SKILL_COPY[name]?.description) return SKILL_COPY[name].description;
  return String(skill?.description || 'Готовый способ выполнить повторяемую задачу.').trim();
}

export function filterSkillPickerSkills(skills, query = '', limit = 8) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const compatible = (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill?.compatible !== false)
    .filter((skill) => {
      if (!normalizedQuery) return skill?.scope === 'project' || skill?.scope === 'user';
      const searchable = [
        skill?.name,
        skillUserFacingName(skill),
        skillUserFacingDescription(skill),
        skill?.description,
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(normalizedQuery);
    })
    .sort((left, right) => skillScopeRank(right?.scope) - skillScopeRank(left?.scope)
      || skillUserFacingName(left).localeCompare(skillUserFacingName(right), 'ru'));

  const fallback = normalizedQuery || compatible.length
    ? compatible
    : (Array.isArray(skills) ? skills : [])
      .filter((skill) => skill?.compatible !== false)
      .sort((left, right) => skillScopeRank(right?.scope) - skillScopeRank(left?.scope)
        || skillUserFacingName(left).localeCompare(skillUserFacingName(right), 'ru'));
  return fallback.slice(0, Math.max(1, Number(limit) || 8));
}

export function parseSkillInvocation(content) {
  const source = String(content || '');
  const match = source.match(/^\s*\$([a-z0-9][a-z0-9-]{0,62})(?:\s+|$)/i);
  if (!match) return { skillName: '', visibleContent: source };
  return {
    skillName: match[1],
    visibleContent: source.slice(match[0].length).trimStart(),
  };
}

function skillScopeRank(scope) {
  return scope === 'project' ? 3 : scope === 'user' ? 2 : 1;
}
