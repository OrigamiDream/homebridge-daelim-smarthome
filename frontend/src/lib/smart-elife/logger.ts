type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface LoggerBase {
  (message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
  debug(message: string, ...parameters: unknown[]): void;
}

const MAX_LOGS = 200;
const LOG_KEY = Symbol.for("smart-home-dashboard.smart-elife-logs");
const globalLogs = globalThis as typeof globalThis & {
  [LOG_KEY]?: LogEntry[];
};
const entries = globalLogs[LOG_KEY] ?? [];
globalLogs[LOG_KEY] = entries;

function format(message: string, parameters: unknown[]) {
  let index = 0;
  return String(message).replace(/%[sdj]/g, () => String(parameters[index++] ?? ""));
}

function append(level: LogLevel, message: string, parameters: unknown[]) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: format(message, parameters),
  };
  entries.unshift(entry);
  entries.splice(MAX_LOGS);

  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  target(`[smart-elife:${level}] ${entry.message}`);
}

const logger = ((message: string, ...parameters: unknown[]) => {
  append("info", message, parameters);
}) as LoggerBase;

logger.info = (message: string, ...parameters: unknown[]) => append("info", message, parameters);
logger.warn = (message: string, ...parameters: unknown[]) => append("warn", message, parameters);
logger.error = (message: string, ...parameters: unknown[]) => append("error", message, parameters);
logger.debug = (message: string, ...parameters: unknown[]) => append("debug", message, parameters);

export function getLogEntries() {
  return entries;
}

export default logger;
