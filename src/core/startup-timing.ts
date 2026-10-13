/** Opt-in numeric startup diagnostics. Never logs requests, paths or user data. */
export function traceMonarchStartup(phase: string): void {
  if (/^(1|true|yes)$/iu.test(process.env.MONARCH_STARTUP_TRACE || '')) {
    console.log(JSON.stringify({ diagnostic: 'monarch-startup', phase, processElapsedMs: Math.round(process.uptime() * 1000) }));
  }
}
