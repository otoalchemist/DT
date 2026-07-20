import { VERSION } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { runtime } from "./runtime.js";
import { buildServer } from "./api.js";
import { getChainId } from "./chain.js";
import { stopEngine, waitForEngineIdle } from "./strategy.js";

async function main(): Promise<void> {
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
    stopEngine();
    await waitForEngineIdle();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("Fatal:", err);
  process.exit(1);
});
