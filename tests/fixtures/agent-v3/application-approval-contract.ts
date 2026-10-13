import { compiledFixtureRequest, compiledFixtureTargets } from './application-source-contract';
export type ApprovalFixtureKind = 'approval-reply' | 'approval-draft';
export function approvalFixtureTargets() {
  const selected = compiledFixtureTargets(); selected.targets.find(target => target.id === 'new_file')!.relativePath = 'Новый отчёт.txt';
  return selected;
}
export function approvalFixtureRequest(kind: ApprovalFixtureKind) {
  return { ...compiledFixtureRequest('compiled-reply'), text: 'Обработай выбранную цель согласно явно заданному действию.',
    goal: { kind: 'create' as const, target: 'new_file', content: { kind: kind === 'approval-reply' ? 'reply' as const : 'draft' as const } } };
}
