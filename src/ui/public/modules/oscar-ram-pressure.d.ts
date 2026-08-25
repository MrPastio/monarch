export interface OscarRamNotice {
  level: 'critical' | 'caution';
  title: string;
  message: string;
  action: 'use-balanced' | null;
  source: 'runtime' | 'estimate' | 'hardware';
  availableRamGb: number | null;
  estimatedRamGb: number | null;
  projectedRamGb: number | null;
  reclaimRamGb: number | null;
}

export const OSCAR_RAM_CRITICAL_HEADROOM_GB: number;
export const OSCAR_RAM_RECOMMENDED_HEADROOM_GB: number;
export const OSCAR_EXTRA_ESTIMATED_RAM_GB: number;
export const OSCAR_PRO_ESTIMATED_RAM_GB: number;

export function buildOscarRamNotice(input?: {
  requestedModel?: string;
  hardware?: { ram_available_gb?: number | null } | null;
  modelStatus?: { loaded?: boolean; active_tier?: string | null } | null;
  assessment?: {
    ram_available_gb?: number | null;
    estimated_ram_required_gb?: number | null;
    projected_ram_available_gb?: number | null;
    ram_warning?: 'none' | 'caution' | 'critical';
    ram_warning_message?: string | null;
    configured_context_tokens?: number | null;
    effective_context_tokens?: number | null;
    adaptive_context_applied?: boolean;
  } | null;
}): OscarRamNotice | null;

export function formatRamGb(value: number): string;
