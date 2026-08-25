export const OSCAR_RAM_CRITICAL_HEADROOM_GB = 0;
export const OSCAR_RAM_RECOMMENDED_HEADROOM_GB = 3;
export const OSCAR_PRO_ESTIMATED_RAM_GB = 22.3;
/** @deprecated Compatibility alias for older renderer imports. */
export const OSCAR_EXTRA_ESTIMATED_RAM_GB = OSCAR_PRO_ESTIMATED_RAM_GB;

const ramFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function buildOscarRamNotice({
  requestedModel = '',
  hardware = null,
  modelStatus = null,
  assessment = null,
} = {}) {
  const runtimeAvailable = finiteRamGb(assessment?.ram_available_gb);
  const hardwareAvailable = finiteRamGb(hardware?.ram_available_gb);
  const available = runtimeAvailable ?? hardwareAvailable;
  const proSelected = ['qwen3.8-27b-pro', 'gemma4-deepthinking', 'gemma4-31b'].includes(requestedModel);
  const runtimeLevel = normalizeWarningLevel(assessment?.ram_warning);
  const source = hasCompleteRuntimeAssessment(assessment) ? 'runtime' : 'estimate';

  if (available === null) {
    if (proSelected && runtimeLevel && typeof assessment?.ram_warning_message === 'string') {
      return {
        level: runtimeLevel,
        title: runtimeLevel === 'critical' ? 'Qwen Pro недоступна из-за RAM' : 'Мало запаса RAM',
        message: assessment.ram_warning_message,
        action: 'use-balanced',
        source: 'runtime',
        availableRamGb: null,
        estimatedRamGb: finiteRamGb(assessment?.estimated_ram_required_gb),
        projectedRamGb: finiteNumber(assessment?.projected_ram_available_gb),
        reclaimRamGb: null,
      };
    }
    return null;
  }

  if (!proSelected) {
    if (available >= OSCAR_RAM_RECOMMENDED_HEADROOM_GB) return null;
    const reclaim = reclaimTo(OSCAR_RAM_RECOMMENDED_HEADROOM_GB, available);
    return {
      level: 'caution',
      title: 'Мало свободной RAM',
      message: `Свободно ${formatRamGb(available)} ГБ RAM. Генерация разрешена, но системе может не хватать памяти; рекомендуемый запас — ${formatRamGb(OSCAR_RAM_RECOMMENDED_HEADROOM_GB)} ГБ.`,
      action: null,
      source: runtimeAvailable === null ? 'hardware' : 'runtime',
      availableRamGb: available,
      estimatedRamGb: null,
      projectedRamGb: null,
      reclaimRamGb: reclaim,
    };
  }

  const estimated = finitePositiveRamGb(assessment?.estimated_ram_required_gb)
    ?? OSCAR_PRO_ESTIMATED_RAM_GB;
  const proLoaded = modelStatus?.loaded === true
    && ['qwen3.8-27b-pro', 'gemma4-deepthinking', 'gemma4-31b'].includes(modelStatus?.active_tier);
  const runtimeProjected = finiteNumber(assessment?.projected_ram_available_gb);
  const projected = runtimeProjected ?? roundHundredths(proLoaded ? available : available - estimated);

  if (projected >= OSCAR_RAM_RECOMMENDED_HEADROOM_GB) return null;

  const critical = false;
  const target = OSCAR_RAM_RECOMMENDED_HEADROOM_GB;
  const reclaim = reclaimTo(target, projected);
  return {
    level: critical ? 'critical' : 'caution',
    title: projected < 0 ? 'Высокая нагрузка на RAM' : 'Мало запаса RAM',
    message: buildProMessage({ available, estimated, projected, reclaim, proLoaded, critical }),
    action: 'use-balanced',
    source,
    availableRamGb: available,
    estimatedRamGb: estimated,
    projectedRamGb: projected,
    reclaimRamGb: reclaim,
  };
}

export function formatRamGb(value) {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
  return ramFormatter.format(Object.is(safeValue, -0) ? 0 : safeValue);
}

function buildProMessage({ available, estimated, projected, reclaim, proLoaded, critical }) {
  if (projected < 0) {
    return `Для Qwen Pro доступно ${formatRamGb(available)} ГБ RAM, оценка загрузки — ${formatRamGb(estimated)} ГБ. Это только оценка: запуск разрешён и может использовать файл подкачки; при нехватке памяти загрузчик вернёт реальную ошибку.`;
  }

  if (proLoaded) {
    const prefix = projected === 0
      ? 'Qwen Pro уже загружена, но свободного запаса RAM не осталось.'
      : projected < 0.1
        ? 'Qwen Pro уже загружена, но свободно меньше 0,1 ГБ RAM.'
        : critical
          ? `Qwen Pro уже загружена, но свободно только ${formatRamGb(projected)} ГБ RAM.`
          : `Qwen Pro уже загружена; свободный запас — ${formatRamGb(projected)} ГБ RAM.`;
    return `${prefix} ${reclaimInstruction(reclaim, critical)}`;
  }

  const prefix = projected === 0
    ? 'После загрузки Qwen Pro свободного запаса RAM не останется.'
    : projected < 0.1
      ? 'После загрузки Qwen Pro останется меньше 0,1 ГБ RAM.'
      : `После загрузки Qwen Pro останется около ${formatRamGb(projected)} ГБ RAM.`;
  return `${prefix} ${reclaimInstruction(reclaim, critical)}`;
}

function reclaimInstruction(reclaim, critical) {
  const target = critical ? OSCAR_RAM_CRITICAL_HEADROOM_GB : OSCAR_RAM_RECOMMENDED_HEADROOM_GB;
  if (critical) {
    return `Не хватает примерно ${formatRamGb(reclaim)} ГБ для размещения модели; освободи память или выбери Basic.`;
  }
  return `Это только предупреждение: запуск разрешён. Рекомендуемый запас — ${formatRamGb(target)} ГБ; при необходимости выбери Basic.`;
}

function hasCompleteRuntimeAssessment(assessment) {
  return finiteRamGb(assessment?.ram_available_gb) !== null
    && finitePositiveRamGb(assessment?.estimated_ram_required_gb) !== null
    && finiteNumber(assessment?.projected_ram_available_gb) !== null;
}

function normalizeWarningLevel(value) {
  return value === 'critical' || value === 'caution' ? value : null;
}

function finiteRamGb(value) {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function finitePositiveRamGb(value) {
  const numeric = finiteRamGb(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundHundredths(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function reclaimTo(target, projected) {
  const raw = Math.max(0, target - projected);
  if (raw === 0) return 0;
  return Math.ceil((raw - 1e-9) * 10) / 10;
}
