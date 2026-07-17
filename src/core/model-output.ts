export type MonarchModelOutputStatus = 'success' | 'partial' | 'error';
export type MonarchModelOutputType = 'text' | 'json' | 'code' | 'html' | 'md' | 'artifact';

export interface MonarchModelOutputEnvelope {
  schemaVersion: 'monarch.model-output.v1';
  intent: string;
  status: MonarchModelOutputStatus;
  outputType: MonarchModelOutputType;
  data: unknown;
  userMessage: string;
  meta: Record<string, unknown>;
}

export function normalizeModelOutput(rawOutput: unknown): MonarchModelOutputEnvelope {
  if (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
    return normalizeEnvelopeObject(rawOutput as Record<string, unknown>);
  }

  const text = String(rawOutput || '').trim();
  if (!text) {
    return buildEnvelope({
      status: 'error',
      outputType: 'text',
      data: { text: '' },
      userMessage: 'Model output is empty.',
      meta: { source: 'empty' },
    });
  }

  const parsedJson = parseJsonLikeText(text);
  if (parsedJson.ok) {
    return normalizeEnvelopeObject(parsedJson.value);
  }

  const code = parseFencedCode(text);
  if (code) {
    return buildEnvelope({
      outputType: 'code',
      data: code,
      userMessage: 'Code block extracted from model output.',
      meta: { source: 'fenced-code' },
    });
  }

  return buildEnvelope({
    outputType: inferTextOutputType(text),
    data: { text },
    userMessage: text,
    meta: { source: 'plain-text' },
  });
}

function normalizeEnvelopeObject(record: Record<string, unknown>): MonarchModelOutputEnvelope {
  const hasEnvelopeShape = 'data' in record
    || 'output_type' in record
    || 'outputType' in record
    || 'user_message' in record
    || 'userMessage' in record;
  if (!hasEnvelopeShape) {
    return buildEnvelope({
      outputType: 'json',
      data: record,
      userMessage: 'Structured JSON output normalized.',
      meta: { source: 'json-object' },
    });
  }

  const outputType = normalizeOutputType(readString(record.output_type) || readString(record.outputType));
  const userMessage = readString(record.user_message)
    || readString(record.userMessage)
    || readString(record.message)
    || readString(record.summary)
    || 'Model output normalized.';
  const meta = record.meta && typeof record.meta === 'object' && !Array.isArray(record.meta)
    ? record.meta as Record<string, unknown>
    : {};

  return buildEnvelope({
    intent: readString(record.intent),
    status: normalizeStatus(readString(record.status)),
    outputType,
    data: 'data' in record ? record.data : record,
    userMessage,
    meta: {
      ...meta,
      source: 'envelope',
    },
  });
}

function parseJsonLikeText(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const direct = tryParseObject(text);
  if (direct.ok) {
    return direct;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParseObject(fenced[1].trim());
    if (parsed.ok) {
      return parsed;
    }
  }

  const embedded = extractBalancedJsonObject(text);
  return embedded ? tryParseObject(embedded) : { ok: false };
}

function tryParseObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ok: true, value: parsed as Record<string, unknown> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function extractBalancedJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start < 0) {
    return '';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return '';
}

function parseFencedCode(text: string): { language: string; code: string } | null {
  const match = text.match(/```([a-z0-9_-]*)\s*([\s\S]*?)```/i);
  if (!match?.[2]) {
    return null;
  }
  return {
    language: (match[1] || 'text').trim() || 'text',
    code: match[2].trim(),
  };
}

function inferTextOutputType(text: string): MonarchModelOutputType {
  if (/^\s*<!doctype html>|<html[\s>]/i.test(text)) {
    return 'html';
  }
  if (/^#\s+\S|^\s*[-*]\s+\S/m.test(text)) {
    return 'md';
  }
  return 'text';
}

function buildEnvelope(input: {
  intent?: string;
  status?: MonarchModelOutputStatus;
  outputType: MonarchModelOutputType;
  data: unknown;
  userMessage: string;
  meta?: Record<string, unknown>;
}): MonarchModelOutputEnvelope {
  return {
    schemaVersion: 'monarch.model-output.v1',
    intent: input.intent || 'unknown',
    status: input.status || 'success',
    outputType: input.outputType,
    data: input.data,
    userMessage: input.userMessage,
    meta: input.meta || {},
  };
}

function normalizeOutputType(value: string): MonarchModelOutputType {
  switch (value.toLowerCase()) {
  case 'json':
    return 'json';
  case 'code':
    return 'code';
  case 'html':
    return 'html';
  case 'md':
  case 'markdown':
    return 'md';
  case 'artifact':
    return 'artifact';
  case 'text':
  default:
    return 'text';
  }
}

function normalizeStatus(value: string): MonarchModelOutputStatus {
  switch (value.toLowerCase()) {
  case 'partial':
    return 'partial';
  case 'error':
    return 'error';
  case 'success':
  default:
    return 'success';
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
