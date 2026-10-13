import {
  comparableApplicationText,
  resolveInstalledApplication,
  type InstalledApplicationCatalogEntry,
  type RankedInstalledApplication,
} from './application-resolver';

export type SemanticTargetRole =
  | 'media.music'
  | 'communication.messaging'
  | 'communication.mail'
  | 'web.browser'
  | 'productivity.notes'
  | 'office.documents'
  | 'development.ide'
  | 'entertainment.games';

export interface SemanticTargetPreferences {
  preferredTargetByRole?: Partial<Record<SemanticTargetRole, string>>;
}

export type SemanticTargetResolution =
  | { status: 'missing'; role: SemanticTargetRole | null; candidates: RankedInstalledApplication[] }
  | { status: 'ambiguous'; role: SemanticTargetRole | null; candidates: RankedInstalledApplication[] }
  | { status: 'unique'; role: SemanticTargetRole | null; selected: RankedInstalledApplication; candidates: RankedInstalledApplication[] };

interface SemanticRoleDefinition {
  role: SemanticTargetRole;
  requestTerms: readonly string[];
  identityTerms: readonly string[];
}

const ROLE_DEFINITIONS: readonly SemanticRoleDefinition[] = Object.freeze([
  {
    role: 'media.music',
    requestTerms: ['music', 'музыка', 'музыку', 'аудио', 'плеер', 'music player'],
    identityTerms: ['youtube music', 'yt music', 'spotify', 'deezer', 'tidal', 'apple music', 'яндекс музыка', 'yandex music', 'soundcloud', 'foobar', 'aimp', 'winamp'],
  },
  {
    role: 'communication.messaging',
    requestTerms: ['messenger', 'мессенджер', 'сообщения', 'чаты', 'чат'],
    identityTerms: ['telegram', 'whatsapp', 'signal', 'discord', 'viber', 'slack', 'teams', 'messenger'],
  },
  {
    role: 'communication.mail',
    requestTerms: ['mail', 'email', 'почта', 'почту'],
    identityTerms: ['outlook', 'thunderbird', 'gmail', 'proton mail', 'mailbird', 'почта'],
  },
  {
    role: 'web.browser',
    requestTerms: ['browser', 'браузер', 'интернет'],
    identityTerms: ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'browser'],
  },
  {
    role: 'productivity.notes',
    requestTerms: ['notes', 'note', 'заметки', 'заметку', 'блокнот'],
    identityTerms: ['notion', 'obsidian', 'onenote', 'evernote', 'notepad', 'заметки', 'блокнот'],
  },
  {
    role: 'office.documents',
    requestTerms: ['documents', 'document', 'документы', 'документ', 'текстовый редактор'],
    identityTerms: ['word', 'libreoffice writer', 'onlyoffice', 'pages', 'документы'],
  },
  {
    role: 'development.ide',
    requestTerms: ['ide', 'редактор кода', 'код', 'разработка'],
    identityTerms: ['visual studio code', 'vscode', 'visual studio', 'cursor', 'zed', 'webstorm', 'intellij', 'pycharm', 'sublime text'],
  },
  {
    role: 'entertainment.games',
    requestTerms: ['games', 'game launcher', 'игры', 'игру', 'игровой лаунчер'],
    identityTerms: ['steam', 'epic games', 'gog galaxy', 'xbox', 'battle net', 'ubisoft connect', 'ea app'],
  },
]);

/**
 * Resolves either a concrete product name or a semantic user role against the
 * same real Windows target graph. Product-specific names live only in role
 * metadata; Voice itself never contains per-application branches.
 */
export function resolveSemanticApplicationTarget(
  queryValue: unknown,
  entries: readonly InstalledApplicationCatalogEntry[],
  preferences: SemanticTargetPreferences = {},
): SemanticTargetResolution {
  const query = comparableApplicationText(queryValue);
  const definition = roleForRequest(query);
  const direct = resolveInstalledApplication(query, entries);
  if (!definition && direct.status === 'unique') {
    return { status: 'unique', role: null, selected: direct.selected, candidates: direct.candidates };
  }
  if (!definition) return { ...direct, role: null };

  const roleCandidates = entries
    .filter((entry) => entryMatchesRole(entry, definition))
    .map((entry) => ({ ...entry, score: 1, matchKind: 'exact' as const }))
    .sort((left, right) => sourcePriority(left.source) - sourcePriority(right.source) || left.name.localeCompare(right.name))
    .slice(0, 8);
  if (roleCandidates.length === 0) return { status: 'missing', role: definition.role, candidates: [] };

  const preference = comparableApplicationText(preferences.preferredTargetByRole?.[definition.role] || '');
  if (preference) {
    const preferred = roleCandidates.find((entry) => [entry.name, entry.launchId, entry.executableName]
      .some((value) => comparableApplicationText(value || '').includes(preference)));
    if (preferred) return { status: 'unique', role: definition.role, selected: preferred, candidates: roleCandidates };
  }

  const identities = deduplicateProductIdentities(roleCandidates);
  if (identities.length === 1) {
    return { status: 'unique', role: definition.role, selected: identities[0]!, candidates: roleCandidates };
  }
  return { status: 'ambiguous', role: definition.role, candidates: identities.slice(0, 5) };
}

export function classifySemanticTargetRole(queryValue: unknown): SemanticTargetRole | null {
  return roleForRequest(comparableApplicationText(queryValue))?.role || null;
}

function roleForRequest(query: string): SemanticRoleDefinition | null {
  return ROLE_DEFINITIONS.find((definition) => definition.requestTerms
    .some((term) => comparableApplicationText(term) === query)) || null;
}

function entryMatchesRole(entry: InstalledApplicationCatalogEntry, definition: SemanticRoleDefinition): boolean {
  const identity = comparableApplicationText(`${entry.name} ${entry.executableName || ''} ${entry.launchId}`);
  return definition.identityTerms.some((term) => identity.includes(comparableApplicationText(term)));
}

function deduplicateProductIdentities(entries: readonly RankedInstalledApplication[]): RankedInstalledApplication[] {
  const selected: RankedInstalledApplication[] = [];
  for (const entry of entries) {
    const identity = comparableApplicationText(entry.name);
    if (selected.some((candidate) => comparableApplicationText(candidate.name) === identity)) continue;
    selected.push(entry);
  }
  return selected;
}

function sourcePriority(source: InstalledApplicationCatalogEntry['source']): number {
  if (source === 'start-apps') return 0;
  if (source === 'shortcut') return 1;
  if (source === 'web-shortcut') return 2;
  return 3;
}
