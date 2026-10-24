export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
  const { startAutomationSupervisor } = await import("./lib/automation");
  startAutomationSupervisor();
}
