import { describe, expect, it } from 'vitest';
import { buildOscarRamNotice } from '../../src/ui/public/modules/oscar-ram-pressure.js';

const PRO = 'qwen3.8-27b-pro';

describe('Oscar RAM pressure notice', () => {
  it('allows Pro at zero projected headroom and shows a non-blocking recommendation', () => {
    const notice = buildOscarRamNotice({
      requestedModel: PRO,
      hardware: { ram_available_gb: 22.3 },
    });

    expect(notice).toMatchObject({
      level: 'caution',
      title: 'Мало запаса RAM',
      action: 'use-balanced',
      projectedRamGb: 0,
      reclaimRamGb: 3,
    });
    expect(notice?.message).toContain('свободного запаса RAM не останется');
    expect(notice?.message).toContain('запуск разрешён');
    expect(notice?.message).toContain('3,0 ГБ');
    expect(notice?.message).not.toContain('0,0 ГБ');
  });

  it('reports the full deficit when Pro itself is larger than available RAM', () => {
    const notice = buildOscarRamNotice({
      requestedModel: PRO,
      hardware: { ram_available_gb: 20.8 },
    });

    expect(notice).toMatchObject({
      level: 'caution',
      title: 'Высокая нагрузка на RAM',
      projectedRamGb: -1.5,
      reclaimRamGb: 4.5,
    });
    expect(notice?.message).toContain('доступно 20,8 ГБ');
    expect(notice?.message).toContain('оценка загрузки — 22,3 ГБ');
    expect(notice?.message).toContain('запуск разрешён');
    expect(notice?.message).not.toContain('останется около 0');
  });

  it('never rounds a small positive headroom down to a visible 0.0 GB', () => {
    const notice = buildOscarRamNotice({
      requestedModel: PRO,
      hardware: { ram_available_gb: 22.31 },
    });

    expect(notice).toMatchObject({ projectedRamGb: 0.01, reclaimRamGb: 3 });
    expect(notice?.message).toContain('меньше 0,1 ГБ');
    expect(notice?.message).not.toContain('0,0 ГБ');
  });

  it.each([
    { available: 23.79, level: 'caution', reclaim: 1.6 },
    { available: 23.8, level: 'caution', reclaim: 1.5 },
    { available: 25.29, level: 'caution', reclaim: 0.1 },
    { available: 25.3, level: null, reclaim: null },
  ])('handles the Pro boundary at $available GB without understating reclaim', ({ available, level, reclaim }) => {
    const notice = buildOscarRamNotice({
      requestedModel: PRO,
      hardware: { ram_available_gb: available },
    });

    expect(notice?.level ?? null).toBe(level);
    expect(notice?.reclaimRamGb ?? null).toBe(reclaim);
  });

  it('does not subtract the model estimate again when Pro is already loaded', () => {
    const caution = buildOscarRamNotice({
      requestedModel: PRO,
      hardware: { ram_available_gb: 2.2 },
      modelStatus: { loaded: true, active_tier: PRO },
    });
    const critical = buildOscarRamNotice({
      requestedModel: PRO,
      hardware: { ram_available_gb: 0.9 },
      modelStatus: { loaded: true, active_tier: PRO },
    });

    expect(caution).toMatchObject({ level: 'caution', projectedRamGb: 2.2, reclaimRamGb: 0.8 });
    expect(caution?.message).toContain('Qwen Pro уже загружена');
    expect(critical).toMatchObject({ level: 'caution', projectedRamGb: 0.9, reclaimRamGb: 2.1 });
    expect(critical?.message).toContain('Qwen Pro уже загружена');
  });

  it('uses a complete runtime assessment ahead of the local fallback estimate', () => {
    const notice = buildOscarRamNotice({
      requestedModel: PRO,
      hardware: { ram_available_gb: 40 },
      assessment: {
        ram_available_gb: 12,
        estimated_ram_required_gb: 24,
        projected_ram_available_gb: -12,
        ram_warning: 'critical',
      },
    });

    expect(notice).toMatchObject({
      source: 'runtime',
      availableRamGb: 12,
      estimatedRamGb: 24,
      projectedRamGb: -12,
      reclaimRamGb: 15,
    });
  });

  it('keeps global low-memory pressure non-blocking', () => {
    const notice = buildOscarRamNotice({
      requestedModel: 'gemma4-fast',
      hardware: { ram_available_gb: 0.2 },
    });

    expect(notice).toMatchObject({
      level: 'caution',
      title: 'Мало свободной RAM',
      action: null,
      reclaimRamGb: 2.8,
    });
    expect(notice?.message).toContain('Свободно 0,2 ГБ');
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'fails quiet for invalid RAM telemetry: %s',
    (ramAvailable) => {
      expect(buildOscarRamNotice({
        requestedModel: PRO,
        hardware: { ram_available_gb: ramAvailable },
      })).toBeNull();
    },
  );
});
