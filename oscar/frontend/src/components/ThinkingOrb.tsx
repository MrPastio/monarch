import type { CSSProperties } from 'react';

export interface ThinkingOrbProps {
  size?: number;
  className?: string;
}

/**
 * Framework-local port of @illuma-ai/icons/brand ThinkingOrb 2.7.0 (MIT).
 * Keeping the tiny primitive local avoids pulling Framer Motion into the Oscar
 * preview through the package's combined brand entrypoint.
 */
export function ThinkingOrb({ size = 16, className = '' }: ThinkingOrbProps) {
  const style = { width: size, height: size } satisfies CSSProperties;
  return (
    <span
      className={`illuma-thinking-orb${className ? ` ${className}` : ''}`}
      role="img"
      aria-label="Thinking"
      style={style}
    />
  );
}
