export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeObservability } = await import("./lib/observability");
    await initializeObservability();
  }
}
