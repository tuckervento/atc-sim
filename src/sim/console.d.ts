// Sim and airport code may log while debugging (Q decided 2026-11-14). Everything else outside
// the ES built-ins (timers, network, files, DOM) stays unavailable, so the sim runs on its own
// clock. Only the methods below exist. Don't add this file to a project that also loads
// @types/node or the DOM lib; their `console` declarations would conflict.
export {};

interface SimConsole {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
}

declare global {
  var console: SimConsole;
}
