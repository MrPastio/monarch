import type { MonarchAgentCapabilityMetadataInput, MonarchModuleManifest } from '../../core';

function observationAgent(effectKind: string, description: string): MonarchAgentCapabilityMetadataInput {
  return {
    tags: ['windows', 'computer-use', 'observation', 'uia', 'screenshot'],
    effects: [{ kind: effectKind, description, targetScope: 'application' }],
    idempotency: 'idempotent',
    reversibility: 'automatic',
    effectProfile: {
      mutation: 'none',
      targetScope: 'application',
      reversibility: 'automatic',
      privilege: 'normal',
      dataSensitivity: 'private',
      communication: 'none',
      financialImpact: false,
      identityImpact: false,
      securityImpact: false,
    },
    supportedSources: ['desktop', 'api', 'system', 'smoke', 'coder'],
    estimatedLatency: 'short',
    computeClass: 'light',
    cancellation: 'supported',
    verification: [{
      kind: 'external-receipt',
      description: 'The native Windows provider must return a bounded observation receipt.',
      required: true,
      predicate: { kind: 'status', target: 'result.output.verified', value: true },
    }],
  };
}

function actionAgent(
  effectKind: string,
  description: string,
  reversibility: 'automatic' | 'manual' = 'manual',
): MonarchAgentCapabilityMetadataInput {
  return {
    tags: ['windows', 'computer-use', 'cursor', 'keyboard', 'uia'],
    preconditions: [{
      kind: 'fresh-window-observation',
      description: 'Requires the latest unused observation of the exact window and rejects stale or ambiguous state.',
    }],
    effects: [{ kind: effectKind, description, targetScope: 'application' }],
    idempotency: 'non-idempotent',
    reversibility,
    effectProfile: {
      mutation: 'temporary',
      targetScope: 'application',
      reversibility,
      privilege: 'elevated',
      dataSensitivity: 'private',
      communication: 'none',
      financialImpact: false,
      identityImpact: false,
      securityImpact: true,
    },
    supportedSources: ['desktop', 'api', 'system', 'smoke', 'coder'],
    estimatedLatency: 'short',
    computeClass: 'light',
    // Cancellation first revokes the persisted native input lease. The helper
    // cooperatively checks that receipt between animation/input transitions,
    // while the bridge retains a bounded process-termination fallback.
    cancellation: 'supported',
    verification: [{
      kind: 'read-after-write',
      description: 'The provider must capture a new observation immediately after dispatch and bind it to the action receipt.',
      required: true,
      predicate: { kind: 'status', target: 'result.output.verified', value: true },
    }],
  };
}

function closeActionAgent(): MonarchAgentCapabilityMetadataInput {
  const metadata = actionAgent(
    'window-close',
    'Closes one exact observed top-level window and verifies that the native handle is no longer visible.',
    'manual',
  );
  return {
    ...metadata,
    verification: [
      {
        kind: 'external-receipt',
        description: 'The native provider must verify that the exact observed window is no longer visible.',
        required: true,
        predicate: { kind: 'status', target: 'result.output.verified', value: true },
      },
      {
        kind: 'read-after-write',
        description: 'The exact native window handle must be reported closed after dispatch.',
        required: true,
        predicate: { kind: 'status', target: 'result.output.closed', value: true },
      },
    ],
  };
}

const exactWindowInput = {
  windowRef: { type: 'string', pattern: '^hwnd:[0-9A-Fa-f]{8,16}$' },
  observationId: { type: 'string', minLength: 8, maxLength: 160 },
};

const actionOutputSchema = {
  type: 'object',
  properties: {
    performed: { type: 'boolean' },
    verified: { type: 'boolean' },
    actionReceiptId: { type: 'string' },
    beforeObservationId: { type: 'string' },
    afterObservationId: { type: 'string' },
    windowRef: { type: 'string' },
    after: { type: 'object' },
  },
  required: [
    'performed',
    'verified',
    'actionReceiptId',
    'beforeObservationId',
    'afterObservationId',
    'windowRef',
    'after',
  ],
  additionalProperties: true,
};

const closeActionOutputSchema = {
  type: 'object',
  properties: {
    performed: { type: 'boolean' },
    verified: { type: 'boolean' },
    closed: { type: 'boolean' },
    actionReceiptId: { type: 'string' },
    beforeObservationId: { type: 'string' },
    windowRef: { type: 'string' },
  },
  required: ['performed', 'verified', 'closed', 'actionReceiptId', 'beforeObservationId', 'windowRef'],
  additionalProperties: true,
};

export const computerManifest: MonarchModuleManifest = {
  id: 'computer',
  name: 'Monarch Computer Use',
  version: '0.1.0',
  stage: 'alpha',
  kind: 'domain',
  description: 'Fresh screenshot and Windows UI Automation observations with one-shot cursor and keyboard actions through Kernel.',
  owns: [
    'computer use',
    'windows ui automation',
    'screen observation',
    'mouse cursor',
    'keyboard input',
    'управление компьютером',
    'экран',
    'курсор',
  ],
  permissions: ['none', 'read', 'device-control'],
  events: [
    'computer.activated',
    'computer.control.changed',
    'computer.windows.listed',
    'computer.window.observed',
    'computer.window.analyzed',
    'computer.cursor.moved',
    'computer.action.started',
    'computer.action.completed',
    'computer.action.rejected',
  ],
  capabilities: [
    {
      id: 'computer.control.status',
      moduleId: 'computer',
      title: 'Read Computer Use control state',
      description: 'Read whether Computer Use is enabled, its revocation epoch, active input lease, logical Oscar cursor, and emergency shortcut.',
      risk: 'none',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: {
          verified: { type: 'boolean' },
          control: { type: 'object' },
        },
        required: ['verified', 'control'],
        additionalProperties: false,
      },
    },
    {
      id: 'computer.control.start',
      moduleId: 'computer',
      title: 'Enable Computer Use by direct user action',
      description: 'Enable Computer Use and advance its revocation epoch. Model-owned proposals are rejected; this control belongs to the user.',
      risk: 'none',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { verified: { type: 'boolean' }, control: { type: 'object' } },
        required: ['verified', 'control'],
        additionalProperties: false,
      },
    },
    {
      id: 'computer.control.stop',
      moduleId: 'computer',
      title: 'Emergency-stop Computer Use immediately',
      description: 'Revoke the active Oscar input lease, terminate native dispatch, hide the logical cursor, invalidate every observation, and persist the stopped epoch. Never requires approval.',
      risk: 'none',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { verified: { type: 'boolean' }, stopped: { type: 'boolean' }, control: { type: 'object' } },
        required: ['verified', 'stopped', 'control'],
        additionalProperties: false,
      },
    },
    {
      id: 'computer.windows.list',
      moduleId: 'computer',
      title: 'List exact controllable Windows windows',
      description: 'Enumerate visible top-level windows and return opaque exact window references; optionally resolve one user-supplied exact title without flooding model context. Secure and credential surfaces are excluded.',
      risk: 'read',
      agent: observationAgent('window-list-observation', 'Lists bounded visible top-level windows without changing focus.'),
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          exactTitle: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
            description: 'Optional exact top-level window title copied from the trusted user request.',
          },
          titleQuery: {
            type: 'string',
            minLength: 1,
            maxLength: 160,
            description: 'Optional user-authored application/window name. Results stay read-only and input requires exactly one runtime-verified match.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          verified: { type: 'boolean' },
          windows: { type: 'array' },
          observedAt: { type: 'string' },
        },
        required: ['verified', 'windows', 'observedAt'],
        additionalProperties: true,
      },
      routing: {
        aliases: ['list windows', 'find open window', 'покажи открытые окна', 'найди окно программы'],
        keywords: ['window', 'windows', 'open apps', 'окно', 'окна', 'приложение'],
        examples: ['найди открытое окно Блокнота'],
        intentKinds: ['device-control', 'multimodal'],
      },
    },
    {
      id: 'computer.window.observe',
      moduleId: 'computer',
      title: 'Observe one exact Windows window',
      description: 'Capture one exact top-level window, its bounded UI Automation tree, focused element, image digest, and screenshot artifact.',
      risk: 'read',
      agent: observationAgent('window-state-observation', 'Captures a fresh screenshot and semantic UI tree for one exact window.'),
      inputSchema: {
        type: 'object',
        properties: {
          windowRef: exactWindowInput.windowRef,
          captureNonce: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'Optional runtime-owned capture identity. A new value forces a genuinely fresh observation instead of an idempotent ledger replay.',
          },
        },
        required: ['windowRef'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          verified: { type: 'boolean' },
          observationId: { type: 'string' },
          windowRef: { type: 'string' },
          observedAt: { type: 'string' },
          window: { type: 'object' },
          screenshot: { type: 'object' },
          elements: { type: 'array' },
        },
        required: ['verified', 'observationId', 'windowRef', 'observedAt', 'window', 'screenshot', 'elements'],
        additionalProperties: true,
      },
      routing: {
        aliases: ['observe window', 'take window screenshot', 'посмотри на окно', 'сделай скрин окна'],
        keywords: ['observe', 'screenshot', 'screen', 'window', 'посмотри', 'скрин', 'экран', 'окно'],
        examples: ['посмотри что сейчас в окне Блокнота'],
        intentKinds: ['device-control', 'multimodal'],
      },
    },
    {
      id: 'computer.window.analyze',
      moduleId: 'computer',
      title: 'Analyze a fresh window screenshot with Oscar Vision',
      description: 'Send the exact local screenshot to Oscar local vision, return bounded visual target references, and keep every coordinate server-side until a one-shot action consumes it.',
      risk: 'read',
      agent: observationAgent('window-vision-analysis', 'Analyzes the pixels of one fresh exact window observation without changing Windows state.'),
      inputSchema: {
        type: 'object',
        properties: {
          ...exactWindowInput,
          objective: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        required: ['windowRef', 'observationId', 'objective'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          verified: { type: 'boolean' },
          observationId: { type: 'string' },
          windowRef: { type: 'string' },
          summary: { type: 'string' },
          visibleText: { type: 'array' },
          targets: { type: 'array' },
        },
        required: ['verified', 'observationId', 'windowRef', 'summary', 'visibleText', 'targets'],
        additionalProperties: true,
      },
      routing: {
        aliases: ['analyze screenshot', 'find visual target', 'проанализируй скрин', 'найди на экране'],
        keywords: ['analyze', 'vision', 'visual', 'screenshot', 'анализ', 'найди', 'скрин', 'экран'],
        examples: ['найди на свежем скриншоте кнопку продолжить'],
        intentKinds: ['device-control', 'multimodal'],
      },
    },
    {
      id: 'computer.window.verify-text',
      moduleId: 'computer',
      title: 'Verify exact text in one fresh window observation',
      description: 'Check a trusted expected text against the bounded UI Automation facts of one exact fresh observation without changing Windows state.',
      risk: 'read',
      agent: observationAgent('window-text-verification', 'Verifies a trusted exact text postcondition in one fresh exact-window observation.'),
      inputSchema: {
        type: 'object',
        properties: {
          ...exactWindowInput,
          expectedText: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['windowRef', 'observationId', 'expectedText'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          verified: { type: 'boolean' },
          matched: { type: 'boolean' },
          observationId: { type: 'string' },
          windowRef: { type: 'string' },
          expectedText: { type: 'string' },
          matchedText: { type: 'string' },
        },
        required: ['verified', 'matched', 'observationId', 'windowRef', 'expectedText'],
        additionalProperties: false,
      },
      routing: {
        aliases: ['verify window text', 'check visible text', 'проверь текст в окне'],
        keywords: ['verify', 'text', 'visible', 'window', 'проверь', 'текст', 'окно'],
        examples: ['проверь, что в наблюдаемом окне появился точный результат'],
        intentKinds: ['device-control', 'multimodal'],
      },
    },
    {
      id: 'computer.window.click',
      moduleId: 'computer',
      title: 'Click once in an observed window',
      description: 'Move the real cursor and click one semantic UI element or one screenshot-relative coordinate from the latest exact observation.',
      risk: 'device-control',
      agent: actionAgent('window-click', 'Moves the cursor and dispatches one mouse click to the exact observed window.'),
      inputSchema: {
        type: 'object',
        properties: {
          ...exactWindowInput,
          elementId: { type: 'string', minLength: 2, maxLength: 100 },
          visionTargetId: { type: 'string', minLength: 8, maxLength: 160 },
          x: { type: 'integer', minimum: 0, maximum: 16384 },
          y: { type: 'integer', minimum: 0, maximum: 16384 },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          clicks: { type: 'integer', enum: [1, 2] },
        },
        required: ['windowRef', 'observationId'],
        additionalProperties: false,
      },
      outputSchema: actionOutputSchema,
      routing: {
        aliases: ['click window element', 'click screen coordinate', 'нажми в окне', 'кликни'],
        keywords: ['click', 'button', 'cursor', 'нажми', 'клик', 'курсор', 'кнопка'],
        examples: ['нажми кнопку Сохранить в наблюдаемом окне'],
        intentKinds: ['device-control'],
      },
    },
    {
      id: 'computer.window.close',
      moduleId: 'computer',
      title: 'Close one exact observed window',
      description: 'Animate Oscar’s own cursor toward the close affordance, dispatch one exact native close request, and verify that the observed top-level window is no longer visible.',
      risk: 'device-control',
      agent: closeActionAgent(),
      inputSchema: {
        type: 'object',
        properties: { ...exactWindowInput },
        required: ['windowRef', 'observationId'],
        additionalProperties: false,
      },
      outputSchema: closeActionOutputSchema,
      routing: {
        aliases: ['close window', 'quit app window', 'закрой окно', 'закрой приложение'],
        keywords: ['close', 'quit', 'exit', 'window', 'закрой', 'закрыть', 'окно', 'приложение'],
        examples: ['закрой наблюдаемое окно Logitech G HUB'],
        intentKinds: ['device-control'],
      },
    },
    {
      id: 'computer.window.type',
      moduleId: 'computer',
      title: 'Type text into one observed UI element',
      description: 'Focus one exact non-password UI Automation element from the latest observation and type bounded Unicode text through real Windows keyboard input.',
      risk: 'device-control',
      agent: actionAgent('window-text-input', 'Focuses one observed non-password element and types the exact supplied text.', 'manual'),
      inputSchema: {
        type: 'object',
        properties: {
          ...exactWindowInput,
          elementId: { type: 'string', minLength: 2, maxLength: 100 },
          text: { type: 'string', minLength: 1, maxLength: 4000 },
        },
        required: ['windowRef', 'observationId', 'elementId', 'text'],
        additionalProperties: false,
      },
      outputSchema: actionOutputSchema,
      routing: {
        aliases: ['type in window', 'enter text', 'введи текст', 'напечатай'],
        keywords: ['type', 'text', 'input', 'введи', 'напечатай', 'текст', 'поле'],
        examples: ['введи текст в наблюдаемое поле редактора'],
        intentKinds: ['device-control'],
      },
    },
    {
      id: 'computer.window.key',
      moduleId: 'computer',
      title: 'Press one key chord in an observed window',
      description: 'Activate the exact observed window and dispatch one bounded key or modifier chord; secure-desktop shortcuts are rejected by the native provider.',
      risk: 'device-control',
      agent: actionAgent('window-key-input', 'Dispatches one key chord to the exact observed window.', 'manual'),
      inputSchema: {
        type: 'object',
        properties: {
          ...exactWindowInput,
          key: {
            type: 'string',
            enum: ['enter', 'escape', 'tab', 'backspace', 'delete', 'space', 'left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'a', 'c', 'f', 'l', 'n', 'o', 'p', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'add', 'subtract', 'multiply', 'divide', 'decimal'],
          },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['ctrl', 'alt', 'shift'] },
            maxItems: 3,
            uniqueItems: true,
          },
        },
        required: ['windowRef', 'observationId', 'key'],
        additionalProperties: false,
      },
      outputSchema: actionOutputSchema,
      routing: {
        aliases: ['press key', 'keyboard shortcut', 'нажми клавишу', 'сочетание клавиш'],
        keywords: ['key', 'keyboard', 'shortcut', 'клавиша', 'клавиатура', 'сочетание'],
        examples: ['нажми Ctrl+S в наблюдаемом окне'],
        intentKinds: ['device-control'],
      },
    },
    {
      id: 'computer.window.scroll',
      moduleId: 'computer',
      title: 'Scroll once in an observed window',
      description: 'Move the cursor to one semantic element or observed coordinate and dispatch one bounded vertical mouse-wheel action.',
      risk: 'device-control',
      agent: actionAgent('window-scroll', 'Moves the cursor and dispatches one bounded wheel action in the exact observed window.'),
      inputSchema: {
        type: 'object',
        properties: {
          ...exactWindowInput,
          elementId: { type: 'string', minLength: 2, maxLength: 100 },
          visionTargetId: { type: 'string', minLength: 8, maxLength: 160 },
          x: { type: 'integer', minimum: 0, maximum: 16384 },
          y: { type: 'integer', minimum: 0, maximum: 16384 },
          deltaY: { type: 'integer', minimum: -1200, maximum: 1200 },
        },
        required: ['windowRef', 'observationId', 'deltaY'],
        additionalProperties: false,
      },
      outputSchema: actionOutputSchema,
      routing: {
        aliases: ['scroll window', 'scroll down', 'прокрути окно', 'листай'],
        keywords: ['scroll', 'wheel', 'прокрути', 'листай', 'колесо'],
        examples: ['прокрути наблюдаемое окно вниз'],
        intentKinds: ['device-control'],
      },
    },
  ],
};
