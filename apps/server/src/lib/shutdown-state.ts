/**
 * Tracks whether the process is shutting down.
 *
 * During shutdown, execution finalizers must not overwrite the recovery state
 * that was captured for running features, otherwise those features are lost on
 * the next start instead of being resumed.
 */

let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
