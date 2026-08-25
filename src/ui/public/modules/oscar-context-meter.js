export function formatOscarContextTokenCount(value) {
  const tokens = Math.max(0, Math.round(Number(value) || 0));
  if (tokens >= 1_000_000) {
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(tokens / 1_000_000)} млн`;
  }
  if (tokens >= 1_000) {
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(tokens / 1_000)} тыс.`;
  }
  return new Intl.NumberFormat('ru-RU').format(tokens);
}

export function resolveOscarContextMeterState(contextWindow) {
  const total = Number(contextWindow?.context_tokens || 0);
  const used = Number(contextWindow?.input_tokens);
  const hasTelemetry = Boolean(
    contextWindow
    && typeof contextWindow === 'object'
    && total > 0
    && Number.isFinite(used)
    && used >= 0
  );
  if (!hasTelemetry) {
    return {
      hasTelemetry: false,
      percent: 0,
      remainingPercent: 100,
      total: 0,
      used: 0,
      usage: 'unknown',
      contextTrimmed: false,
      droppedMessages: 0,
    };
  }

  const percent = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return {
    hasTelemetry: true,
    percent,
    remainingPercent: Math.max(0, 100 - percent),
    total,
    used,
    usage: percent >= 90 ? 'critical' : percent >= 75 ? 'high' : 'normal',
    contextTrimmed: contextWindow.context_trimmed === true,
    droppedMessages: Math.max(0, Number(contextWindow.dropped_messages) || 0),
  };
}
