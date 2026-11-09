import type { LoggerService } from '@nestjs/common';

/** One JSON object per line on stdout/stderr: easy to read for humans and to ship to a collector. */
export class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string, stack?: string): void {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      context,
      message: typeof message === 'string' ? message : String(message),
      ...(stack ? { stack } : {}),
    });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    // Nest calls error(message, stack, context) or error(message, context).
    if (context === undefined && stackOrContext !== undefined && !stackOrContext.includes('\n')) {
      this.write('error', message, stackOrContext);
    } else {
      this.write('error', message, context, stackOrContext);
    }
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
}
