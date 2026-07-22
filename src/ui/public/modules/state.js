export const state = {
  data: null,
  pendingIntentText: '',
  currentIntentJob: null,
  busy: false,
  chat: {
    modelSelection: 'auto',
    deepThinking: 'none',
  },
  oscar: {
    busy: false,
    stopRequested: false,
    statusBusy: false,
    status: null,
    error: '',
    messages: [],
    conversationId: null,
    incognito: false,
    encrypted: false,
    safeUnlocked: false,
    safeChatBusy: false,
    conversations: [],
    historyBusy: false,
    historyPanelOpen: false,
    historyPageBusy: false,
    messagePage: { hasMore: false, nextBefore: null, loadedPages: 0 },
    editingMessageId: null,
    memoryItems: [],
    memoryBusy: false,
    memoryPanelOpen: false,
    context: null,
    skillMatches: [],
    activeSkills: [],
    skillRadarBusy: false,
    attachments: [],
    useMemory: true,
    web: null,
    reasoning: 'low',
    researchMode: 'auto',
    intelligenceEnabled: false,
    modelSelection: 'none',
    deepThinking: 'none',
    gemmaTier: 'none',
    ramWarning: null,
    generationStatus: null,
    streamTokens: 0,
  },
  security: {
    busy: false,
    statusBusy: false,
    incidentsBusy: false,
    status: null,
    incidents: null,
    activeTab: 'overview',
    selectedIncidentId: null,
    incidentFilter: 'active',
    recentScans: [],
    scanFeedback: null,
      networkResult: null,
      networkBusy: false,
      networkCenter: null,
      responseActions: null,
      responseServiceStatus: null,
      pendingResponse: null,
      responseFeedback: '',
      emergency: null,
      emergencyFeedback: '',
    quarantineBusy: false,
    quarantine: null,
    pinBusy: false,
    pinStatus: null,
    pinFeedback: '',
    recoveryCodes: [],
    replayMetrics: null,
    baselinePreview: null,
    baselineBusy: false,
    baselineFeedback: '',
    benchmarkJob: null,
    benchmarkBusy: false,
    lastResult: null,
    audit: null,
      error: '',
      modelPolicyFeedback: '',
    },
};

const listeners = new Set();

export function updateState(newData) {
  state.data = newData;
  notifyListeners();
}

export function subscribeState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyStateChange() {
  notifyListeners();
}

function notifyListeners() {
  for (const listener of listeners) {
    listener(state);
  }
}
