const STARTERS = Object.freeze([
  'Что нового?', 'Чем займёмся?', 'Как жизнь?', 'С чего начнём?', 'Что сегодня важно?',
  'Что будем делать?', 'Куда двигаемся?', 'Что хочешь разобрать?', 'Что создаём?',
  'Что проверим?', 'Есть идея?', 'Какой план?', 'Что улучшить?', 'С чем помочь?',
  'Что на повестке?', 'Продолжим?', 'За что берёмся?', 'Что хочется сделать?',
]);

const FINISHERS = Object.freeze([
  'Я рядом.', 'Можно начать с малого.', 'Давай по делу.', 'Разберёмся спокойно.',
  'Сделаем понятнее.', 'Начнём с главного.', 'Готов подключиться.',
]);

export const OSCAR_EASTER_EGGS = Object.freeze([
  'Марк скоро выйдет?',
  'Оскар...или Фернандо?',
  'Где мои cookies?',
]);

export const OSCAR_GREETING_COUNT = STARTERS.length * FINISHERS.length + OSCAR_EASTER_EGGS.length;

export function createOscarGreeting(random = Math.random) {
  const index = Math.max(0, Math.min(OSCAR_GREETING_COUNT - 1, Math.floor(Number(random()) * OSCAR_GREETING_COUNT)));
  if (index >= STARTERS.length * FINISHERS.length) {
    return { title: OSCAR_EASTER_EGGS[index - STARTERS.length * FINISHERS.length], copy: '' };
  }
  return {
    title: STARTERS[index % STARTERS.length],
    copy: FINISHERS[Math.floor(index / STARTERS.length) % FINISHERS.length],
  };
}
