import { state } from './state.js';
import { renderOscar } from './oscar-pane.js';
import { renderSecurity } from './security-pane.js';

/**
 * Lightweight frontend DOM interaction sanity tests.
 * Can be triggered from the browser console or during automated UI testing to verify bindings.
 */
export function runTestSuite() {
  console.log('--- STARTING FRONTEND DOM SANITY TESTS ---');
  const results = {
    passed: 0,
    failed: 0,
    logs: []
  };

  function assert(condition, message) {
    if (condition) {
      results.passed++;
      results.logs.push(`[PASS] ${message}`);
    } else {
      results.failed++;
      results.logs.push(`[FAIL] ${message}`);
      console.error(`[TEST FAILURE] ${message}`);
    }
  }

  try {
    // 1. Verify Navigation handler targets exist
    const navItems = Array.from(document.querySelectorAll('.nav-item'));
    assert(navItems.length > 0, `Found ${navItems.length} navigation buttons in DOM.`);

    navItems.forEach((item, index) => {
      const targetId = item.getAttribute('data-scroll-target');
      assert(!!targetId, `Nav item ${index} has data-scroll-target="${targetId}"`);
      const targetEl = document.getElementById(targetId);
      assert(!!targetEl, `Nav target element #${targetId} exists in DOM`);
    });

    // 2. Verify Command Composer elements exist
    const composer = document.querySelector('#composer');
    const intentInput = document.querySelector('#intent-input');
    const intentVoiceButton = document.querySelector('#intent-voice-input');
    const sendButton = document.querySelector('.send-button');
    assert(!!composer, 'Composer form (#composer) exists');
    assert(!!intentInput, 'Intent input (#intent-input) exists');
    assert(!!intentVoiceButton, 'Intent voice input button exists');
    assert(!!sendButton, 'Send button (.send-button) exists');

    // 3. Verify Oscar Panel controls exist
    const oscarComposer = document.querySelector('#oscar-composer');
    const oscarInput = document.querySelector('#oscar-input');
    const oscarVoiceButton = document.querySelector('#oscar-voice-mode');
    const oscarRefresh = document.querySelector('#oscar-refresh');
    const oscarClear = document.querySelector('#oscar-clear');
    assert(!!oscarComposer, 'Oscar composer form exists');
    assert(!!oscarInput, 'Oscar textarea input exists');
    assert(!!oscarVoiceButton, 'Oscar voice mode button exists');
    assert(!!oscarRefresh, 'Oscar refresh button exists');
    assert(!!oscarClear, 'Oscar clear button exists');

    // 4. Verify Security Center surface exists
    const securitySummary = document.querySelector('#security-summary');
    const securityFindings = document.querySelector('#security-findings');
    assert(!!securitySummary, 'Security summary container exists');
    assert(!!securityFindings, 'Security findings container exists');

    // 5. Test nav click switching programmatically
    if (navItems.length > 1) {
      const prevActive = document.querySelector('.nav-item.active');
      const testTab = navItems[1]; // e.g. Oscar tab

      // Simulate click
      testTab.click();

      // Check if it scrolled/worked
      const newActive = document.querySelector('.nav-item.active');
      assert(!!newActive, 'Active tab indicator exists after click');

      // Revert active tab
      if (prevActive) {
        prevActive.click();
      }
    }

    // 6. Test state rendering updates
    const initialOscarMessages = [...(state.oscar?.messages || [])];
    state.oscar = state.oscar || {};
    state.oscar.messages = [{ id: 'test_msg', role: 'user', content: 'hello test', label: 'test' }];
    renderOscar();

    const threadContent = document.querySelector('#oscar-thread');
    assert(threadContent && threadContent.innerHTML.includes('hello test'), 'Oscar thread render updates successfully on state changes');

    // Revert state
    state.oscar.messages = initialOscarMessages;
    renderOscar();

    console.log(`--- TEST RESULTS: ${results.passed} passed, ${results.failed} failed ---`);
    results.logs.forEach(log => console.log(log));
  } catch (err) {
    results.failed++;
    console.error('Crash in frontend test suite:', err);
  }

  return results;
}

// Attach to window so it can be called easily from Electron DevTools
if (typeof window !== 'undefined') {
  window.runFrontendTestSuite = runTestSuite;
}
