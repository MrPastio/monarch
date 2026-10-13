import { ensureComputerUseReady } from './computer-use-control.js';
import { fetchAstraAvailability } from './api.js';

const CONVERSATION_ID = 'astra_product_pilot';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);

/** Renderer adapter for the exact default-off desktop pilot. It retains only
 * opaque Turn/request pointers in the current URL; native identity, host token,
 * absolute paths and authority stay in main/runtime. */
export async function createAstraProductBridge(desktop = window.monarchDesktop, location = window.location, history = window.history,
  conversationId = CONVERSATION_ID) {
  if (!id(conversationId)) throw Error('Astra conversation identity invalid.');
  if (!desktop || typeof desktop.getAppInfo !== 'function' || !desktop.astraPilot) return null;
  const info = await desktop.getAppInfo();
  if (info?.astra?.pilot !== true) return null;
  const host = desktop.astraPilot;
  if (!['pickTarget', 'pickWindow', 'issueComputerAction', 'windowSelections', 'computerActionPlans']
    .every(key => typeof host[key] === 'function')) throw Error('Astra product pilot host incomplete.');

  const source = Object.freeze({ conversationId });
  const pointer = () => {
    const params = new URL(location.href).searchParams;
    const requestId = params.get('astraPendingRequestId'), turnId = params.get('astraTurnId');
    if (requestId && turnId) throw Error('Astra product pointer conflict.');
    if (requestId) { if (!id(requestId)) throw Error('Astra product pending pointer invalid.'); return { state: 'pending', requestId }; }
    if (turnId) { if (!/^oscar_turn_[a-f0-9]{32}$/u.test(turnId)) throw Error('Astra product Turn pointer invalid.'); return { state: 'linked', turnId }; }
    return { state: 'idle' };
  };
  const writePointer = (kind, value) => {
    if (!id(value) || kind === 'turn' && !/^oscar_turn_[a-f0-9]{32}$/u.test(value))
      throw Error('Astra product pointer rejected.');
    const next = new URL(location.href);
    next.searchParams.delete('astraPendingRequestId'); next.searchParams.delete('astraTurnId');
    next.searchParams.set(kind === 'turn' ? 'astraTurnId' : 'astraPendingRequestId', value);
    history.replaceState(history.state, '', next.href);
  };
  const clearPointer = requestId => {
    const current = pointer();
    if (current.state === 'idle') return;
    if (current.state !== 'pending' || current.requestId !== requestId) throw Error('Astra product pending pointer changed.');
    const next = new URL(location.href); next.searchParams.delete('astraPendingRequestId'); next.searchParams.delete('astraTurnId');
    history.replaceState(history.state, '', next.href);
  };
  const catalog = request => {
    if (!request || request.version !== 1 || !['list', 'revoke'].includes(request.kind)
      || request.source?.conversationId !== conversationId) throw Error('Astra product catalog request rejected.');
    return { version: 1, conversationId, kind: request.kind,
      ...(request.kind === 'revoke' ? { selectionId: request.selectionId } : {}) };
  };
  return Object.freeze({
    surface: ['workspace', 'native-chat'].includes(info.astra.surface) ? 'native-chat' : 'composer',
    forConversation: nextId => createAstraProductBridge(desktop, location, history, nextId),
    maxPreview: info.astra.maxPreview === true,
    bootstrap: async () => {
      const availability = ['workspace', 'native-chat'].includes(info.astra.surface) ? await fetchAstraAvailability() : null;
      return { deployment: 'isolated-validation', conversationId, surface: pointer(),
        localAnalysis: availability?.localModelConfigured === true, referenceInputs: true,
        maxAnalysis: availability?.maxModelConfigured === true,
        ...(availability && !availability.localModelConfigured ? { modelUnavailable: true } : {}),
        computerObservation: true, computerActions: true, computerSource: source };
    },
    pickTarget: request => host.pickTarget({ version: request?.version, requestId: request?.requestId,
      access: request?.access, conversationId }),
    pickWindow: request => host.pickWindow({ version: request?.version, requestId: request?.requestId, conversationId }),
    prepareComputerUse: () => ensureComputerUseReady('ui:astra-product-window-picker'),
    issueComputerAction: async request => {
      const result = await host.issueComputerAction({ version: request?.version, requestId: request?.requestId,
        taskId: request?.taskId, action: request?.action, conversationId });
      if (result?.status !== 'proposed' || !result.plan) throw Error('Astra product plan was not proposed.');
      return result.plan;
    },
    windowSelections: request => host.windowSelections(catalog(request)),
    computerActionPlans: request => host.computerActionPlans(catalog(request)),
    savePending: async requestId => writePointer('pending', requestId),
    saveLinked: async turnId => writePointer('turn', turnId),
    clearPending: async requestId => clearPointer(requestId),
  });
}
