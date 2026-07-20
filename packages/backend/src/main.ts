import { VERSION } from "@dat-bot/shared";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { acquireDataDirLock, type DataDirLock } from "./data-dir-lock.js";
import { redactLogArgument } from "./redaction.js";

let dataDirLock: DataDirLock | null = null;
let logError: (...args: unknown[]) => void = (...args) =>
  console.error(...args.map(redactLogArgument));

function releaseDataDirLock(): void {
  if (!dataDirLock) return;
  const owned = dataDirLock;
  dataDirLock = null;
  try {
    owned.release();
  } catch (error) {
    logError(`Failed to release DATA_DIR lock: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  // Acquire DATA_DIR before importing config/runtime/activity singletons: config
  // migration can write during module evaluation, so locking later in startup
  // would still permit two processes to race that first mutation.
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  loadEnv({ path: path.resolve(moduleDirectory, "../../../.env") });
  const startupDataDir = path.resolve(
    process.env.DATA_DIR ?? path.resolve(moduleDirectory, "../../../data"),
  );
  dataDirLock = acquireDataDirLock(startupDataDir);
  process.once("exit", releaseDataDirLock);

  const [
    { appConfig },
    { logger },
    { runtime },
    { buildServer, revokeAndDrainApiExecution },
    { getChainId },
    { stopEngine, waitForEngineIdle },
  ] = await Promise.all([
    import("./config.js"),
    import("./logger.js"),
    import("./runtime.js"),
    import("./api.js"),
    import("./chain.js"),
    import("./strategy.js"),
  ]);
  logError = (...args) => logger.error(...args);
  if (path.resolve(appConfig.dataDir) !== startupDataDir) {
    throw new Error(
      `startup DATA_DIR changed during configuration load: locked ${startupDataDir}, `
      + `configured ${path.resolve(appConfig.dataDir)}`,
    );
  }
  logger.info(`DeathAndTaxes bot v${VERSION} starting in ${appConfig.mode} mode`);
  logger.info(`Game contract: ${appConfig.gameAddress}`);

  try {
    runtime.chainId = await getChainId();
  } catch (err) {
    // Keep the local dashboard available for RPC configuration/recovery. Wallet
    // unlock and Start independently fail closed until chain identity is known.
    runtime.chainId = null;
    logger.warn(`Initial chain ID lookup failed: ${(err as Error).message}`);
  }

  const app = await buildServer();
  await app.listen({ port: appConfig.port, host: appConfig.host });
  const displayHost = appConfig.host.includes(":") ? `[${appConfig.host}]` : appConfig.host;
  logger.info(`API listening on http://${displayHost}:${appConfig.port}`);
  logger.info(
    runtime.strategy.dryRun
      ? "DRY-RUN is ON — no transactions will be sent until you turn it off."
      : "DRY-RUN is OFF — the bot can submit real transactions when unlocked, armed, and running.",
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    // Revoke WAL replay authority synchronously before Fastify starts draining
    // active requests. Otherwise a Start/JIT handler waiting for a future-valid
    // timestamp can both hold close() open and broadcast after SIGINT/SIGTERM.
    const apiDrain = revokeAndDrainApiExecution(app);
    stopEngine();
    const closeServer = app.close();
    await apiDrain;
    // A lifecycle mutation already beyond its cancellable RPC step may have
    // reached a restart finally block. Stop once more after the API queue drains.
    stopEngine();
    await waitForEngineIdle();
    await closeServer;
    releaseDataDirLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logError("Fatal:", err);
  releaseDataDirLock();
  process.exit(1);
});
