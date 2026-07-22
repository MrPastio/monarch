import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync('oscar/frontend/src/App.tsx', 'utf8');
const styles = readFileSync('oscar/frontend/src/styles.css', 'utf8');
const thinkingOrbSource = readFileSync('oscar/frontend/src/components/ThinkingOrb.tsx', 'utf8');

describe('Oscar React preview invariants', () => {
  it('keeps one authoritative dark token block', () => {
    const rootBlocks = [...styles.matchAll(/:root\s*\{([\s\S]*?)\}/g)];

    expect(rootBlocks).toHaveLength(1);
    expect(rootBlocks[0]?.[1]).toContain('--bg-app: #08090a');
    expect(rootBlocks[0]?.[1]).toContain('--text-base: #F7F7F5');
    expect(styles).not.toContain('--bg-app: #ffffff');
    expect(styles).not.toContain('--text-base: #10100f');
  });

  it('restores the compact sidebar before the mobile single-column breakpoint', () => {
    const compactStart = styles.lastIndexOf('@media (max-width: 980px)');
    const mobileStart = styles.lastIndexOf('@media (max-width: 620px)');
    const compactRules = styles.slice(compactStart, mobileStart);
    const mobileRules = styles.slice(mobileStart);

    expect(compactStart).toBeGreaterThan(0);
    expect(mobileStart).toBeGreaterThan(compactStart);
    expect(compactRules).toContain('grid-template-columns: 72px minmax(0, 1fr)');
    expect(compactRules).toMatch(/\.workspace > \.sidebar:not\(\.inspector\)\s*\{[^}]*display:\s*flex/);
    expect(mobileRules).toMatch(/\.content-pane\s*\{[^}]*min-height:\s*100dvh;[^}]*height:\s*100dvh/);
  });

  it('owns cancellation from route preview through stream cleanup', () => {
    const sendStart = appSource.indexOf('async function sendMessage()');
    const stopStart = appSource.indexOf('function stopGeneration()');
    const stopEnd = appSource.indexOf('function cycleDeepThinking()', stopStart);
    const sendSource = appSource.slice(sendStart, stopStart);
    const stopSource = appSource.slice(stopStart, stopEnd);

    expect(sendSource.indexOf('const controller = new AbortController()')).toBeLessThan(
      sendSource.indexOf('await previewChatRoute(payload, controller.signal)'),
    );
    expect(sendSource).toContain('if (abortRef.current === controller)');
    expect(sendSource).toContain('await cancelRequestRef.current');
    expect(stopSource).toContain('cancelGeneration()');
    expect(stopSource).toContain('controller.abort()');
    expect(stopSource).not.toContain('setBusy(false)');
  });

  it('does not expose session counters as inert navigation buttons', () => {
    const navItemStart = appSource.indexOf('function NavItem(');
    const navItemEnd = appSource.indexOf('function SourceList(', navItemStart);
    const navItemSource = appSource.slice(navItemStart, navItemEnd);

    expect(appSource).toContain('aria-label="Сводка сессии"');
    expect(navItemSource).toContain('<div className={`nav-item');
    expect(navItemSource).not.toContain('<button');
  });

  it('uses the Illuma ThinkingOrb as a bounded state-aware stream signal', () => {
    expect(appSource).toContain("import { ThinkingOrb } from './components/ThinkingOrb'");
    expect(thinkingOrbSource).toContain('@illuma-ai/icons/brand ThinkingOrb 2.7.0 (MIT)');
    expect(appSource).toContain('function resolveStreamOrbPhase(');
    expect(appSource).toContain('data-orb-phase={phase}');
    expect(styles).toContain('.monarch-thinking-orb[data-orb-phase="search"]');
    expect(styles).toContain('.monarch-thinking-orb__core');
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.monarch-thinking-orb__core/);
  });

  it('keeps ordinary thinking orb-only and reserves activity copy for research or search', () => {
    expect(appSource).toContain('function isResearchOrSearchStream(');
    expect(appSource).toContain('className="message-row assistant thinking-orb-only"');
    expect(appSource).toContain('className="stream-live orb-only"');
    expect(appSource).toContain('isStreaming && detailedStream ? <StreamProgress');
    expect(styles).toContain('.stream-live.orb-only');
    expect(styles).toContain('.message-row.assistant.thinking-orb-only');
  });
});
