/** The owning runtime coalesces cycles and drains them before disconnecting. */
export function createMaintenanceTask(intervalMs: number, nextScheduledAt?: (now: Date) => number) {
  let nextAt = -Infinity;
  return async (now: Date, run: () => Promise<boolean | void>): Promise<void> => {
    if (now.getTime() < nextAt) return;
    // A full batch may have more work: keep draining on subsequent ticks.
    if ((await run()) === true) return;
    // Only successful work advances the deadline; failures retry on the next worker tick.
    nextAt = Math.min(now.getTime() + intervalMs, nextScheduledAt?.(now) ?? Infinity);
  };
}
