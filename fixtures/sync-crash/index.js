// dshpkg fixture — intentional runtime crash: a timer callback throws
// synchronously after the profile has booted, killing the process
// (uncaughtException — the class of failure only the L3 watchdog can heal).
export const name = "sync-crash-fixture";

export function apply(ctx) {
  setTimeout(() => {
    throw new Error("sync-crash fixture: intentional uncaughtException");
  }, 5000);
}
