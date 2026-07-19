import { spawnSync } from "node:child_process";

const ZERO_SHA = /^0+$/;
const requestedBase = process.env.DIFF_BASE?.trim();

function gitSucceeds(args) {
  return spawnSync("git", args, { stdio: "ignore" }).status === 0;
}

let args;
if (
  requestedBase
  && /^[0-9a-f]{40}$/i.test(requestedBase)
  && !ZERO_SHA.test(requestedBase)
  && gitSucceeds(["cat-file", "-e", `${requestedBase}^{commit}`])
) {
  // Pull requests and ordinary pushes: inspect every changed line in the range,
  // including whitespace that is already committed in the checkout.
  args = ["diff", "--check", `${requestedBase}...HEAD`];
} else if (gitSucceeds(["rev-parse", "--verify", "HEAD^"])) {
  // New tag/ref or a local invocation without CI metadata.
  args = ["diff", "--check", "HEAD^..HEAD"];
} else {
  // Initial repository commit.
  args = ["show", "--check", "--format=", "HEAD"];
}

const result = spawnSync("git", args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
