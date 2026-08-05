import { VERSION } from "@dat-bot/shared";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";
import { runtime, loadRivalSkippers, adoptRefreshedLists } from "./runtime.js";
import { buildServer } from "./api.js";
import { getChainId } from "./chain.js";
import { prewarmTargets } from "./service.js";
import { syncDefaultLists } from "./list-sync.js";

async function main(): Promise<void> {
  logger.info(`DeathAndTaxes bot v${VERSION} starting in ${appConfig.mode} mode`);
  logger.info(`Game contract: ${appConfig.gameAddress}`);

  // Refresh the curated lists (rivals, skippers, allies, do-not-target) from master
  // BEFORE anything reads them, so this run already plays on the current intelligence
  // rather than picking it up next restart. The game's roster changes far more often
  // than the code, and a user's data/ folder survives updates, so without this a new
  // list only arrived by re-downloading the bot. Best-effort and time-boxed: on any
  // failure the shipped copy stands (see list-sync.ts).
  const skippersBefore = loadRivalSkippers();
  await syncDefaultLists();
  if (adoptRefreshedLists(skippersBefore)) {
    logger.info("Offense targets re-pointed at the refreshed rival-skippers list.");
  }

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
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("Fatal:", err);
  process.exit(1);
});
