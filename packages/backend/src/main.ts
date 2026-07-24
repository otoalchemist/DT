import { VERSION } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { runtime } from "./runtime.js";
import { buildServer } from "./api.js";
import { getChainId } from "./chain.js";
import { prewarmTargets } from "./service.js";

async function main(): Promise<void> {
  logger.info(`DeathAndTaxes bot v${VERSION} starting in ${appConfig.mode} mode`);
  logger.info(`Game contract: ${appConfig.gameAddress}`);

  runtime.chainId = await getChainId();

  const app = await buildServer();
  await app.listen({ port: appConfig.port, host: appConfig.host });
  logger.info(`API listening on http://${appConfig.host}:${appConfig.port}`);
  logger.info(
    runtime.strategy.dryRun
      ? "DRY-RUN is ON — no transactions will be sent until you turn it off."
      : "DRY-RUN is OFF — the bot will submit real transactions when unlocked and enabled.",
  );

  // Warm the rival-target caches in the background so the first dashboard load is fast
  // (the cold full-collection enumeration is ~15s). Best-effort; needs the NFT API.
  if (appConfig.nftUrl) void prewarmTargets();

  const shutdown = async () => {
    logger.info("Shutting down...");
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
