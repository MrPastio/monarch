const THINKING_OPENERS = Object.freeze([
  'Сейчас',
  'Секунду',
  'Так,',
  'Хорошо,',
  'Понял,',
  'Дай секунду,',
  'Угу,',
  'Ладно,',
  'Минутку,',
  'Да,',
]);

const THINKING_ACTIONS = Object.freeze([
  'быстро прикину детали',
  'сверю главное',
  'проверю пару вещей',
  'соберу это в короткий ответ',
  'разложу по шагам',
  'посмотрю, что здесь важнее',
  'подумаю над лучшим вариантом',
  'уточню контекст',
  'сопоставлю варианты',
  'проверю логику ответа',
]);

export const VOICE_THINKING_PHRASES = Object.freeze(
  THINKING_OPENERS.flatMap((opener) => THINKING_ACTIONS.map((action) => `${opener} ${action}.`)),
);

export function createVoiceThinkingPhrasePicker({ random = Math.random, historySize = 18 } = {}) {
  const recent = [];
  const boundedHistorySize = Math.max(1, Math.min(VOICE_THINKING_PHRASES.length - 1, historySize));

  return () => {
    const available = VOICE_THINKING_PHRASES.filter((phrase) => !recent.includes(phrase));
    const source = available.length ? available : VOICE_THINKING_PHRASES;
    const index = Math.min(source.length - 1, Math.floor(Math.max(0, Math.min(0.999999, random())) * source.length));
    const phrase = source[index];
    recent.push(phrase);
    if (recent.length > boundedHistorySize) recent.shift();
    return phrase;
  };
}
