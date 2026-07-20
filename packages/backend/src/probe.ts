// Ad-hoc probe: verify the read layer against live mainnet. Run with tsx.
import { getGameSnapshot } from "./contract.js";
import { AUDIT_COST_WEI, WINNERS } from "@dat-bot/shared";
import { formatEther } from "viem";
import { redactSensitiveText } from "./redaction.js";

async function main(): Promise<void> {
  const snap = await getGameSnapshot();
  console.log("state:", snap.state, "(0=configuring,1=live,2=ended)");
  console.log("currentEpoch:", snap.currentEpoch.toString());
  console.log("startTime:", snap.startTime.toString());
  console.log("citizensAddress:", snap.citizensAddress);
  console.log("citizenSupply:", snap.citizenSupply.toString());
  console.log("winners target:", WINNERS.toString());
  console.log("audit cost:", formatEther(AUDIT_COST_WEI), "ETH");
}

void main().catch((error: unknown) => {
  console.error("probe failed:", redactSensitiveText(
    error instanceof Error ? error.message : String(error),
  ));
  process.exitCode = 1;
});
