import type {
  MonarchIntent,
  MonarchIntentClassification,
  MonarchModelRouteDecision,
  MonarchModelRouteRole,
} from './contracts';
import { clampConfidence, normalizeText } from './utils';

export function selectModelRoute(
  intent: MonarchIntent,
  classification: MonarchIntentClassification
): MonarchModelRouteDecision {
  const hasImages = Array.isArray(intent.context?.image_attachments) && intent.context.image_attachments.length > 0;
  return selectModelRouteForText(intent.text, classification, hasImages);
}

export function selectModelRouteForText(
  text: string,
  classification: MonarchIntentClassification,
  hasImageAttachments: boolean = false
): MonarchModelRouteDecision {
  const normalized = normalizeText(text);
  const selectedRole = selectRole(classification, hasImageAttachments);
  const fallbackRoles = fallbackRolesFor(selectedRole);
  const confidence = clampConfidence(Math.max(0.52, classification.confidence - 0.04));

  return {
    selectedRole,
    confidence,
    reason: modelRouteReason(selectedRole, classification, normalized, hasImageAttachments),
    fallbackRoles,
  };
}

function selectRole(
  classification: MonarchIntentClassification,
  hasImageAttachments: boolean
): MonarchModelRouteRole {
  if (hasImageAttachments || classification.modelRolePreference === 'vision') {
    return 'gemma4-balanced';
  }
  if (classification.modelRolePreference === 'powerful') {
    return 'gemma4-deepthinking';
  }
  if (classification.modelRolePreference === 'medium') {
    return 'gemma4-balanced';
  }
  return 'gemma4-fast';
}

function fallbackRolesFor(role: MonarchModelRouteRole): MonarchModelRouteRole[] {
  switch (role) {
  case 'gemma4-fast':
    return ['gemma4-balanced', 'gemma4-deepthinking'];
  case 'gemma4-balanced':
    return ['gemma4-fast', 'gemma4-deepthinking'];
  case 'gemma4-deepthinking':
    return ['gemma4-balanced', 'gemma4-fast'];
  case 'vision':
    return ['gemma4-balanced', 'gemma4-fast'];
  case 'powerful':
    return ['gemma4-deepthinking', 'gemma4-balanced'];
  case 'medium':
    return ['gemma4-balanced', 'gemma4-fast'];
  case 'weak':
    return ['gemma4-balanced', 'gemma4-fast'];
  case 'router':
    return ['gemma4-fast', 'gemma4-balanced'];
  }
}

function modelRouteReason(
  role: MonarchModelRouteRole,
  classification: MonarchIntentClassification,
  text: string,
  hasImageAttachments: boolean = false
): string {
  if (role === 'gemma4-fast') {
    return 'Gemma 4 Fast selected for a short lightweight request.';
  }
  if (role === 'gemma4-balanced') {
    if (hasImageAttachments || classification.modelRolePreference === 'vision') {
      return hasImageAttachments
        ? 'Gemma 4 Balanced selected for the vision-capable local path due to attached images.'
        : 'Gemma 4 Balanced selected for the vision-capable local path.';
    }
    return `The adaptive complexity profile selected the balanced Gemma 4 tier for ${classification.kind}.`;
  }
  if (role === 'gemma4-deepthinking') {
    return `Intent kind ${classification.kind} needs stronger reasoning; Pro (26B) is the highest autonomous tier.`;
  }
  if (role === 'vision') {
    return hasImageAttachments
      ? 'Multimodal request needs the vision-capable local model due to attached images.'
      : 'Multimodal request needs the vision-capable local model.';
  }
  if (role === 'powerful') {
    return classification.modelTierBoost >= 2
      ? 'Structured, action, code, or long-context signals require the powerful tier.'
      : `Intent kind ${classification.kind} prefers the powerful tier.`;
  }
  if (role === 'medium') {
    return text.length > 160
      ? 'Medium tier selected for a longer normal request.'
      : `Intent kind ${classification.kind} prefers the medium tier.`;
  }
  if (role === 'router') {
    return 'Router role is reserved for dispatch-only classification.';
  }
  return 'Weak tier selected for a short lightweight request.';
}
