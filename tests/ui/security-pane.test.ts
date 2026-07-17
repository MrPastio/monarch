import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  executeCapability: vi.fn(),
  executeConfirmedCapability: vi.fn(),
}));

vi.mock('../../src/ui/public/modules/api.js', () => ({
  executeCapability: apiMocks.executeCapability,
  executeConfirmedCapability: apiMocks.executeConfirmedCapability,
}));

describe('Security pane rendering', () => {
  beforeEach(() => {
    vi.resetModules();
    apiMocks.executeCapability.mockReset();
    apiMocks.executeConfirmedCapability.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts a non-blocking benchmark, renders progress, and cancels the exact owned job', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      benchmarkBusy: false,
      benchmarkJob: null,
      status: securityStatus(true),
      lastResult: null,
      audit: null,
      error: '',
    };
    const jobId = '12345678-1234-1234-1234-123456789abc';
    apiMocks.executeConfirmedCapability
      .mockResolvedValueOnce({ ok: true, output: { jobId, status: 'running', durationSeconds: 300, elapsedSeconds: 15, progressPercent: 5 } })
      .mockResolvedValueOnce({ ok: true, output: { jobId, status: 'cancelled', durationSeconds: 300, elapsedSeconds: 16, progressPercent: 5, error: 'Cancelled by user.' } });
    const { initSecurityPane, renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    initSecurityPane(renderSecurity);

    elements['#security-benchmark-start'].click();
    await vi.waitFor(() => expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state.security.benchmarkJob?.status).toBe('running'));
    renderSecurity();
    expect(elements['#security-benchmark-status'].innerHTML).toContain('Идёт наблюдение');
    expect(elements['#security-benchmark-status'].innerHTML).toContain('5%');
    expect(elements['#security-benchmark-start'].hidden).toBe(true);
    expect(elements['#security-benchmark-cancel'].hidden).toBe(false);

    elements['#security-benchmark-cancel'].click();
    await vi.waitFor(() => expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.security.benchmarkJob?.status).toBe('cancelled'));
    expect(apiMocks.executeConfirmedCapability).toHaveBeenLastCalledWith(
      'security', 'security.benchmark.cancel', { jobId }, 'ui:security',
    );
    renderSecurity();
    expect(elements['#security-benchmark-status'].innerHTML).toContain('Остановлено');
    expect(elements['#security-benchmark-start'].hidden).toBe(false);
  });

  it('previews persistence changes and binds approval to the displayed digest', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = { busy: false, statusBusy: false, baselineBusy: false, baselinePreview: null, baselineFeedback: '', status: securityStatus(true), error: '' };
    const digest = 'a'.repeat(64);
    apiMocks.executeCapability.mockResolvedValue({
      ok: true,
      result: { ok: true, output: { payload: {
        digest,
        counts: { added: 1, changed: 1, removed: 0, unchanged: 4 },
        changes: [
          { status: 'changed', key: 'run_key:hkcu\\software\\run\\updater' },
          { status: 'added', key: 'scheduled_task:\\vendor\\sync' },
        ],
        changes_truncated: 0,
      } } },
    });
    apiMocks.executeConfirmedCapability.mockResolvedValue({ ok: true, output: { payload: { ok: true, digest } } });
    const { initSecurityPane, renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    initSecurityPane(renderSecurity);

    elements['#security-baseline'].click();
    await vi.waitFor(() => expect(state.security.baselinePreview?.digest).toBe(digest));
    renderSecurity();
    expect(elements['#security-baseline-preview'].innerHTML).toContain('Изменения автозапуска');
    expect(elements['#security-baseline-preview'].innerHTML).toContain('run_key:hkcu\\software\\run\\updater');
    expect(elements['#security-baseline-preview'].innerHTML).toContain('Одобрить эту норму');

    elements['#security-baseline-preview'].click({
      closest: (selector: string) => selector === '[data-security-baseline-approve]' ? {} : null,
    });
    await vi.waitFor(() => expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledOnce());
    expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledWith(
      'security', 'security.baseline.write', { scope: 'persistence', expectedDigest: digest }, 'ui:security',
    );
    await vi.waitFor(() => expect(state.security.baselinePreview).toBeNull());
    expect(state.security.baselineFeedback).toContain('HMAC-защищена');
  });

  it('keeps failed confirmed action details visible in the Security panel', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: {
        ok: true,
        summary: 'Security status loaded.',
        output: {
          payload: {
            running: true,
            pid: 9001,
            audit_log_path: 'E:\\Monarch\\security\\logs\\old-audit.jsonl',
          },
        },
      },
      lastResult: null,
      audit: null,
      error: '',
    };
    const { initSecurityPane, renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    const failedResult = {
      ok: false,
      summary: 'Security protection startup timed out before reporting running status; launch PID 4242; log E:\\Monarch\\security\\logs\\protector.out.log. Command exited with 1.',
      output: {
        command: ['start', '--no-llm'],
        payload: {
          started: false,
          running: false,
          reason: 'startup_timeout',
          launch_pid: 4242,
          log_path: 'E:\\Monarch\\security\\logs\\protector.out.log',
        },
      },
    };
    const error = Object.assign(new Error(failedResult.summary), { result: failedResult });
    apiMocks.executeConfirmedCapability.mockRejectedValue(error);

    let rendered = 0;
    initSecurityPane(() => {
      rendered += 1;
      renderSecurity();
    });
    elements['#security-start'].click();
    await vi.waitFor(() => expect(rendered).toBeGreaterThan(0));

    expect(state.security.lastResult).toBe(failedResult);
    expect(elements['#security-summary'].innerHTML).toContain('startup timed out');
    expect(elements['#security-summary'].innerHTML).toContain('сбой');
    expect(elements['#security-runtime-label'].textContent).toBe('сбой');
    expect(elements['#security-runtime'].innerHTML).toContain('startup_timeout');
    expect(elements['#security-runtime'].innerHTML).toContain('protector.out.log');
    expect(elements['#security-runtime'].innerHTML).not.toContain('9001');
    expect(elements['#security-summary'].innerHTML).not.toContain('Что-то сломалось');
  });

  it('shows only the protection action that matches the real running state', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: securityStatus(false),
      lastResult: null,
      audit: null,
      error: '',
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');

    renderSecurity();
    expect(elements['#security-start'].hidden).toBe(false);
    expect(elements['#security-stop'].hidden).toBe(true);
    expect(elements['#security-start'].disabled).toBe(false);

    state.security.status = securityStatus(true, true);
    renderSecurity();
    expect(elements['#security-start'].hidden).toBe(true);
    expect(elements['#security-stop'].hidden).toBe(false);
    expect(elements['#security-stop'].disabled).toBe(false);

    state.security.busy = true;
    renderSecurity();
    expect(elements['#security-start'].hidden).toBe(true);
    expect(elements['#security-stop'].hidden).toBe(false);
    expect(elements['#security-stop'].disabled).toBe(true);

    state.security.status = securityStatus(false);
    renderSecurity();
    expect(elements['#security-start'].hidden).toBe(false);
    expect(elements['#security-stop'].hidden).toBe(true);
    expect(elements['#security-start'].disabled).toBe(true);
  });

  it('keeps the stopped action visible while busy and switches after a successful start', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: securityStatus(false),
      lastResult: null,
      audit: null,
      error: '',
    };
    apiMocks.executeConfirmedCapability.mockResolvedValue(securityStatus(true));
    apiMocks.executeCapability.mockResolvedValue(securityStatus(true));
    const { initSecurityPane, renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    initSecurityPane(renderSecurity);
    renderSecurity();

    elements['#security-start'].click();
    expect(elements['#security-start'].hidden).toBe(false);
    expect(elements['#security-start'].disabled).toBe(true);
    expect(elements['#security-stop'].hidden).toBe(true);

    await vi.waitFor(() => expect(elements['#security-stop'].hidden).toBe(false));
    expect(elements['#security-start'].hidden).toBe(true);
    expect(elements['#security-stop'].disabled).toBe(false);
    expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledWith(
      'security',
      'security.protection.start',
      { noLlm: true },
      'ui:security',
    );
  });

  it('explains the real degraded protection state instead of implying full coverage', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: {
        ok: true,
        summary: 'Security is degraded.',
        output: { payload: { running: true, protection_state: 'degraded' } },
      },
      lastResult: null,
      audit: null,
      error: '',
      incidents: [],
      recentScans: [],
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');

    renderSecurity();

    expect(elements['#security-protection-title'].textContent).toBe('Защита работает частично');
    expect(elements['#security-protection-copy'].textContent).toContain('датчиков требуют внимания');
    expect(elements['#security-start'].hidden).toBe(true);
    expect(elements['#security-stop'].hidden).toBe(false);
  });

  it('renders the incident risk, evidence, and safe next steps in one workspace', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: securityStatus(true),
      lastResult: null,
      audit: null,
      error: '',
      incidentsBusy: false,
      incidents: {
        ok: true,
        output: { payload: { incidents: [{
          incident_id: 'inc-42',
          title: 'Suspicious executable activity',
          primary_subject: 'E:\\Downloads\\sample.exe',
          risk_score: 612,
          status: 'open',
          decision_required: true,
          updated_at: '2026-07-11T01:00:00Z',
          evidence_families: ['process', 'network'],
          evidence: [
            { evidence_id: 'ev-process', family: 'process', kind: 'process_spawn', observed_at: '2026-07-11T01:00:00Z' },
            { evidence_id: 'ev-network', family: 'network', kind: 'network.connection_seen', observed_at: '2026-07-11T01:00:01Z' },
          ],
          attack_chain: {
            corroborated: true,
            affects_risk_score: false,
            nodes: [
              { id: 'ev-process', family: 'process', kind: 'process_spawn', label: 'sample.exe', score: 90 },
              { id: 'ev-network', family: 'network', kind: 'network.connection_seen', label: '203.0.113.7:4444', score: 85 },
            ],
            edges: [{ from: 'ev-process', to: 'ev-network', relation: 'shared_process' }],
          },
          recommended_actions: ['isolate', 'continue_monitoring'],
        }] } },
      },
      selectedIncidentId: 'inc-42',
      recentScans: [],
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');

    renderSecurity();

    expect(elements['#security-incident-summary-count'].textContent).toBe('1');
    expect(elements['#security-incident-list'].innerHTML).toContain('612');
    expect(elements['#security-incident-list'].innerHTML).toContain('sample.exe');
    expect(elements['#security-incident-detail'].innerHTML).toContain('612 / 800');
    expect(elements['#security-incident-detail'].innerHTML).toContain('process_spawn');
    expect(elements['#security-incident-detail'].innerHTML).toContain('Цепочка атаки');
    expect(elements['#security-incident-detail'].innerHTML).toContain('тот же процесс');
    expect(elements['#security-incident-detail'].innerHTML).toContain('не меняет риск');
    expect(elements['#security-incident-detail'].innerHTML).toContain('Предложить изоляцию');
    expect(elements['#security-incident-detail'].innerHTML).toContain('Событие безопасно');
  });

  it('renders the live Network Center workspace', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: securityStatus(true),
      lastResult: null,
      audit: null,
      error: '',
      activeTab: 'network',
      networkBusy: false,
      networkCenter: {
        ok: true,
        summary: 'Network Center state loaded.',
        output: { payload: {
          summary: { active_connections: 3, listeners: 2, profiles: 1, high_attention: 0 },
          profiles: [{ profile_id: '0123456789abcdef01234567', interface_alias: 'Wi-Fi', ipv4: ['192.168.1.10/24'], trusted: false, current: true }],
          connections: [{ risk_score: 8, facts: { remote_domain: 'example.com', remote_port: 443, process_name: 'browser.exe' } }],
          listeners: [{ risk_score: 24, facts: { local_address: '0.0.0.0', local_port: 8080, process_name: 'server.exe' } }],
          history: [],
        } },
      },
      responseServiceStatus: { ok: true, output: { payload: { running: true, integrity_ok: true, active_actions: 1 } } },
      responseActions: { ok: true, output: { payload: { actions: [{ action: 'block_network', status: 'active', scope: { remote_address: '203.0.113.10', remote_port: 443 }, expires_at: '2026-07-11T00:30:00+00:00' }] } } },
      incidents: null,
      recentScans: [],
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');

    renderSecurity();

    expect(elements['#security-network-result'].innerHTML).toContain('Критических сетевых сигналов нет');
    expect(elements['#security-network-metrics'].innerHTML).toContain('Подключения');
    expect(elements['#security-network-profiles'].innerHTML).toContain('Wi-Fi');
    expect(elements['#security-network-connections'].innerHTML).toContain('example.com:443');
    expect(elements['#security-network-listeners'].innerHTML).toContain('0.0.0.0:8080');
    expect(elements['#security-response-service'].textContent).toContain('Исполнитель работает');
    expect(elements['#security-response-actions'].innerHTML).toContain('203.0.113.10:443');
  });

  it('shows bounded network containment only for evidence-backed endpoints and a live executor', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: securityStatus(true),
      lastResult: null,
      audit: null,
      error: '',
      incidentsBusy: false,
      incidents: { ok: true, output: { payload: { incidents: [{
        incident_id: 'net-1', title: 'Suspicious network activity', primary_subject: '203.0.113.10:443',
        risk_score: 420, status: 'open', decision_required: true, evidence_families: ['network'],
        evidence: [{ family: 'network', kind: 'network.connection_seen', response_scope: { remote_address: '203.0.113.10', remote_port: 443, protocol: 'tcp', direction: 'outbound' } }],
        recommended_actions: ['preserve', 'block_network'],
      }] } } },
      selectedIncidentId: 'net-1',
      responseServiceStatus: { ok: true, output: { payload: { running: true, integrity_ok: true } } },
      recentScans: [],
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    renderSecurity();
    expect(elements['#security-incident-detail'].innerHTML).toContain('203.0.113.10:443');
    expect(elements['#security-incident-detail'].innerHTML).toContain('Подготовить блокировку');
    expect(elements['#security-incident-detail'].innerHTML).toContain('автоматический откат');
  });

  it('renders fail-open emergency recovery without pretending to replace Windows login', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: securityStatus(true),
      lastResult: null,
      audit: null,
      error: '',
      incidents: null,
      recentScans: [],
      emergency: { ok: true, output: { payload: {
        active: true, state: 'awaiting_user', risk_score: 740,
        expires_at: '2026-07-11T02:00:00Z', native_lock_succeeded: true,
        reason: 'Awaiting user decision',
      } } },
      responseServiceStatus: { ok: true, output: { payload: { running: false } } },
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    renderSecurity();
    expect(elements['#security-emergency-panel'].hidden).toBe(false);
    expect(elements['#security-emergency-copy'].textContent).toContain('Windows был заблокирован штатным механизмом');
    expect(elements['#security-emergency-copy'].textContent).toContain('740/800');
    expect(elements['#security-emergency-release'].disabled).toBe(false);
    expect(elements['#security-emergency-continue'].disabled).toBe(true);
    expect(elements['#security-stop'].disabled).toBe(true);
  });

  it('renders quarantine provenance and a restore action without exposing delete', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: securityStatus(true),
      lastResult: null,
      audit: null,
      error: '',
      incidents: null,
      recentScans: [],
      quarantineBusy: false,
      quarantine: {
        ok: true,
        output: { payload: { records: [{
          quarantine_id: 'q-1',
          original_path: 'E:\\Downloads\\sample.exe',
          sha256: 'abcdef1234567890abcdef1234567890',
          size: 2048,
        }] } },
      },
      pinStatus: {
        ok: true,
        output: { payload: { configured: true, locked: false, failed_attempts: 0, recovery_codes_remaining: 8 } },
      },
      recoveryCodes: ['AAAA-BBBB-CCCC-DDDD-EEEE', 'FFFF-GGGG-HHHH-JJJJ-KKKK'],
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');

    renderSecurity();

    expect(elements['#security-quarantine-list'].innerHTML).toContain('sample.exe');
    expect(elements['#security-quarantine-list'].innerHTML).toContain('abcdef1234567890');
    expect(elements['#security-quarantine-list'].innerHTML).toContain('2.0 KB');
    expect(elements['#security-quarantine-list'].innerHTML).toContain('Восстановить');
    expect(elements['#security-quarantine-list'].innerHTML).not.toContain('Удалить');
    expect(elements['#security-pin-status'].textContent).toContain('Настроен');
    expect(elements['#security-pin-current-wrap'].hidden).toBe(false);
    expect(elements['#security-pin-save'].textContent).toBe('Сменить PIN');
    expect(elements['#security-pin-recovery-codes'].innerHTML).toContain('AAAA-BBBB-CCCC-DDDD-EEEE');
    expect(elements['#security-pin-recovery-codes'].textContent).not.toContain('AAAA-BBBB-CCCC-DDDD-EEEE');
    expect(elements['#security-pin-recovery-clear'].hidden).toBe(false);
  });

  it('recovers a forgotten PIN without persisting or echoing the submitted recovery code', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      pinBusy: false,
      pinStatus: { ok: true, output: { payload: { configured: true, locked: false, recovery_codes_remaining: 8 } } },
      pinFeedback: '',
      recoveryCodes: [],
      error: '',
    };
    apiMocks.executeConfirmedCapability.mockResolvedValue({
      ok: true,
      output: { payload: { ok: true, status: { recovery_codes: ['NEW2-CODE-2222-3333-4444'] } } },
    });
    apiMocks.executeCapability.mockResolvedValue({
      ok: true,
      result: { ok: true, output: { payload: { configured: true, locked: false, recovery_codes_remaining: 8 } } },
    });
    const { initSecurityPane, renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    initSecurityPane(renderSecurity);
    elements['#security-pin-recovery-code'].value = 'OLD2-CODE-2222-3333-4444';
    elements['#security-pin-new'].value = '739105';
    elements['#security-pin-confirm'].value = '739105';

    elements['#security-pin-recover'].click();
    await vi.waitFor(() => expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(state.security.pinBusy).toBe(false));

    expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledWith(
      'security',
      'security.pin.recover',
      { recoveryCode: 'OLD2-CODE-2222-3333-4444', newPin: '739105', confirmation: '739105' },
      'ui:security',
    );
    expect(elements['#security-pin-recovery-code'].value).toBe('');
    expect(elements['#security-pin-new'].value).toBe('');
    expect(state.security.recoveryCodes).toEqual(['NEW2-CODE-2222-3333-4444']);
    expect(elements['#security-pin-recovery-codes'].innerHTML).not.toContain('OLD2-CODE');
  });

  it('renders measured replay detection, false-positive, and p95 latency metrics', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      status: securityStatus(true),
      replayMetrics: {
        ok: true,
        output: { payload: {
          passed: true,
          case_count: 5,
          benign_case_count: 3,
          metrics: {
            detection_rate: 1,
            false_positive_rate: 0,
            case_latency_ms_p95: 4.125,
            protector_idle: { available: true, cpu_percent: 0.5, cpu_percent_p95: 8.75, rss_bytes: 10485760 },
            replay_process_burst: { available: true, cpu_percent: 12.25, system_cpu_percent: 18.5, rss_peak_observed_bytes: 20971520 },
            sensor_to_incident: { available: true, latency_ms_p95: 3.75 },
            coverage: {
              attack_families: ['rat', 'persistence', 'exfiltration'],
              benign_workloads: ['administrator', 'developer', 'network_admin'],
            },
          },
        } },
      },
      error: '',
    };
    const { renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');

    renderSecurity();

    expect(elements['#security-replay-metrics'].innerHTML).toContain('100%');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('0%');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('4.13 ms');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('0.50%');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('8.75%');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('10.0 MB');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('12.25%');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('18.50%');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('20.0 MB');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('3.75 ms');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('5 атак / 3 benign');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('RAT · автозапуск · эксфильтрация');
    expect(elements['#security-replay-metrics'].innerHTML).toContain('администрирование · разработка · настройка сети');
  });

  it('keeps the edited Oscar policy values while saving Security settings', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: {
        ok: true,
        output: { payload: {
          running: true,
          profile: { level: 'balanced' },
          model_policy: { enabled: true, confirmation_mode: 'adaptive' },
        } },
      },
      lastResult: null,
      audit: null,
      error: '',
      modelPolicyFeedback: '',
    };
    apiMocks.executeConfirmedCapability.mockResolvedValue({
      ok: true,
      output: { payload: { enabled: false, confirmation_mode: 'always' } },
    });
    apiMocks.executeCapability.mockResolvedValue(state.security.status);
    const { initSecurityPane, renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');
    initSecurityPane(renderSecurity);
    renderSecurity();

    elements['#security-model-commands-enabled'].checked = false;
    elements['#security-model-confirmation'].value = 'always';
    elements['#security-model-policy-save'].click();

    await vi.waitFor(() => expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledOnce());
    expect(apiMocks.executeConfirmedCapability).toHaveBeenCalledWith(
      'security',
      'security.model_policy.set',
      { enabled: false, confirmationMode: 'always' },
      'ui:security',
    );
  });

  it('does not launch incident and PIN checks when the Security profile is off', async () => {
    const elements = createSecurityDom();
    vi.stubGlobal('document', {
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: () => [],
    });
    const { state } = await import('../../src/ui/public/modules/state.js');
    state.security = {
      busy: false,
      statusBusy: false,
      status: null,
      lastResult: null,
      emergency: null,
      error: '',
    };
    apiMocks.executeCapability.mockImplementation(async (_moduleId: string, capabilityId: string) => ({
      ok: true,
      output: { payload: capabilityId === 'security.status'
        ? { running: false, profile: { level: 'off' }, model_policy: { enabled: true, confirmation_mode: 'adaptive' } }
        : { active: false } },
    }));
    const { loadSecurityStatus, renderSecurity } = await import('../../src/ui/public/modules/security-pane.js');

    await loadSecurityStatus(renderSecurity);

    expect(apiMocks.executeCapability).toHaveBeenCalledTimes(2);
    expect(apiMocks.executeCapability.mock.calls.map((call) => call[1])).toEqual([
      'security.status',
      'security.emergency.status',
    ]);
  });
});

function securityStatus(running: boolean, nested = false) {
  return {
    ok: true,
    summary: running
      ? 'Monarch Security background protection is running.'
      : 'Monarch Security background protection is stopped.',
    output: {
      payload: nested ? { runtime: { running } } : { running },
    },
  };
}

function createSecurityDom(): Record<string, FakeElement> {
  const selectors = [
    '#security-status-pills',
    '#security-protection-title',
    '#security-protection-copy',
    '#security-refresh',
    '#security-scan-system',
    '#security-integrity',
    '#security-audit',
    '#security-baseline',
    '#security-baseline-preview',
    '#security-replay',
    '#security-replay-metrics',
    '#security-benchmark-start',
    '#security-benchmark-cancel',
    '#security-benchmark-status',
    '#security-start',
    '#security-stop',
    '#security-summary',
    '#security-findings',
    '#security-runtime-label',
    '#security-runtime',
    '#security-audit-label',
    '#security-audit-output',
    '#security-overview-panel',
    '#security-incidents-panel',
    '#security-network-panel',
    '#security-quarantine-panel',
    '#security-settings-panel',
    '#security-scan-feedback',
    '#security-recent-scans',
    '#security-recent-count',
    '#security-incident-summary-copy',
    '#security-incident-summary-count',
    '#security-incident-tab-count',
    '#security-incident-list',
    '#security-incident-detail',
    '#security-network-result',
    '#security-network-metrics',
    '#security-network-profiles',
    '#security-network-connections',
    '#security-network-listeners',
    '#security-network-history',
    '#security-response-service',
    '#security-response-actions',
    '#security-quarantine-list',
    '#security-quarantine-refresh',
    '#security-pin-status',
    '#security-pin-current-wrap',
    '#security-pin-current',
    '#security-pin-new',
    '#security-pin-confirm',
    '#security-pin-save',
    '#security-pin-feedback',
    '#security-pin-recovery-code',
    '#security-pin-recover',
    '#security-pin-recovery-codes',
    '#security-pin-recovery-clear',
    '#security-emergency-panel',
    '#security-emergency-title',
    '#security-emergency-copy',
    '#security-emergency-pin',
    '#security-emergency-release',
    '#security-emergency-continue',
    '#security-emergency-feedback',
    '#security-settings-status',
    '#security-model-commands-enabled',
    '#security-model-confirmation',
    '#security-model-policy-save',
    '#security-model-policy-feedback',
  ];
  return Object.fromEntries(selectors.map((selector) => [selector, new FakeElement()]));
}

class FakeElement {
  innerHTML = '';
  textContent = '';
  className = '';
  disabled = false;
  hidden = false;
  value = '';
  checked = true;
  private listeners = new Map<string, (event?: any) => void>();

  querySelectorAll(): FakeElement[] {
    return [];
  }

  addEventListener(event: string, listener: (event?: any) => void): void {
    this.listeners.set(event, listener);
  }

  click(target: any = this): void {
    this.listeners.get('click')?.({ target });
  }
}
