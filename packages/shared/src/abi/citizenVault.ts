/**
 * Minimal ABI for contracts/CitizenVault.sol — only what the bot actually calls or reads.
 *
 * Deliberately not the full artifact: the owner-only functions (withdrawCitizens, sweep,
 * setOperator) are absent because the bot must never be able to encode them. The hot key
 * that signs every boundary should not be one typo away from a transfer, and leaving those
 * out of the ABI makes that a compile error rather than a code-review question.
 */
export const citizenVaultAbi = [
  {
    inputs: [
      {
        components: [
          { internalType: "bytes", name: "data", type: "bytes" },
          { internalType: "uint256", name: "value", type: "uint256" },
          { internalType: "bool", name: "tolerate", type: "bool" },
        ],
        internalType: "struct CitizenVault.Call[]",
        name: "calls",
        type: "tuple[]",
      },
      { internalType: "uint256", name: "bidWei", type: "uint256" },
    ],
    name: "run",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "index", type: "uint256" },
      { indexed: true, internalType: "bytes4", name: "selector", type: "bytes4" },
      { indexed: false, internalType: "bool", name: "ok", type: "bool" },
    ],
    name: "CallResult",
    type: "event",
  },
  { inputs: [], name: "operator", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "game", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "citizens", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

/**
 * NOTE on `CallResult` — it is the join key for per-action reporting, because a call that
 * reverts inside the batch emits no game event at all, so the game's own logs cannot say
 * which of ten queued actions failed. `CallResult` is emitted either way, and its indexed
 * `index` is the position in the array we submitted, which maps straight onto the activity
 * entries.
 *
 * Its topic0 is deliberately NOT exported as a constant. This package has no dependencies
 * (it is imported by both the backend and the browser bundle), so a topic here could only
 * be a pasted hash — and a pasted hash silently stops matching the moment the event
 * signature changes, which would look like "every action reverted". Decode against this ABI
 * with viem's `parseEventLogs` instead and let the topic be derived.
 */
