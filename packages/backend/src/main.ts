import { VERSION } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { runtime } from "./runtime.js";
import { buildServer } from "./api.js";
import { getChainId } from "./chain.js";
import { prewarmTargets } from "./service.js";
import { activity } from "./activity.js";

async function main(): Promise<void> {
  logger.info(`DeathAndTaxes bot v${VERSION} starting in ${appConfig.mode} mode`);
  logger.info(`Game contract: ${appConfig.gameAddress}`);

  runtime.chainId = await getChainId();

  const app = await buildServer();
  await app.listen({ port: appConfig.port, host: appConfig.host });
  logger.info(`API listening on http://${appConfig.host}:${appConfig.port}`);
  logger.info("LIVE FIRE — the bot submits real transactions when unlocked and enabled.");

  // Warm the rival-target caches in the background so the first dashboard load is fast
  // (the cold full-collection enumeration is ~15s). Best-effort; needs the NFT API.
  //
  // On a fresh install there is no key yet, so this is skipped — POST /api/settings warms
  // them when the key arrives instead. Without that, the first dashboard load after setup
  // paid the whole cold enumeration against a blank screen, which reads as "blockchain
  // data isn't loading".
  if (appConfig.nftUrl) {
    void prewarmTargets();
  } else {
    // Say so loudly: with no key the RPC client falls back to viem's default PUBLIC
    // mainnet endpoint, so the bot appears connected while ownership enumeration (which
    // needs the Alchemy NFT API) silently returns nothing.
    logger.warn(
      "No Alchemy API key configured — using the default public RPC and NO NFT API. " +
        "Token/target lists stay empty until a key is saved in the UI.",
    );
  }

  const shutdown = async () => {
    logger.info("Shutting down...");
    await app.close();
    // The periodic flush is async now, so a pending write may not have had a turn before
    // exit — persist synchronously here or the last few seconds of activity are lost.
    activity.flushSync();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("Fatal:", err);
  process.exit(1);
});
