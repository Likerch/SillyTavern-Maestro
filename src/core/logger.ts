import type { Logger } from '../shared/contracts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogLine {
    at: number;
    level: LogLevel;
    scope: string;
    text: string;
}

const MAX_LINES = 500;

/** Console logger with a ring buffer of warnings and errors (shown in the pult, exported for debugging). */
export class ConsoleLogger implements Logger {
    private static threshold: LogLevel = 'info';
    private static lines: LogLine[] = [];

    constructor(private readonly prefix = 'Maestro') {}

    static setLevel(level: LogLevel): void {
        ConsoleLogger.threshold = level;
    }

    static recent(): LogLine[] {
        return [...ConsoleLogger.lines];
    }

    static clear(): void {
        ConsoleLogger.lines = [];
    }

    scope(name: string): Logger {
        return new ConsoleLogger(`${this.prefix}:${name}`);
    }

    debug(...args: unknown[]): void {
        this.write('debug', args);
    }

    info(...args: unknown[]): void {
        this.write('info', args);
    }

    warn(...args: unknown[]): void {
        this.write('warn', args);
    }

    error(...args: unknown[]): void {
        this.write('error', args);
    }

    private write(level: LogLevel, args: unknown[]): void {
        if (ORDER[level] >= ORDER.warn) {
            ConsoleLogger.lines.push({
                at: Date.now(),
                level,
                scope: this.prefix,
                text: args.map(stringify).join(' '),
            });
            if (ConsoleLogger.lines.length > MAX_LINES)
                ConsoleLogger.lines.splice(0, ConsoleLogger.lines.length - MAX_LINES);
        }
        if (ORDER[level] < ORDER[ConsoleLogger.threshold]) return;
        const tag = `[${this.prefix}]`;
        if (level === 'debug') console.debug(tag, ...args);
        else if (level === 'info') console.info(tag, ...args);
        else if (level === 'warn') console.warn(tag, ...args);
        else console.error(tag, ...args);
    }
}

function stringify(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function createLogger(): Logger {
    return new ConsoleLogger();
}
