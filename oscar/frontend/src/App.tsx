import {
  Activity,
  Bot,
  Brain,
  CircleStop,
  Copy,
  Cpu,
  Database,
  FileText,
  Gauge,
  Globe2,
  HardDrive,
  History,
  ImagePlus,
  Layers3,
  Loader2,
  MessageSquareText,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  SendHorizontal,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Terminal,
  Trash2,
  Wifi,
  X,
  Zap,
  User,
} from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ThinkingOrb } from './components/ThinkingOrb';
import { BackendHttpError, cancelGeneration, getHardware, getHealth, getMemoryStats, getModelStatus, listWorkspace, previewChatRoute, readWorkspaceFile, runSearch, runWorkspaceAction, searchWorkspace, streamChat } from './lib/api';
import type { ChatImageAttachment, ChatRequest, ChatSource, HardwareInfo, MemoryStats, ModelStatus, SearchResult, StreamEvent, UiMessage, WorkspaceEntry, WorkspaceToolResult } from './types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// @ts-expect-error Shared browser-only easter egg used by the live shell and preview.
import { installOscarSnakeEasterEgg } from '../../../src/ui/public/modules/oscar-snake-game.js';
// @ts-expect-error Shared browser-only brand sequence used by the live shell and preview.
import { advanceMonarchBrandClick, MONARCH_BRAND_STAGES } from '../../../src/ui/public/modules/brand-easter-egg.js';

type InspectorTab = 'model' | 'code' | 'search' | 'resources';
type WorkspaceEditorAction = 'write' | 'append' | 'replace' | 'copy' | 'move' | 'trash' | 'restore';
type ModelSelection = 'auto' | 'gemma4-fast' | 'gemma4-balanced';
type DeepThinkingMode = 'off' | 'standard' | 'extended';
type MascotState = 'idle' | 'thinking' | 'coding' | 'security' | 'success' | 'error';

interface WorkspaceDraft {
  action: WorkspaceEditorAction;
  path: string;
  targetPath: string;
  content: string;
  oldText: string;
  newText: string;
  overwrite: boolean;
}

const initialWorkspaceDraft: WorkspaceDraft = {
  action: 'write',
  path: 'artifacts/generated/workspace-note.md',
  targetPath: 'artifacts/generated/workspace-note-renamed.md',
  content: 'Oscar workspace note',
  oldText: '',
  newText: '',
  overwrite: false,
};

const seedMessages: UiMessage[] = [];

const suggestedPrompts = [
  {
    label: 'Свежий контекст',
    description: 'поиск + память',
    prompt: 'Собери свежий контекст по задаче',
  },
  {
    label: 'Память',
    description: 'что уже есть',
    prompt: 'Что уже хранится в памяти?',
  },
  {
    label: 'Следующий шаг',
    description: 'короткий план',
    prompt: 'Разложи следующий шаг по плану',
  },
  {
    label: 'Рабочий файл',
    description: 'создать артефакт',
    prompt: 'Создай файл artifacts/generated/oscar-work-note.md с текстом Oscar workspace artifact: агентный файл создан из быстрого действия.',
  },
];

const mascotAssets: Record<MascotState, { asset: string; alt: string }> = {
  idle: { asset: 'oscar-idle.png', alt: 'Oscar idle' },
  thinking: { asset: 'oscar-thinking.png', alt: 'Oscar thinking' },
  coding: { asset: 'oscar-coding.png', alt: 'Oscar coding' },
  security: { asset: 'oscar-security.png', alt: 'Oscar security watch' },
  success: { asset: 'oscar-success.png', alt: 'Oscar completed' },
  error: { asset: 'oscar-error.png', alt: 'Oscar needs attention' },
};

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>(seedMessages);
  const [draft, setDraft] = useState('');
  const [modelSelection, setModelSelection] = useState<ModelSelection>('auto');
  const [deepThinking, setDeepThinking] = useState<DeepThinkingMode>('off');
  const [incognito, setIncognito] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<ChatImageAttachment[]>([]);
  const [imageError, setImageError] = useState('');
  const [maxTokens, setMaxTokens] = useState(4096);
  const [temperature, setTemperature] = useState(0.3);
  const [activity, setActivity] = useState('checking');
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<MemoryStats | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState('');
  const [searchTouched, setSearchTouched] = useState(false);
  const [artifacts, setArtifacts] = useState<WorkspaceEntry[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<WorkspaceToolResult | null>(null);
  const [artifactSearchQuery, setArtifactSearchQuery] = useState('');
  const [artifactSearchResult, setArtifactSearchResult] = useState<WorkspaceToolResult | null>(null);
  const [artifactError, setArtifactError] = useState('');
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft>(initialWorkspaceDraft);
  const [workspaceActionResult, setWorkspaceActionResult] = useState<WorkspaceToolResult | null>(null);
  const [workspaceActionBusy, setWorkspaceActionBusy] = useState(false);
  const [workspaceActionHistory, setWorkspaceActionHistory] = useState<WorkspaceToolResult[]>([]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('model');
  const abortRef = useRef<AbortController | null>(null);
  const cancelRequestRef = useRef<Promise<boolean> | null>(null);
  const conversationAreaRef = useRef<HTMLElement | null>(null);
  const autoFollowRef = useRef(true);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [draft]);

  const lastSources = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].sources?.length) return messages[index].sources ?? [];
    }
    return [];
  }, [messages]);

  const codeCanvases = useMemo(() => {
    return messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => parseCodeCanvases(message.content));
  }, [messages]);

  const toolResults = useMemo(() => {
    return messages.flatMap((message) => message.toolResults ?? []);
  }, [messages]);

  const visibleToolResults = useMemo(() => [...toolResults, ...workspaceActionHistory], [toolResults, workspaceActionHistory]);

  const selectedRequestedModel = resolveRequestedModel(modelSelection, deepThinking, imageAttachments.length > 0);
  const ramNotice = buildRamNotice(hardware, selectedRequestedModel);
  const mascotState = resolveMascotState({ busy, inspectorTab, activity, model });
  const mascot = mascotAssets[mascotState];
  const deepThinkingEnabled = deepThinking !== 'off';
  const modelTone = model?.mock || model?.fallback_active
      ? 'warn'
      : model?.loaded
        ? 'ok'
        : 'neutral';
  const modelLabel = model?.fallback_active
    ? 'fallback mock'
    : model?.mock
      ? 'mock режим'
      : model?.loaded && model.active_tier
        ? formatModelTierLabel(model.active_tier)
        : formatConfiguredModelLabel(modelSelection, deepThinking);
  const connectionTone = activity === 'offline' ? 'warn' : activity === 'checking' ? 'neutral' : 'ok';
  const visibleActivity = formatActivity(activity);
  const hasOnlySeed = messages.length === 0;
  const hasStreamingMessage = useMemo(() => messages.some((message) => message.role === 'assistant' && message.pending), [messages]);
  const [streamNow, setStreamNow] = useState(() => Date.now());
  const [brandCycle, setBrandCycle] = useState({ stageIndex: 0, clickCount: 0, changeCount: 0 });

  useEffect(() => {
    void refreshStatus();
    void refreshArtifacts();
  }, []);

  useEffect(() => {
    installOscarSnakeEasterEgg();
  }, []);

  useEffect(() => {
    if (hasOnlySeed || !autoFollowRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth', block: 'end' });
  }, [messages, busy, hasOnlySeed]);

  useEffect(() => {
    if (!hasStreamingMessage) return;
    setStreamNow(Date.now());
    const intervalId = window.setInterval(() => setStreamNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [hasStreamingMessage]);

  useEffect(() => {
    if (activity !== 'offline') return;
    const intervalId = window.setInterval(() => void refreshStatus(), 3000);
    return () => window.clearInterval(intervalId);
  }, [activity]);

  async function refreshStatus() {
    try {
      const [health, hw, modelStatus] = await Promise.all([getHealth(), getHardware(), getModelStatus()]);
      setMemory(health.memory);
      setHardware(hw);
      setModel(modelStatus);
      setActivity(health.ok ? 'ready' : 'offline');
    } catch {
      setActivity('offline');
    }
  }

  async function refreshMemory() {
    try {
      setMemory(await getMemoryStats());
    } catch {
      setActivity('offline');
    }
  }

  async function refreshArtifacts() {
    setArtifactBusy(true);
    setArtifactError('');
    try {
      const result = await listWorkspace('artifacts/generated', true, 120);
      if (result.ok) {
        setArtifacts(result.entries ?? []);
      } else {
        setArtifactError(result.summary || 'Не удалось получить список артефактов.');
      }
    } catch (error) {
      setArtifactError(toUserError(error));
      setActivity('offline');
    } finally {
      setArtifactBusy(false);
    }
  }

  async function openArtifact(entry: WorkspaceEntry) {
    if (entry.type === 'directory') return;
    await openArtifactPath(entry.path);
  }

  async function openArtifactPath(path: string) {
    setArtifactBusy(true);
    setArtifactError('');
    try {
      setArtifactPreview(await readWorkspaceFile(path));
      setInspectorTab('code');
    } catch (error) {
      setArtifactPreview(null);
      setArtifactError(toUserError(error));
      setActivity('offline');
    } finally {
      setArtifactBusy(false);
    }
  }

  async function runArtifactSearch(query = artifactSearchQuery) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setArtifactSearchQuery(trimmed);
    setArtifactBusy(true);
    setArtifactError('');
    try {
      setArtifactSearchResult(await searchWorkspace(trimmed, 'artifacts/generated', 60));
      setInspectorTab('code');
    } catch (error) {
      setArtifactSearchResult(null);
      setArtifactError(toUserError(error));
      setActivity('offline');
    } finally {
      setArtifactBusy(false);
    }
  }

  function updateWorkspaceDraft(patch: Partial<WorkspaceDraft>) {
    setWorkspaceDraft((current) => ({ ...current, ...patch }));
  }

  async function executeWorkspaceDraft() {
    const path = workspaceDraft.path.trim();
    const targetPath = workspaceDraft.targetPath.trim();
    if (!path) {
      setWorkspaceActionResult({
        ok: false,
        kind: 'workspace',
        action: workspaceDraft.action,
        summary: 'Укажи путь внутри workspace.',
        error: 'empty-path',
      });
      return;
    }
    if ((workspaceDraft.action === 'copy' || workspaceDraft.action === 'move') && !targetPath) {
      setWorkspaceActionResult({
        ok: false,
        kind: 'workspace',
        action: workspaceDraft.action,
        summary: 'Укажи новый путь внутри workspace.',
        error: 'empty-target-path',
      });
      return;
    }

    setWorkspaceActionBusy(true);
    setWorkspaceActionResult(null);
    setActivity('workspace');
    try {
      const result = await runWorkspaceAction({
        action: workspaceDraft.action,
        path,
        target_path: targetPath,
        content: workspaceDraft.content,
        old_text: workspaceDraft.oldText,
        new_text: workspaceDraft.newText,
        overwrite: workspaceDraft.overwrite,
      });
      setWorkspaceActionResult(result);
      setWorkspaceActionHistory((current) => [...current, result].slice(-12));
      setActivity(formatToolActivity(result));
      if (result.ok) {
        await refreshArtifacts();
        if (result.path && ['write', 'append', 'replace', 'copy', 'move', 'restore'].includes(result.action)) {
          await openArtifactPath(result.path);
        }
      }
    } catch (error) {
      const failedResult: WorkspaceToolResult = {
        ok: false,
        kind: 'workspace',
        action: workspaceDraft.action,
        summary: toUserError(error),
        error: 'workspace-action-failed',
      };
      setWorkspaceActionResult(failedResult);
      setWorkspaceActionHistory((current) => [...current, failedResult].slice(-12));
      setActivity('offline');
    } finally {
      setWorkspaceActionBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await sendMessage();
  }

  async function handleImageFile(file: File) {
    setImageError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setImageError('Поддерживаются PNG, JPEG и WebP.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setImageError('Изображение больше 8 MB.');
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const base64 = dataUrl.split(',')[1] || '';
      setImageAttachments([{
        mime_type: file.type as ChatImageAttachment['mime_type'],
        data_base64: base64,
        name: file.name || 'image',
        size_bytes: file.size,
      }]);
      setModelSelection('gemma4-balanced');
      setDeepThinking('off');
    } catch (error) {
      setImageError(toUserError(error));
    }
  }

  async function sendMessage() {
    const outgoingImages = imageAttachments;
    const hasImages = outgoingImages.length > 0;
    const content = draft.trim() || (hasImages ? 'Опиши изображение.' : '');
    if (!content || busy || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    cancelRequestRef.current = null;
    const activeRequestedModel = resolveRequestedModel(modelSelection, deepThinking, hasImages);
    const activeReasoning = deepThinkingEnabled ? 'high' : 'low';
    const streamLabel = formatOutgoingStreamLabel(activeRequestedModel, hasImages);

    const userMessage: UiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      imageAttachments: hasImages ? outgoingImages : undefined,
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: UiMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      pending: true,
      streamStatus: streamLabel,
      streamEvents: [
        {
          kind: 'status',
          label: streamLabel,
          at: Date.now(),
        },
      ],
      streamTokens: 0,
      streamStartedAt: Date.now(),
      streamUpdatedAt: Date.now(),
    };
    const nextMessages = [...messages, userMessage];

    autoFollowRef.current = true;
    setMessages([...nextMessages, assistantMessage]);
    setDraft('');
    setImageAttachments([]);
    setImageError('');
    setBusy(true);
    setActivity('маршрутизация');

    const payload: ChatRequest = {
      messages: nextMessages
        .filter((message) => message.id !== 'seed' && message.content.trim())
        .map(({ role, content }) => ({ role, content })),
      use_memory: true,
      incognito,
      allow_tools: true,
      reasoning_effort: activeReasoning,
      research_mode: 'auto',
      requested_model: activeRequestedModel,
      image_attachments: hasImages ? outgoingImages : undefined,
      max_new_tokens: maxTokens,
      temperature,
      top_p: 0.9,
    };

    try {
      const route = await previewChatRoute(payload, controller.signal);
      if (route.requires_confirmation) {
        payload.deep_thinking_consent = await requestDeepThinkingConsent();
      }
      setActivity(route.web_search ? 'поиск и контекст' : 'генерация');
    } catch {
      if (!controller.signal.aborted) setActivity('генерация');
    }

    let streamTerminalEventSeen = false;
    let streamTerminalOk = true;

    try {
      await streamChat(
        payload,
        (eventName, data) => {
          if (eventName === 'status' && isStatusEvent(data)) {
            setActivity(data.message);
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? appendStreamEvent(
                      { ...message, streamStatus: data.message, streamUpdatedAt: Date.now() },
                      { kind: 'status', label: data.message },
                    )
                  : message,
              ),
            );
          }
          if (eventName === 'research' && isResearchEvent(data)) {
            setActivity(data.label);
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? appendStreamEvent(
                      { ...message, streamStatus: data.label, streamUpdatedAt: Date.now() },
                      { kind: 'research', label: data.label, detail: data.detail },
                    )
                  : message,
              ),
            );
          }
          if (eventName === 'sources' && isSourcesEvent(data)) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? appendStreamEvent(
                      { ...message, sources: data.sources, streamUpdatedAt: Date.now() },
                      { kind: 'source', label: 'контекст готов', detail: formatSourceCount(data.sources.length) },
                    )
                  : message,
              ),
            );
          }
          if (eventName === 'tool' && isToolEvent(data)) {
            setActivity(formatToolActivity(data.result));
            if (['write', 'append', 'replace', 'mkdir', 'copy', 'move', 'trash', 'restore'].includes(data.result.action)) {
              void refreshArtifacts();
            }
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? appendStreamEvent(
                      {
                        ...message,
                        streamStatus: formatToolActivity(data.result),
                        streamUpdatedAt: Date.now(),
                        toolResults: [...(message.toolResults ?? []), data.result],
                      },
                      {
                        kind: 'tool',
                        label: formatToolAction(data.result),
                        detail: formatToolDetail(data.result),
                      },
                    )
                  : message,
              ),
            );
          }
          if (eventName === 'token' && isTokenEvent(data)) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? appendStreamToken(message, data.token) : message,
              ),
            );
          }
          if (eventName === 'replace' && isReplaceEvent(data)) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? appendStreamEvent(
                      {
                        ...message,
                        content: data.content,
                        streamStatus: 'обновляю ответ',
                        streamUpdatedAt: Date.now(),
                        streamCorrected: true,
                      },
                      { kind: 'replace', label: 'ответ обновлен', detail: 'содержимое заменено' },
                    )
                  : message,
              ),
            );
          }
          if (eventName === 'error' && isErrorEvent(data)) {
            streamTerminalEventSeen = true;
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? appendStreamEvent(
                      {
                        ...message,
                        content: message.content + `\n\nОшибка: ${data.message}`,
                        pending: false,
                        streamStatus: 'ошибка',
                        streamUpdatedAt: Date.now(),
                      },
                      { kind: 'error', label: 'поток остановлен', detail: data.message },
                    )
                  : message,
              ),
            );
          }
          if (eventName === 'done') {
            streamTerminalEventSeen = true;
            streamTerminalOk = isDoneEvent(data) ? data.ok : true;
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? finalizeStreamMessage(message, streamTerminalOk, isDoneEvent(data) ? data.usage : undefined) : message,
              ),
            );
          }
        },
        controller.signal,
      );
      if (!streamTerminalEventSeen) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId ? recoverUnfinishedStreamMessage(message) : message,
          ),
        );
      }
      await refreshMemory();
      await refreshStatus();
      setActivity(streamTerminalOk ? 'ready' : 'fallback');
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId
              ? appendStreamEvent(
                  {
                    ...item,
                    content: item.content || 'Остановлено.',
                    pending: false,
                    streamStatus: 'остановлено',
                    streamUpdatedAt: Date.now(),
                  },
                  { kind: 'error', label: 'остановлено пользователем' },
                )
              : item,
          ),
        );
        setActivity('останавливаю');
        return;
      }
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? appendStreamEvent(
                {
                  ...item,
                  content: item.content + `\n\nОшибка: ${message}`,
                  pending: false,
                  streamStatus: 'ошибка',
                  streamUpdatedAt: Date.now(),
                },
                { kind: 'error', label: 'ошибка подключения', detail: message },
              )
            : item,
        ),
      );
      setActivity('offline');
    } finally {
      if (abortRef.current === controller) {
        const cancellationConfirmed = cancelRequestRef.current ? await cancelRequestRef.current : true;
        if (abortRef.current === controller) {
          if (controller.signal.aborted) setActivity(cancellationConfirmed ? 'ready' : 'offline');
          setBusy(false);
          abortRef.current = null;
          cancelRequestRef.current = null;
        }
      }
    }
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    setInspectorTab('search');
    setActivity('поиск');
    setSearchResults([]);
    setSearchError('');
    setSearchTouched(true);
    try {
      const results = await runSearch(query, 5);
      setSearchResults(results);
      await refreshMemory();
      setActivity('ready');
    } catch (error) {
      setSearchError(toUserError(error));
      setActivity('offline');
    }
  }

  function stopGeneration() {
    const controller = abortRef.current;
    if (!controller || controller.signal.aborted) return;
    setActivity('останавливаю');
    cancelRequestRef.current = cancelGeneration()
      .then(() => true)
      .catch(() => false);
    controller.abort();
  }

  function cycleDeepThinking() {
    setDeepThinking((current) => {
      if (current === 'off') return 'standard';
      if (current === 'standard') return 'extended';
      return 'off';
    });
  }

  function resetChat() {
    setMessages(seedMessages);
    setDraft('');
    setIncognito(false);
  }

  function toggleIncognitoChat() {
    if (busy) return;
    setMessages(seedMessages);
    setDraft('');
    setImageAttachments([]);
    setIncognito((active) => !active);
  }

  return (
    <div className="desktop">
      <div className="workspace">
        {/* LEFT SIDEBAR */}
        <aside className="sidebar" aria-label="Память и источники">
          <button
            className="sidebar-brand brand-cycle"
            type="button"
            aria-label={MONARCH_BRAND_STAGES[brandCycle.stageIndex]}
            onClick={() => setBrandCycle((current) => {
              const next = advanceMonarchBrandClick(current);
              return {
                ...next,
                changeCount: current.changeCount + (next.changed ? 1 : 0),
              };
            })}
          >
            <strong
              key={`${brandCycle.stageIndex}-${brandCycle.changeCount}`}
              className={`monarch-brand-word ${brandCycle.changeCount ? 'is-changing' : ''}`}
            >
              {MONARCH_BRAND_STAGES[brandCycle.stageIndex]}
            </strong>
          </button>

          <div className="nav-list" aria-label="Сводка сессии">
            <NavItem icon={<MessageSquareText size={15} />} label="Диалог" active meta={messages.length} />
            <NavItem icon={<Database size={15} />} label="Память" meta={memory?.chunks ?? 0} />
            <NavItem icon={<Layers3 size={15} />} label="Источники" meta={lastSources.length} />
          </div>

          <section className="sidebar-block">
            <SectionTitle icon={<ShieldCheck size={15} />} label="Состояние" />
            <div className="status-stack">
              <StatusRow label="Backend" value={formatBackendActivity(activity)} tone={connectionTone} />
              <StatusRow label="Model" value={modelLabel} tone={modelTone} />
              <StatusRow label="Device" value={hardware?.cuda_available ? 'CUDA' : 'CPU'} tone={hardware?.cuda_available ? 'ok' : 'neutral'} />
            </div>
          </section>

          <section className="sidebar-block">
            <SectionTitle icon={<Database size={15} />} label="Память" />
            <div className="mini-grid">
              <Metric label="Документы" value={memory?.documents ?? 0} />
              <Metric label="Фрагменты" value={memory?.chunks ?? 0} />
            </div>
            <p className="meta-line">
              {memory?.updated_at ? `обновлено ${formatDate(memory.updated_at)}` : 'память пока чистая'}
            </p>
          </section>

          <section className="sidebar-block" style={{ flex: 1 }}>
            <SectionTitle icon={<History size={15} />} label="Последние источники" />
            <SourceList sources={lastSources} compact />
          </section>

          <div className="sidebar-footer">
            <button className="sidebar-command" onClick={resetChat} type="button">
              <Trash2 size={15} />
              Очистить
            </button>
            <button className="sidebar-command" onClick={refreshStatus} type="button">
              <RefreshCcw size={15} />
              Статус
            </button>
          </div>
        </aside>

        {/* MAIN CONTENT PANE */}
        <main className="content-pane" aria-label="Диалог">
          <header className="content-toolbar">
            <div className="breadcrumb">
              <Sparkles size={16} />
              <span>Oscar / {incognito ? 'Инкогнито' : hasOnlySeed ? 'Новый диалог' : 'Сессия'}</span>
            </div>
            <div className="toolbar-actions" aria-label="Действия диалога">
              <StatusPill icon={<Activity size={13} />} label={visibleActivity} tone={connectionTone} />
              <StatusPill icon={<Bot size={13} />} label={modelLabel} tone={modelTone} />
              <button className={`icon-button incognito-toggle ${incognito ? 'is-active' : ''}`} onClick={toggleIncognitoChat} type="button" aria-pressed={incognito} aria-label={incognito ? 'Выйти из инкогнито-чата' : 'Начать инкогнито-чат'} title={incognito ? 'Выйти из инкогнито-чата' : 'Начать инкогнито-чат'}>
                <ShieldCheck size={18} />
              </button>
              <button className="icon-button" onClick={resetChat} type="button" aria-label="Новый диалог" title="Новый диалог">
                <SquarePen size={18} />
              </button>
            </div>
          </header>

          <section
            ref={conversationAreaRef}
            className="conversation-area"
            aria-label="Сообщения"
            onScroll={(event) => {
              const node = event.currentTarget;
              autoFollowRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 96;
            }}
          >
            <div className={`messages ${hasOnlySeed ? 'is-empty' : ''}`} aria-live="polite">
              {hasOnlySeed ? (
                <div className="focus-panel">
                  <div
                    className="preview-mascot-view"
                    id="preview-mascot-view"
                    data-mascot-state={mascotState}
                    aria-label="Oscar mascot"
                  >
                    <img src={`/assets/mascot/${mascot.asset}`} alt={mascot.alt} />
                    <div className="mascot-caption">
                      <strong>{formatMascotTitle(mascotState)}</strong>
                      <span>{formatMascotDetail(mascotState, activity)}</span>
                    </div>
                  </div>
                  <div className="focus-copy">
                    <span>Oscar Workspace</span>
                    <h2>Чем могу помочь?</h2>
                    <p>Используйте подсказки или введите свой запрос</p>
                  </div>
                  <div className="quick-grid" aria-label="Быстрые запросы">
                    {suggestedPrompts.map((item) => (
                      <QuickAction
                        key={item.prompt}
                        icon={quickActionIcon(item.label)}
                        label={item.label}
                        description={item.description}
                        onClick={() => setDraft(item.prompt)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} now={streamNow} />
              ))}
              <div ref={messagesEndRef} aria-hidden="true" />
            </div>
          </section>

          {/* COMPOSER AT BOTTOM (FLOATING) */}
          <form
            className="composer"
            onSubmit={handleSubmit}
            onDragOver={(event) => {
              if (!firstImageFile(event.dataTransfer)) return;
              event.preventDefault();
              event.currentTarget.classList.add('is-dragging-image');
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                event.currentTarget.classList.remove('is-dragging-image');
              }
            }}
            onDrop={(event) => {
              event.currentTarget.classList.remove('is-dragging-image');
              const file = firstImageFile(event.dataTransfer);
              if (!file) return;
              event.preventDefault();
              void handleImageFile(file);
            }}
          >
            <div className="composer-panel">
              {ramNotice ? (
                <div className={`ram-pressure-warning ${ramNotice.level}`} role="status" aria-live="polite">
                  <strong>Нужен запас RAM</strong>
                  <span>{ramNotice.message}</span>
                </div>
              ) : null}
              {imageAttachments.length || imageError ? (
                <div className="composer-attachments">
                  {imageAttachments.map((image) => (
                    <div className="composer-attachment" key={`${image.name}-${image.size_bytes}`}>
                      <img src={`data:${image.mime_type};base64,${image.data_base64}`} alt={image.name} />
                      <span>{image.name}</span>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => {
                          setImageAttachments([]);
                          setImageError('');
                        }}
                        aria-label="Убрать изображение"
                        title="Убрать изображение"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {imageError ? <p className="composer-attachment-error">{imageError}</p> : null}
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  const file = firstImageFile(event.clipboardData);
                  if (!file) return;
                  event.preventDefault();
                  void handleImageFile(file);
                }}
                placeholder="Как я могу помочь?"
                rows={1}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <div className="composer-actions">
                <div className="inline-toggles">
                  <button
                    className={`toggle ${imageAttachments.length ? 'active' : ''}`}
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    aria-label="Добавить изображение"
                    title="Добавить изображение"
                  >
                    <ImagePlus size={14} />
                    <span>Зрение</span>
                  </button>
                  <button
                    className={`toggle deep-thinking-toggle ${deepThinkingEnabled ? 'active' : ''}`}
                    type="button"
                    onClick={cycleDeepThinking}
                    aria-pressed={deepThinkingEnabled}
                    title={formatDeepThinkingTitle(deepThinking)}
                  >
                    <Brain size={14} />
                    <span>{formatDeepThinkingChip(deepThinking)}</span>
                  </button>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void handleImageFile(file);
                    }}
                  />
                </div>
                {busy ? (
                  <button className="icon-button danger" type="button" onClick={stopGeneration} aria-label="Остановить" title="Остановить">
                    <CircleStop size={18} />
                  </button>
                ) : (
                  <button className="send-button" type="submit" disabled={!draft.trim() && !imageAttachments.length} aria-label="Отправить" title="Отправить">
                    <SendHorizontal size={17} />
                  </button>
                )}
              </div>
            </div>
          </form>
        </main>

        {/* RIGHT INSPECTOR */}
        <aside className="sidebar inspector" aria-label="Модель, поиск и ресурсы">
          <div className="inspector-head">
            <span>Inspector</span>
            <strong>Настройки</strong>
          </div>

          <div className="mascot-panel" data-mascot-state={mascotState}>
            <img
              src={`/assets/mascot/${mascot.asset}`}
              alt={mascot.alt}
            />
            <div className="mascot-caption">
              <strong>{formatMascotTitle(mascotState)}</strong>
              <span>{formatMascotDetail(mascotState, activity)}</span>
            </div>
          </div>

          <div className="inspector-tabs" role="tablist" aria-label="Панели инспектора">
            <TabButton active={inspectorTab === 'model'} icon={<SlidersHorizontal size={14} />} label="Модель" onClick={() => setInspectorTab('model')} />
            <TabButton active={inspectorTab === 'code'} icon={<FileText size={14} />} label="Файлы" onClick={() => setInspectorTab('code')} />
            <TabButton active={inspectorTab === 'search'} icon={<Search size={14} />} label="Поиск" onClick={() => setInspectorTab('search')} />
            <TabButton active={inspectorTab === 'resources'} icon={<Gauge size={14} />} label="Ресурсы" onClick={() => setInspectorTab('resources')} />
          </div>

          {inspectorTab === 'model' ? (
            <section className="sidebar-block inspector-panel">
              <SectionTitle icon={<Cpu size={15} />} label="Модель" />
              <ChoiceGroup
                value={modelSelection}
                options={[
                  { value: 'auto', label: 'Auto', detail: 'auto', icon: <SlidersHorizontal size={14} /> },
                  { value: 'gemma4-fast', label: 'Fast', detail: 'E2B', icon: <Zap size={14} /> },
                  { value: 'gemma4-balanced', label: 'Medium', detail: '12B', icon: <Gauge size={14} /> },
                ]}
                onChange={(value) => setModelSelection(value as ModelSelection)}
              />
              <SectionTitle icon={<Brain size={15} />} label="DeepThinking" />
              <ChoiceGroup
                value={deepThinking}
                options={[
                  { value: 'off', label: 'Выкл', detail: 'medium', icon: <CircleStop size={14} /> },
                  { value: 'standard', label: 'Pro', detail: '26B', icon: <Brain size={14} /> },
                  { value: 'extended', label: 'Extra', detail: '31B', icon: <Sparkles size={14} /> },
                ]}
                onChange={(value) => setDeepThinking(value as DeepThinkingMode)}
              />
              <Slider label="Базовый лимит" value={maxTokens} min={512} max={8192} step={512} onChange={setMaxTokens} />
              <Slider label="Температура" value={temperature} min={0} max={1.2} step={0.1} onChange={setTemperature} />
              <div className="model-readout" style={{ marginTop: '8px' }}>
                <Metric label="Режим" value={modelLabel} />
                <Metric label="Offload" value={model?.cpu_memory_gb ? `${model.cpu_memory_gb} GiB` : 'n/a'} />
                <Metric label="Выбор" value={formatModelTierLabel(selectedRequestedModel || 'auto')} />
                <Metric label="Vision" value={formatGemmaVisionStatus(model)} />
                <Metric label="Draft" value={formatGemmaDraftStatus(model)} />
                <Metric label="Spec" value={formatSpeculativeStatus(model)} />
              </div>
              {model?.gemma_vision_note ? <p className="meta-line">{model.gemma_vision_note}</p> : null}
            </section>
          ) : null}

          {inspectorTab === 'code' ? (
            <CodeCanvasPanel
              toolResults={visibleToolResults}
              artifacts={artifacts}
              artifactPreview={artifactPreview}
              artifactError={artifactError}
              artifactBusy={artifactBusy}
              onRefreshArtifacts={refreshArtifacts}
              onOpenArtifact={openArtifact}
              artifactSearchQuery={artifactSearchQuery}
              artifactSearchResult={artifactSearchResult}
              workspaceDraft={workspaceDraft}
              workspaceActionResult={workspaceActionResult}
              workspaceActionBusy={workspaceActionBusy}
              onArtifactSearchQueryChange={setArtifactSearchQuery}
              onArtifactSearch={runArtifactSearch}
              onOpenArtifactPath={openArtifactPath}
              onWorkspaceDraftChange={updateWorkspaceDraft}
              onRunWorkspaceAction={executeWorkspaceDraft}
            />
          ) : null}

          {inspectorTab === 'search' ? (
            <section className="sidebar-block inspector-panel">
              <SectionTitle icon={<Search size={15} />} label="Поиск" />
              <form className="search-form" onSubmit={handleSearch}>
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Запрос..." />
                <button className="icon-button" type="submit" aria-label="Искать" title="Искать" style={{ background: 'var(--bg-surface-hover)' }}>
                  {activity === 'поиск' || activity === 'searching' ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
                </button>
              </form>
              <div className="result-list">
                {searchError ? (
                  <InlineNotice title="Поиск не выполнен" body={searchError} tone="error" />
                ) : searchResults.length ? (
                  searchResults.map((result) => (
                    <a href={result.url} target="_blank" rel="noreferrer" className="result-row" key={result.url}>
                      <strong>{result.title}</strong>
                      <span>{result.snippet}</span>
                      <em>{formatSearchResultMeta(result)}</em>
                    </a>
                  ))
                ) : searchTouched ? (
                  <InlineNotice title="Ничего не найдено" body="Попробуй другой запрос или включи web-поиск в диалоге, чтобы найденное попало в память." />
                ) : (
                  <p className="meta-line">нет результатов в этой сессии</p>
                )}
              </div>
            </section>
          ) : null}

          {inspectorTab === 'resources' ? (
            <>
              <section className="sidebar-block inspector-panel">
                <SectionTitle icon={<Gauge size={15} />} label="Ресурсы" />
                <div className="resource-list">
                  <Metric label="GPU" value={hardware?.gpu_name ?? 'нет данных'} />
                  <Metric label="VRAM" value={formatVram(hardware)} />
                  <Metric label="RAM" value={formatRam(hardware)} />
                  <Metric label="Torch" value={hardware?.torch_version ?? 'не найден'} />
                </div>
              </section>

              <section className="sidebar-block runtime-block">
                <SectionTitle icon={<HardDrive size={15} />} label="Runtime" />
                <p className="path-line">{formatRuntimeModelPath(model, selectedRequestedModel)}</p>
                {model?.gemma_vision_path ? <p className="path-line">Vision: {model.gemma_vision_path}</p> : null}
                {model?.gemma_draft_model_path ? <p className="path-line">Draft: {model.gemma_draft_model_path}</p> : null}
                {model?.llama_cpp_version ? <p className="path-line">llama-cpp-python: {model.llama_cpp_version}</p> : null}
                {model ? (
                  <p className="path-line">
                    CUDA offload: {model.gpu_offload_available ? 'готов'
                      : 'недоступен'}{model.device_map?.gpu_layers ? ` · ${model.device_map.gpu_layers}/${model.device_map.gpu_layers_requested ?? model.device_map.gpu_layers} слоёв` : ''}
                  </p>
                ) : null}
                {model?.last_error ? <p className="error-text">{model.last_error}</p> : null}
              </section>
            </>
          ) : null}

          <section className="sidebar-block">
            <SectionTitle icon={<Terminal size={15} />} label="Контекст" />
            <div className="context-list">
              <ContextRow icon={<FileText size={14} />} label="Сообщения" value={messages.length} />
              <ContextRow icon={<FileText size={14} />} label="Код" value={codeCanvases.length} />
              <ContextRow icon={<Terminal size={14} />} label="Действия" value={visibleToolResults.length} />
              <ContextRow icon={<Layers3 size={14} />} label="Источники" value={lastSources.length} />
              <ContextRow icon={<Database size={14} />} label="Фрагменты" value={memory?.chunks ?? 0} />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

interface CodeCanvasBlock {
  language: string;
  code: string;
  complete: boolean;
}

function CodeCanvasPanel({
  toolResults,
  artifacts,
  artifactPreview,
  artifactError,
  artifactBusy,
  artifactSearchQuery,
  artifactSearchResult,
  workspaceDraft,
  workspaceActionResult,
  workspaceActionBusy,
  onRefreshArtifacts,
  onOpenArtifact,
  onArtifactSearchQueryChange,
  onArtifactSearch,
  onOpenArtifactPath,
  onWorkspaceDraftChange,
  onRunWorkspaceAction,
}: {
  toolResults: WorkspaceToolResult[];
  artifacts: WorkspaceEntry[];
  artifactPreview: WorkspaceToolResult | null;
  artifactError: string;
  artifactBusy: boolean;
  artifactSearchQuery: string;
  artifactSearchResult: WorkspaceToolResult | null;
  workspaceDraft: WorkspaceDraft;
  workspaceActionResult: WorkspaceToolResult | null;
  workspaceActionBusy: boolean;
  onRefreshArtifacts: () => void;
  onOpenArtifact: (entry: WorkspaceEntry) => void;
  onArtifactSearchQueryChange: (query: string) => void;
  onArtifactSearch: (query?: string) => void;
  onOpenArtifactPath: (path: string) => void;
  onWorkspaceDraftChange: (patch: Partial<WorkspaceDraft>) => void;
  onRunWorkspaceAction: () => void | Promise<void>;
}) {
  return (
    <section className="sidebar-block inspector-panel code-canvas-panel">
      <SectionTitle icon={<FileText size={15} />} label="Файлы и действия" />
      <p className="meta-line">Код теперь остаётся внутри ответа и не перескакивает при генерации.</p>
      <WorkspaceActionPanel
        draft={workspaceDraft}
        result={workspaceActionResult}
        busy={workspaceActionBusy}
        onDraftChange={onWorkspaceDraftChange}
        onRun={onRunWorkspaceAction}
      />
      <ArtifactPanel
        artifacts={artifacts}
        preview={artifactPreview}
        error={artifactError}
        busy={artifactBusy}
        searchQuery={artifactSearchQuery}
        searchResult={artifactSearchResult}
        onRefresh={onRefreshArtifacts}
        onOpen={onOpenArtifact}
        onSearchQueryChange={onArtifactSearchQueryChange}
        onSearch={onArtifactSearch}
        onOpenPath={onOpenArtifactPath}
      />
      <AgentToolsPanel results={toolResults} />
    </section>
  );
}

function WorkspaceActionPanel({
  draft,
  result,
  busy,
  onDraftChange,
  onRun,
}: {
  draft: WorkspaceDraft;
  result: WorkspaceToolResult | null;
  busy: boolean;
  onDraftChange: (patch: Partial<WorkspaceDraft>) => void;
  onRun: () => void | Promise<void>;
}) {
  const canSubmit = Boolean(draft.path.trim())
    && (draft.action !== 'replace' || Boolean(draft.oldText))
    && (!['copy', 'move'].includes(draft.action) || Boolean(draft.targetPath.trim()));
  const submitLabel = draft.action === 'write'
    ? 'Создать'
    : draft.action === 'append'
      ? 'Дописать'
      : draft.action === 'replace'
        ? 'Заменить'
        : draft.action === 'copy'
          ? 'Скопировать'
          : draft.action === 'move'
            ? 'Переместить'
            : draft.action === 'restore'
              ? 'Восстановить'
              : 'В корзину';
  const submitIcon = busy
    ? <Loader2 className="spin" size={15} />
    : draft.action === 'trash'
      ? <Trash2 size={15} />
      : draft.action === 'copy'
        ? <Copy size={15} />
        : draft.action === 'restore'
          ? <RotateCcw size={15} />
        : draft.action === 'move'
          ? <RefreshCcw size={15} />
          : <Plus size={15} />;

  return (
    <div className="workspace-action-panel">
      <div className="artifact-head">
        <SectionTitle icon={<Terminal size={15} />} label="Рабочее действие" />
      </div>
      <form className="workspace-action-form" onSubmit={(event) => { event.preventDefault(); void onRun(); }}>
        <Segmented
          value={draft.action}
          options={[
            ['write', 'Создать'],
            ['append', 'Дописать'],
            ['replace', 'Заменить'],
            ['copy', 'Копия'],
            ['move', 'Перенос'],
            ['trash', 'Корзина'],
            ['restore', 'Вернуть'],
          ]}
          onChange={(value) =>
            onDraftChange({
              action: value as WorkspaceEditorAction,
              targetPath: value === 'restore' ? '' : draft.targetPath,
            })
          }
        />
        <input
          value={draft.path}
          onChange={(event) => onDraftChange({ path: event.target.value })}
          placeholder="artifacts/generated/file.md"
        />
        {draft.action === 'copy' || draft.action === 'move' || draft.action === 'restore' ? (
          <input
            value={draft.targetPath}
            onChange={(event) => onDraftChange({ targetPath: event.target.value })}
            placeholder={draft.action === 'restore' ? 'artifacts/generated/restored.md (опц.)' : 'artifacts/generated/new-file.md'}
          />
        ) : null}
        {draft.action === 'replace' ? (
          <>
            <textarea
              value={draft.oldText}
              onChange={(event) => onDraftChange({ oldText: event.target.value })}
              placeholder="Точный фрагмент"
              rows={2}
            />
            <textarea
              value={draft.newText}
              onChange={(event) => onDraftChange({ newText: event.target.value })}
              placeholder="Новый текст"
              rows={2}
            />
          </>
        ) : draft.action === 'write' || draft.action === 'append' ? (
          <textarea
            value={draft.content}
            onChange={(event) => onDraftChange({ content: event.target.value })}
            placeholder="Текст файла"
            rows={4}
          />
        ) : null}
        <div className="workspace-action-row">
          {draft.action === 'write' ? (
            <label className="workspace-check">
              <input
                type="checkbox"
                checked={draft.overwrite}
                onChange={(event) => onDraftChange({ overwrite: event.target.checked })}
              />
              <span>Перезапись</span>
            </label>
          ) : (
            <span aria-hidden="true" />
          )}
          <button className="workspace-submit" type="submit" disabled={busy || !canSubmit}>
            {submitIcon}
            {submitLabel}
          </button>
        </div>
      </form>
      {result ? (
        <InlineNotice title={result.ok ? 'Готово' : 'Ошибка'} body={result.summary} tone={result.ok ? 'neutral' : 'error'} />
      ) : null}
    </div>
  );
}

function ArtifactPanel({
  artifacts,
  preview,
  error,
  busy,
  searchQuery,
  searchResult,
  onRefresh,
  onOpen,
  onSearchQueryChange,
  onSearch,
  onOpenPath,
}: {
  artifacts: WorkspaceEntry[];
  preview: WorkspaceToolResult | null;
  error: string;
  busy: boolean;
  searchQuery: string;
  searchResult: WorkspaceToolResult | null;
  onRefresh: () => void;
  onOpen: (entry: WorkspaceEntry) => void;
  onSearchQueryChange: (query: string) => void;
  onSearch: (query?: string) => void;
  onOpenPath: (path: string) => void;
}) {
  const visibleArtifacts = artifacts.slice(0, 24);
  const matches = searchResult?.matches ?? [];
  return (
    <div className="artifact-panel">
      <div className="artifact-head">
        <SectionTitle icon={<HardDrive size={15} />} label="Артефакты" />
        <button className="icon-button" type="button" aria-label="Обновить артефакты" title="Обновить артефакты" onClick={onRefresh}>
          {busy ? <Loader2 className="spin" size={15} /> : <RefreshCcw size={15} />}
        </button>
      </div>
      <form className="artifact-search" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <input
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Найти в артефактах..."
        />
        <button className="icon-button" type="submit" aria-label="Искать в артефактах" title="Искать в артефактах">
          {busy ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
        </button>
      </form>
      <div className="artifact-chips" aria-label="Быстрый поиск по артефактам">
        {['Oscar', 'workspace', 'ошибка'].map((query) => (
          <button key={query} type="button" onClick={() => onSearch(query)}>
            {query}
          </button>
        ))}
      </div>
      {error ? <InlineNotice title="Артефакты недоступны" body={error} tone="error" /> : null}
      {searchResult ? (
        <div className="artifact-search-results">
          <span>{searchResult.summary}</span>
          {matches.length ? (
            matches.slice(0, 8).map((match) => (
              <button key={`${match.path}-${match.line}`} type="button" onClick={() => onOpenPath(match.path)}>
                <strong>{basename(match.path)}:{match.line}</strong>
                <em>{match.preview}</em>
              </button>
            ))
          ) : (
            <p className="meta-line">совпадений нет</p>
          )}
        </div>
      ) : null}
      {visibleArtifacts.length === 0 ? (
        <p className="meta-line">созданные файлы появятся в artifacts/generated</p>
      ) : (
        <div className="artifact-list">
          {visibleArtifacts.map((entry) => (
            <button
              className={`artifact-row ${entry.type}`}
              key={entry.path}
              type="button"
              disabled={entry.type === 'directory'}
              onClick={() => onOpen(entry)}
            >
              <span>{entry.type === 'directory' ? 'Папка' : 'Файл'}</span>
              <strong>{entry.name}</strong>
              <em>{entry.size_bytes != null ? formatBytes(entry.size_bytes) : 'каталог'}</em>
            </button>
          ))}
        </div>
      )}
      {preview?.ok && preview.content != null ? (
        <article className="artifact-preview">
          <strong>{preview.path ? basename(preview.path) : 'preview'}</strong>
          <pre>{preview.content.slice(0, 2400)}</pre>
        </article>
      ) : null}
      {preview && !preview.ok ? <p className="error-text">{preview.summary}</p> : null}
    </div>
  );
}

function AgentToolsPanel({ results }: { results: WorkspaceToolResult[] }) {
  return (
    <div className="agent-tools-panel">
      <SectionTitle icon={<Terminal size={15} />} label="Действия агента" />
      {results.length === 0 ? (
        <p className="meta-line">Файлы, поиск по workspace и заметки памяти появятся здесь.</p>
      ) : (
        <ToolResultList results={results.slice(-8)} />
      )}
    </div>
  );
}

function parseCodeCanvases(content: string): CodeCanvasBlock[] {
  const blocks: CodeCanvasBlock[] = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const code = match[2] ?? '';
    if (!code.trim()) continue;
    blocks.push({
      language: (match[1] ?? 'code').trim() || 'code',
      code,
      complete: match[3] === '```',
    });
  }

  return blocks;
}

const messageRemarkPlugins = [remarkGfm];
const messageMarkdownComponents = {
  pre({ children }: any) {
    return <>{children}</>;
  },
  code(props: any) {
    const { children, className, ref, ...rest } = props;
    const match = /language-(\w+)/.exec(className || '');
    const rawCode = String(children).replace(/\n$/, '');
    const isBlock = Boolean(match) || rawCode.includes('\n');
    return isBlock ? (
      <div className="oscar-code-block">
        <div className="oscar-code-header">
          <span>{match?.[1] ?? 'code'}</span>
          <button type="button" className="oscar-copy-btn" onClick={() => navigator.clipboard.writeText(rawCode)}>
            Скопировать
          </button>
        </div>
        <pre>
          <code {...rest} ref={ref as any} className={className}>
            {rawCode}
          </code>
        </pre>
      </div>
    ) : (
      <code {...rest} ref={ref as any} className={className}>
        {children}
      </code>
    );
  },
};

function MessageBubble({ message, now }: { message: UiMessage; now: number }) {
  const isUser = message.role === 'user';
  const isStreaming = !isUser && Boolean(message.pending);
  const isDegraded = !isUser && message.streamOk === false;
  const content = message.content || (message.pending ? '' : '...');
  const detailedStream = !isUser && isResearchOrSearchStream(message);

  if (!isUser && isStreaming && !content && !detailedStream) {
    const status = formatStreamStatus(message);
    return (
      <article className="message-row assistant thinking-orb-only" aria-busy="true">
        <span className="stream-orb-only" role="status" aria-label={status}>
          <MonarchThinkingOrb phase={resolveStreamOrbPhase(message)} />
        </span>
      </article>
    );
  }

  return (
    <article className={`message-row ${message.role} ${isDegraded ? 'degraded' : ''}`} aria-busy={isStreaming}>
      {!isUser && (
        <div className="message-avatar" aria-hidden="true">
          <Sparkles size={18} />
        </div>
      )}
      <div className="message-card">
        {!isUser && (
          <div className="message-head">
            <span>Oscar</span>
            {isStreaming ? <StreamLiveStatus message={message} detailed={detailedStream} /> : null}
          </div>
        )}
        {!isUser && detailedStream && message.streamEvents?.length ? <StreamTrace events={message.streamEvents} now={now} active={isStreaming} /> : null}
        <div className={`message-body ${isStreaming ? 'is-streaming' : ''} ${!content ? 'is-waiting' : ''}`}>
          {isUser ? (
            content
          ) : !content ? (
            <span className="stream-placeholder">жду первый фрагмент</span>
          ) : (
            <ReactMarkdown
              remarkPlugins={messageRemarkPlugins}
              components={messageMarkdownComponents}
            >
              {normalizeMarkdownNumbering(content)}
            </ReactMarkdown>
          )}
        </div>
        {message.imageAttachments?.length ? <ImageAttachmentStrip images={message.imageAttachments} /> : null}
        {isStreaming && detailedStream ? <StreamProgress message={message} now={now} /> : null}
        {message.sources?.length ? <SourceList sources={message.sources} /> : null}
        {message.toolResults?.length ? <ToolResultList results={message.toolResults} compact /> : null}
        {!isUser && !isStreaming && message.usage ? <MessageUsage usage={message.usage} /> : null}
      </div>
    </article>
  );
}

function ImageAttachmentStrip({ images }: { images: ChatImageAttachment[] }) {
  return (
    <div className="image-attachment-strip" aria-label="Изображения">
      {images.map((image) => (
        <div className="image-attachment-chip" key={`${image.name}-${image.size_bytes}`}>
          <img src={`data:${image.mime_type};base64,${image.data_base64}`} alt={image.name} />
          <span>{image.name}</span>
        </div>
      ))}
    </div>
  );
}

function StreamLiveStatus({ message, detailed }: { message: UiMessage; detailed: boolean }) {
  const status = formatStreamStatus(message);
  const count = formatStreamCount(message);
  const phase = resolveStreamOrbPhase(message);

  if (!detailed) {
    return (
      <span className="stream-live orb-only" role="status" aria-label={status}>
        <MonarchThinkingOrb phase={phase} />
      </span>
    );
  }

  return (
    <span className="stream-live" aria-live="polite">
      <MonarchThinkingOrb phase={phase} />
      <span>{status}</span>
      {count ? <em>{count}</em> : null}
      {message.streamCorrected ? <strong>исправлено</strong> : null}
    </span>
  );
}

function MonarchThinkingOrb({ phase }: { phase: 'route' | 'search' | 'write' | 'error' }) {
  return (
    <span className="monarch-thinking-orb" data-orb-phase={phase} aria-hidden="true">
      <ThinkingOrb size={14} className="monarch-thinking-orb__core" />
    </span>
  );
}

function StreamTrace({ events, now, active }: { events: StreamEvent[]; now: number; active: boolean }) {
  const visibleEvents = events.slice(-6);

  return (
    <ol className={`stream-trace ${active ? 'active' : ''}`} aria-label="Ход генерации">
      {visibleEvents.map((event, index) => (
        <li className={`stream-trace-item ${event.kind}`} key={`${event.kind}-${event.at}-${index}`}>
          <span className="stream-trace-mark" aria-hidden="true" />
          <strong>{event.label}</strong>
          {event.detail ? <span>{event.detail}</span> : null}
          {event.count && event.count > 1 ? <em>{event.count}x</em> : <em>{formatStreamEventAge(event.at, now)}</em>}
        </li>
      ))}
    </ol>
  );
}

function StreamProgress({ message, now }: { message: UiMessage; now: number }) {
  const status = formatStreamStatus(message);
  const elapsed = formatStreamElapsed(message, now);
  const count = formatStreamCount(message);
  const chars = formatStreamChars(message.content.length);
  const freshness = formatStreamFreshness(message, now);

  return (
    <div className="stream-progress" aria-live="polite">
      <span className="stream-progress-line" aria-hidden="true" />
      <div className="stream-progress-copy">
        <strong>{status}</strong>
        <span>{elapsed}</span>
      </div>
      <div className="stream-progress-metrics" aria-label="Статус генерации">
        {count ? <span>{count}</span> : null}
        {chars ? <span>{chars}</span> : null}
        {freshness ? <span>{freshness}</span> : null}
      </div>
    </div>
  );
}

function ToolResultList({ results, compact = false }: { results: WorkspaceToolResult[]; compact?: boolean }) {
  return (
    <div className={compact ? 'tool-result-list compact' : 'tool-result-list'}>
      {results.map((result, index) => (
        <article className={`tool-result-row ${result.ok ? 'ok' : 'warn'}`} key={`${result.action}-${result.path ?? result.query ?? index}`}>
          <div className="tool-result-head">
            <span>{formatToolAction(result)}</span>
            <strong>{result.ok ? 'готово' : 'ошибка'}</strong>
          </div>
          <p>{result.summary}</p>
          {!compact ? <em>{formatToolDetail(result)}</em> : null}
        </article>
      ))}
    </div>
  );
}

function NavItem({ icon, label, meta, active = false }: { icon: ReactNode; label: string; meta: string | number; active?: boolean }) {
  return (
    <div className={`nav-item ${active ? 'active' : ''}`} title={label}>
      <span>
        {icon}
        {label}
      </span>
      <em>{meta}</em>
    </div>
  );
}

function SourceList({ sources, compact = false }: { sources: ChatSource[]; compact?: boolean }) {
  if (!sources.length) return <p className="meta-line">нет источников</p>;
  return (
    <div className={compact ? 'source-list compact' : 'source-list'}>
      {sources.map((source) => (
        <a href={source.url ?? '#'} target="_blank" rel="noreferrer" className="source-row" key={`${source.id}-${source.url}`}>
          <span>[{source.id}]</span>
          <div>
            <strong>{source.title}</strong>
            {!compact ? <em>{source.excerpt}</em> : null}
          </div>
        </a>
      ))}
    </div>
  );
}

function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="section-title">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'neutral' }) {
  return (
    <div className={`status-row ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ContextRow({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) {
  return (
    <div className="context-row">
      <span>
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

function QuickAction({ icon, label, description, onClick }: { icon: ReactNode; label: string; description: string; onClick: () => void }) {
  return (
    <button className="quick-action" type="button" onClick={onClick}>
      {icon}
      <strong>{label}</strong>
      <em>{description}</em>
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  icon,
  label,
} : {
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button className={`toggle ${checked ? 'active' : ''}`} type="button" aria-pressed={checked} onClick={() => onChange(!checked)}>
      {icon}
      {label}
    </button>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={active ? 'active' : ''} type="button" role="tab" aria-selected={active} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented">
      {options.map(([optionValue, label]) => (
        <button
          className={value === optionValue ? 'active' : ''}
          key={optionValue}
          type="button"
          aria-pressed={value === optionValue}
          onClick={() => onChange(optionValue)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function MessageUsage({ usage }: { usage: Record<string, string | number | boolean> }) {
  const model = formatModelTierLabel(String(usage.model_tier || 'system'));
  const tokens = Number(usage.total_tokens || 0);
  const elapsedMs = Number(usage.elapsed_ms || 0);
  const parts = [model];
  if (tokens) parts.push(`${usage.estimated ? '≈' : ''}${Math.round(tokens).toLocaleString('ru-RU')} токенов`);
  if (elapsedMs) parts.push(elapsedMs < 1000 ? `${Math.round(elapsedMs)} мс` : `${(elapsedMs / 1000).toFixed(elapsedMs < 10000 ? 1 : 0)} с`);
  return <div className="message-usage">{parts.join(' · ')}</div>;
}

function ChoiceGroup({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string; detail: string; icon: ReactNode }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="choice-group">
      {options.map((option) => (
        <button
          className={value === option.value ? 'active' : ''}
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          title={`${option.label} ${option.detail}`}
        >
          {option.icon}
          <span>
            <strong>{option.label}</strong>
            <em>{option.detail}</em>
          </span>
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-row">
      <span>
        {label}
        <strong>{value}</strong>
      </span>
      <input min={min} max={max} step={step} value={value} type="range" onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function StatusPill({
  label,
  tone,
  icon,
}: {
  label: string;
  tone: 'ok' | 'warn' | 'neutral';
  icon?: ReactNode;
}) {
  return (
    <span className={`status-pill ${tone}`}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

function resolveMascotState({
  busy,
  inspectorTab,
  activity,
  model,
}: {
  busy: boolean;
  inspectorTab: InspectorTab;
  activity: string;
  model: ModelStatus | null;
}): MascotState {
  if (activity === 'offline') return 'error';
  if (busy && inspectorTab === 'code') return 'coding';
  if (busy) return 'thinking';
  if (model?.loaded) return 'success';
  if (inspectorTab === 'resources') return 'security';
  return 'idle';
}

function formatMascotTitle(state: MascotState) {
  switch (state) {
  case 'thinking':
    return 'Oscar думает';
  case 'coding':
    return 'Oscar пишет код';
  case 'security':
    return 'Ресурсы';
  case 'success':
    return 'Backend готов';
  case 'error':
    return 'Нет связи';
  default:
    return 'Oscar';
  }
}

function formatMascotDetail(state: MascotState, activity: string) {
  if (state === 'error') return 'Проверь локальный backend';
  if (state === 'thinking') return 'Идёт генерация';
  if (state === 'coding') return 'Кодовое полотно активно';
  if (state === 'security') return 'Смотрю нагрузку runtime';
  if (state === 'success') return 'Локальная модель доступна';
  return formatActivity(activity);
}

function formatActivity(activity: string) {
  if (activity === 'checking') return 'Проверяю';
  if (activity === 'ready') return 'Готов';
  if (activity === 'offline') return 'Offline';
  if (activity === 'searching') return 'Поиск';
  if (activity === 'fallback') return 'Fallback';
  return activity;
}

function formatBackendActivity(activity: string) {
  if (activity === 'checking') return 'проверяю';
  if (activity === 'offline') return 'нет связи';
  return 'готов';
}

function resolveRequestedModel(modelSelection: ModelSelection, deepThinking: DeepThinkingMode, hasImages: boolean) {
  if (deepThinking === 'standard') return 'gemma4-deepthinking';
  if (deepThinking === 'extended') return 'gemma4-31b';
  if (hasImages && modelSelection === 'auto') return 'gemma4-balanced';
  return modelSelection === 'auto' ? undefined : modelSelection;
}

function formatConfiguredModelLabel(modelSelection: ModelSelection, deepThinking: DeepThinkingMode) {
  if (deepThinking !== 'off') {
    return formatModelTierLabel(resolveRequestedModel(modelSelection, deepThinking, false) || 'auto');
  }
  return modelSelection === 'auto' ? 'Auto router' : formatModelTierLabel(modelSelection);
}

function formatOutgoingStreamLabel(requestedModel: string | undefined, hasImages: boolean) {
  if (requestedModel) return formatModelTierLabel(requestedModel);
  if (hasImages) return 'Medium Vision';
  return 'подключаю поток';
}

function formatModelTierLabel(value: string) {
  switch (value) {
  case 'auto':
    return 'Auto router';
  case 'gemma4-fast':
  case 'weak':
  case 'gemma_low':
    return 'Fast';
  case 'gemma4-balanced':
  case 'medium':
  case 'vision':
  case 'gemma':
  case 'gemma_high':
    return 'Medium';
  case 'gemma4-deepthinking':
  case 'powerful':
  case 'reasoning':
    return 'Pro';
  case 'gemma4-31b':
    return 'Extra';
  case 'system':
    return 'Monarch';
  default:
    return value;
  }
}

function formatDeepThinkingChip(mode: DeepThinkingMode) {
  if (mode === 'standard') return 'Pro';
  if (mode === 'extended') return 'Extra';
  return 'DeepThinking';
}

function formatDeepThinkingTitle(mode: DeepThinkingMode) {
  if (mode === 'standard') return 'Pro: сложный анализ и разработка';
  if (mode === 'extended') return 'Extra: максимальная глубина';
  return 'DeepThinking выключен';
}

function buildRamNotice(info: HardwareInfo | null, requestedModel: string | undefined) {
  const available = info?.ram_available_gb;
  if (typeof available !== 'number') return null;
  if (available < 1.5) {
    return {
      level: 'critical',
      message: `Свободно ${available.toFixed(1)} ГБ RAM. Закрой лишние программы; красная граница — 1,5 ГБ.`,
    };
  }
  if (requestedModel !== 'gemma4-31b') return null;
  const projected = available - 19.7;
  if (projected >= 3) return null;
  return {
    level: projected < 1.5 ? 'critical' : 'caution',
    message: `Extra может занять около 19,7 ГБ RAM; ожидаемый запас — ${Math.max(0, projected).toFixed(1)} ГБ. Закрой тяжёлые программы, если они не нужны.`,
  };
}

function formatStreamStatus(message: UiMessage) {
  const status = (message.streamStatus || '').trim();
  if (!status) return message.content ? 'пишу ответ' : 'подключаю поток';
  if (status === 'ready') return 'готово';
  if (status === 'searching') return 'ищу контекст';
  if (status === 'offline') return 'нет связи';
  return status;
}

function resolveStreamOrbPhase(message: UiMessage): 'route' | 'search' | 'write' | 'error' {
  const events = message.streamEvents ?? [];
  const latest = events[events.length - 1];
  const status = `${message.streamStatus ?? ''} ${latest?.kind ?? ''} ${latest?.label ?? ''} ${latest?.detail ?? ''}`.toLowerCase();
  if (message.streamOk === false || latest?.kind === 'error' || /error|ошиб|fallback|offline/.test(status)) return 'error';
  if (latest?.kind === 'search' || latest?.kind === 'source' || /search|source|web|internet|поиск|источник|контекст|исслед/.test(status)) return 'search';
  if (message.content || latest?.kind === 'token' || latest?.kind === 'replace' || /token|фрагм|пиш|ответ|replace/.test(status)) return 'write';
  return 'route';
}

function isResearchOrSearchStream(message: UiMessage): boolean {
  const events = message.streamEvents ?? [];
  if (events.some((event) => event.kind === 'research' || event.kind === 'search' || event.kind === 'source')) {
    return true;
  }
  const activity = [
    message.streamStatus ?? '',
    ...events.flatMap((event) => [event.kind, event.label, event.detail ?? '']),
  ].join(' ').toLowerCase();
  return /research|search|source|web|internet|исслед|поиск|источник/.test(activity);
}

function formatGemmaModeLabel(model: ModelStatus | null) {
  if (!model) return 'проверяю gemma_models';
  const tier = formatStatusModelTier(model);
  if (model.gemma_model_ready && model.gemma_vision_ready && model.gemma_draft_ready) return `${tier}, vision, draft`;
  if (model.gemma_model_ready && model.gemma_vision_ready) return `${tier}, vision`;
  if (model.gemma_model_ready) return `${tier} готов`;
  if (model.gemma_partial_path) return 'модель скачивается';
  return 'жду файлы в gemma_models';
}

function formatGemmaModelStatus(model: ModelStatus | null) {
  if (!model) return 'проверяю';
  if (model.gemma_model_ready) return 'готова';
  if (model.gemma_partial_path) return 'скачивается';
  return 'нет файла';
}

function formatGemmaVisionStatus(model: ModelStatus | null) {
  if (!model) return 'проверяю';
  if (!model.gemma_vision_ready) return 'нет adapter';
  if (model.gemma_vision_runtime_status === 'loaded') return 'vision активен';
  if (model.gemma_vision_runtime_status === 'unsupported') return 'нужен update';
  return 'adapter готов';
}

function formatGemmaDraftStatus(model: ModelStatus | null) {
  if (!model) return 'проверяю';
  if (!model.gemma_draft_ready) return 'нет draft';
  if (model.speculative_status === 'loaded') return `${model.gemma_draft_mode ?? 'mtp'} активен`;
  if (model.speculative_status === 'unsupported') return 'runtime rejected';
  return `${model.gemma_draft_mode ?? 'mtp'} готов`;
}

function formatSpeculativeStatus(model: ModelStatus | null) {
  if (!model) return 'проверяю';
  if (!model.speculative_decoding) return 'выкл';
  if (model.speculative_status === 'loaded') return 'активно';
  if (model.speculative_status === 'available') return 'готово';
  if (model.speculative_status === 'missing') return 'нет draft';
  if (model.speculative_status === 'unsupported') return 'недоступно';
  return model.speculative_status || 'проверяю';
}

function formatRuntimeModelPath(model: ModelStatus | null, requestedModel: string | undefined) {
  if (!model) return 'E:\\Oscar\\model';
  const mainModelPath = model.gemma_main_model_path || model.gemma_model_path;
  if (model.active_tier?.startsWith('gemma') && mainModelPath) return mainModelPath;
  if (requestedModel?.startsWith('gemma') && mainModelPath) return mainModelPath;
  if (requestedModel?.startsWith('gemma') && model.gemma_partial_path) return model.gemma_partial_path;
  if (requestedModel?.startsWith('gemma') && model.gemma_models_dir) return model.gemma_models_dir;
  return model.model_path;
}

function formatStatusModelTier(model: ModelStatus) {
  if (model.active_tier?.startsWith('gemma')) {
    return formatModelTierLabel(model.active_tier);
  }
  const path = (model.gemma_main_model_path || model.gemma_model_path || '').toLowerCase();
  if (path.includes('e2b')) return 'Fast';
  if (path.includes('26b')) return 'Pro';
  if (path.includes('31b')) return 'Extra';
  if (path.includes('12b')) return 'Medium';
  return 'Gemma';
}

function formatStreamCount(message: UiMessage) {
  const count = message.streamTokens ?? 0;
  if (count <= 0) return '';
  return `${count} фрагм.`;
}

function formatStreamElapsed(message: UiMessage, now: number) {
  const startedAt = message.streamStartedAt ?? message.streamUpdatedAt;
  if (!startedAt) return '0 сек';
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds} сек`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatStreamChars(length: number) {
  if (length <= 0) return '';
  if (length < 1000) return `${length} симв.`;
  return `${(length / 1000).toFixed(1)}k симв.`;
}

function formatStreamFreshness(message: UiMessage, now: number) {
  if (!message.streamUpdatedAt) return '';
  const ageSeconds = Math.max(0, Math.floor((now - message.streamUpdatedAt) / 1000));
  if (ageSeconds < 2) return 'сейчас';
  return `${ageSeconds} сек назад`;
}

function formatStreamEventAge(at: number, now: number) {
  const ageSeconds = Math.max(0, Math.floor((now - at) / 1000));
  if (ageSeconds < 2) return 'сейчас';
  if (ageSeconds < 60) return `${ageSeconds} сек`;
  return `${Math.floor(ageSeconds / 60)} мин`;
}

function formatSourceCount(count: number) {
  if (count <= 0) return 'без источников';
  if (count === 1) return '1 источник';
  if (count > 1 && count < 5) return `${count} источника`;
  return `${count} источников`;
}

export function appendStreamEvent(message: UiMessage, event: Omit<StreamEvent, 'at' | 'count'>, now = Date.now()): UiMessage {
  const currentEvents = message.streamEvents ?? [];
  const previous = currentEvents[currentEvents.length - 1];

  if (previous && previous.kind === event.kind && previous.label === event.label && previous.detail === event.detail) {
    return {
      ...message,
      streamEvents: [
        ...currentEvents.slice(0, -1),
        {
          ...previous,
          at: now,
          count: (previous.count ?? 1) + 1,
        },
      ],
    };
  }

  return {
    ...message,
    streamEvents: [
      ...currentEvents.slice(-5),
      {
        ...event,
        at: now,
      },
    ],
  };
}

export function appendStreamToken(message: UiMessage, token: string): UiMessage {
  const currentStatus = (message.streamStatus || '').trim();
  const nextStatus = !currentStatus || currentStatus === 'подключаю поток' || currentStatus === 'подбираю контекст'
    ? 'пишу ответ'
    : currentStatus;
  const hadVisibleContent = Boolean(message.content.trim());

  const nextMessage = {
    ...message,
    content: message.content + token,
    streamStatus: nextStatus,
    streamTokens: (message.streamTokens ?? 0) + 1,
    streamUpdatedAt: Date.now(),
  };

  if (!hadVisibleContent && token.trim()) {
    return appendStreamEvent(nextMessage, { kind: 'token', label: 'пошел текст', detail: 'первый фрагмент' });
  }

  return nextMessage;
}

export function recoverUnfinishedStreamMessage(message: UiMessage): UiMessage {
  const notice = 'Поток ответа завершился без финального события. Ответ мог быть неполным.';
  if (message.content.trim()) {
    return appendStreamEvent({
      ...message,
      content: message.content.replace(/\s+$/, ''),
      pending: false,
      streamStatus: 'готово',
      streamUpdatedAt: Date.now(),
      streamOk: true,
    }, { kind: 'done', label: 'ответ сохранен', detail: 'финальное событие не пришло' });
  }

  const content = message.content.trim()
    ? `${message.content.replace(/\s+$/, '')}\n\n${notice}`
    : `${notice} Можно повторить запрос.`;

  return appendStreamEvent({
    ...message,
    content,
    pending: false,
    streamStatus: 'поток завершен',
    streamUpdatedAt: Date.now(),
  }, { kind: 'error', label: 'поток без финала', detail: 'ответ мог быть неполным' });
}

export function finalizeStreamMessage(
  message: UiMessage,
  ok: boolean,
  usage?: Record<string, string | number | boolean>,
): UiMessage {
  return appendStreamEvent({
    ...message,
    pending: false,
    streamStatus: ok ? 'готово' : 'fallback',
    streamUpdatedAt: Date.now(),
    streamOk: ok,
    usage,
  }, ok
    ? { kind: 'done', label: 'ответ готов' }
    : { kind: 'error', label: 'fallback-ответ', detail: 'локальная модель не завершила генерацию' });
}

function formatToolActivity(result: WorkspaceToolResult) {
  if (!result.ok) return 'ошибка инструмента';
  if (result.kind === 'memory') return 'память обновлена';
  if (result.action === 'search') return 'поиск в workspace';
  if (result.action === 'replace') return 'правлю файл';
  if (result.action === 'copy') return 'копирую артефакт';
  if (result.action === 'move') return 'перемещаю артефакт';
  if (result.action === 'trash') return 'убираю артефакт';
  if (result.action === 'restore') return 'восстанавливаю артефакт';
  if (result.action === 'read') return 'читаю файл';
  if (result.action === 'mkdir') return 'создаю папку';
  return 'работаю с файлом';
}

function formatToolAction(result: WorkspaceToolResult) {
  if (result.kind === 'memory') return 'Память';
  if (result.action === 'write') return 'Файл записан';
  if (result.action === 'append') return 'Файл дополнен';
  if (result.action === 'replace') return 'Файл изменен';
  if (result.action === 'copy') return 'Файл скопирован';
  if (result.action === 'move') return 'Файл перемещен';
  if (result.action === 'trash') return 'В корзине Oscar';
  if (result.action === 'restore') return 'Файл восстановлен';
  if (result.action === 'mkdir') return 'Папка создана';
  if (result.action === 'read') return 'Файл прочитан';
  if (result.action === 'list') return 'Список файлов';
  if (result.action === 'search') return 'Поиск по workspace';
  return result.action;
}

function formatToolDetail(result: WorkspaceToolResult) {
  if (result.path) return result.path;
  if (result.query) return `запрос: ${result.query}`;
  if (result.matches?.length) return `${result.matches.length} совпад.`;
  if (result.entries?.length) return `${result.entries.length} элементов`;
  return result.error ?? 'локальный инструмент';
}

function InlineNotice({ title, body, tone = 'neutral' }: { title: string; body: string; tone?: 'neutral' | 'error' }) {
  return (
    <div className={`inline-notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function toUserError(error: unknown) {
  if (error instanceof BackendHttpError) {
    return error.message;
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return 'Не могу подключиться к Oscar backend. Проверь, что локальный backend запущен.';
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Неизвестная ошибка runtime.';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function formatSearchResultMeta(result: SearchResult) {
  const chars = result.chars.toLocaleString('ru-RU');
  if (result.ingestion_status === 'page') return `${chars} симв. страницы в памяти`;
  if (result.ingestion_status === 'snippet') return `${chars} симв. сниппета в памяти`;
  if (result.ingestion_status === 'blocked') return 'заблокировано безопасностью';
  if (result.ingestion_status === 'failed') return 'не удалось сохранить источник';
  if (result.ingestion_status === 'skipped') return 'источник пропущен';
  if (result.ingested) return `${chars} симв. в памяти`;
  return formatHost(result.url);
}

function formatVram(info: HardwareInfo | null) {
  if (!info?.gpu_memory_total_mb) return 'нет данных';
  const used = info.gpu_memory_used_mb ?? 0;
  return `${Math.round(used / 1024)} / ${Math.round(info.gpu_memory_total_mb / 1024)} GB`;
}

function formatRam(info: HardwareInfo | null) {
  if (!info?.ram_total_gb) return 'нет данных';
  return `${Math.round((info.ram_total_gb - (info.ram_available_gb ?? 0)) * 10) / 10} / ${Math.round(info.ram_total_gb)} GB`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать изображение.'));
    reader.readAsDataURL(file);
  });
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function isStatusEvent(data: unknown): data is { message: string } {
  return typeof data === 'object' && data !== null && 'message' in data;
}

function isResearchEvent(data: unknown): data is { stage: string; label: string; detail?: string } {
  return typeof data === 'object'
    && data !== null
    && typeof (data as { stage?: unknown }).stage === 'string'
    && typeof (data as { label?: unknown }).label === 'string';
}

function isTokenEvent(data: unknown): data is { token: string } {
  return typeof data === 'object' && data !== null && 'token' in data;
}

function isReplaceEvent(data: unknown): data is { content: string } {
  return typeof data === 'object' && data !== null && typeof (data as { content?: unknown }).content === 'string';
}

function isSourcesEvent(data: unknown): data is { sources: ChatSource[] } {
  return typeof data === 'object' && data !== null && Array.isArray((data as { sources?: unknown }).sources);
}

function isToolEvent(data: unknown): data is { result: WorkspaceToolResult } {
  if (typeof data !== 'object' || data === null || !('result' in data)) return false;
  const result = (data as { result?: unknown }).result;
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as WorkspaceToolResult).action === 'string' &&
    typeof (result as WorkspaceToolResult).summary === 'string' &&
    typeof (result as WorkspaceToolResult).ok === 'boolean'
  );
}

function quickActionIcon(label: string) {
  if (label === 'Память') return <Database size={18} />;
  if (label === 'Следующий шаг') return <Zap size={18} />;
  if (label === 'Рабочий файл') return <FileText size={18} />;
  return <Globe2 size={18} />;
}

function firstImageFile(transfer: DataTransfer | null) {
  if (!transfer) return null;
  const direct = Array.from(transfer.files || []).find((file) => file.type.startsWith('image/'));
  if (direct) return direct;
  for (const item of Array.from(transfer.items || [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

function requestDeepThinkingConsent(): Promise<'allow' | 'deny'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'route-consent';
    overlay.innerHTML = `
      <div class="route-consent-card" role="dialog" aria-modal="true" aria-label="Выбор модели">
        <span>Auto router</span>
        <strong>Для этого запроса выбран Pro</strong>
        <p>Pro работает глубже, но заметно дольше. Разрешить его для одного ответа?</p>
        <div><button data-route="deny">Остаться на Medium</button><button class="primary" data-route="allow">Разрешить Pro</button></div>
      </div>`;
    const finish = (decision: 'allow' | 'deny') => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(decision);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish('deny');
    };
    overlay.addEventListener('click', (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-route]');
      if (button) finish(button.dataset.route === 'allow' ? 'allow' : 'deny');
    });
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('[data-route="allow"]')?.focus();
  });
}

function normalizeMarkdownNumbering(source: string) {
  return source.split(/(\n{3,})/).map((segment) => {
    const markers = [...segment.matchAll(/^\s*(\d+)[.)]\s+/gm)];
    if (markers.length < 2 || markers.some((match) => match[1] !== '1')) return segment;
    let index = 0;
    return segment.replace(/^(\s*)1([.)])\s+/gm, (_match, indent, suffix) => {
      index += 1;
      return `${indent}${index}${suffix} `;
    });
  }).join('');
}

function isErrorEvent(data: unknown): data is { message: string } {
  return isStatusEvent(data);
}

function isDoneEvent(data: unknown): data is { ok: boolean; usage?: Record<string, string | number | boolean> } {
  return typeof data === 'object' && data !== null && typeof (data as { ok?: unknown }).ok === 'boolean';
}
