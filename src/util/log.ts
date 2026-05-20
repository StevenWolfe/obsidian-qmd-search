export type LogLevel = 'off' | 'error' | 'warn' | 'debug';

let currentLevel: LogLevel = 'error';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

const LEVELS: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, debug: 3 };

function enabled(level: Exclude<LogLevel, 'off'>): boolean {
  return LEVELS[currentLevel] >= LEVELS[level];
}

export const log = {
  error: (...args: unknown[]) => { if (enabled('error')) console.error('[qmd]', ...args); },
  warn:  (...args: unknown[]) => { if (enabled('warn'))  console.warn( '[qmd]', ...args); },
  info:  (...args: unknown[]) => { if (enabled('warn'))  console.info( '[qmd]', ...args); },
  debug: (...args: unknown[]) => { if (enabled('debug')) console.debug('[qmd]', ...args); },
};
