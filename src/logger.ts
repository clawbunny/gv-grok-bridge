/**
 * Shared structured logger with level filtering.
 * Replaces ad-hoc console.log spam in every module.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  private label: string;
  private minLevel: number;

  constructor(label: string, level: LogLevel = 'info') {
    this.label = label;
    this.minLevel = LEVELS.indexOf(level);
  }

  setLevel(level: LogLevel): void {
    this.minLevel = LEVELS.indexOf(level);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.log('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.log('error', msg, meta);
  }

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS.indexOf(level) < this.minLevel) return;
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${ts}] [${level.toUpperCase()}] [${this.label}] ${msg}${metaStr}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

/** No-op logger for tests to suppress output. */
export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
