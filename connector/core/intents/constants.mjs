// NEAR Intents, used directly (no 1Click for the swap, no solver relay). Every constant here was read from a primary
// source on 2026-11-13; the source is named next to it. docs/INTENTS-DIRECT-SPIKE.md has the whole map.
//   contract source: https://github.com/near/intents at dbad9c8a4659e8bd7f42c152ec79448a8e9d281c
//   SDK:             https://github.com/defuse-protocol/sdk-monorepo at 930d2816081fbb1854fb7eace2c0d82e114703de
//   Omni bridge:     https://github.com/Near-One/omni-bridge at af6d95bb4c6a9e31aba0cd9d6f0fe5f7c8cd2dc9

/** The verifier contract. Mainnet only; there is no testnet (docs.near-intents.org/integration/verifier-contract/introduction.md). */
export const VERIFIER='intents.near';
/** Public NEAR RPC endpoints that answered `query call_function` on 2026-11-13. */
export const NEAR_RPC_URLS=['https://free.rpc.fastnear.com','https://rpc.mainnet.near.org'];
export const SOLANA_RPC_DEFAULT='https://api.mainnet-beta.solana.com';

/** Fee denominator: 1 pip = 1/1,000,000 (crates/primitives/fees/src/lib.rs `Pips::MAX`). */
export const PIPS=1_000_000n;

/** Versioned nonce magic, `VersionedNonce::VERSIONED_MAGIC_PREFIX` (contracts/defuse/core/src/nonce/versioned.rs). */
export const NONCE_MAGIC=Uint8Array.from([0x56,0x28,0xf6,0xc6]);
/** Borsh enum index of `VersionedNonce::V1`. */
export const NONCE_V1=0;

/** NEP-413 tag: 2^31 + 413 (crates/signatures/nep413/src/lib.rs, `OFFCHAIN_PREFIX_TAG == 2147484061`). */
export const NEP413_TAG=2147484061;

// ---- Omni bridge (the route Solana tokens leave by) ----
// The research map said `ft_withdraw` with memo `WITHDRAW_TO:<address>` (PoA bridge). That is out of date for Solana:
// the SDK lists every `sol-*.omft.near` token we trade in POA_TOKENS_MIGRATED_TO_OMNI_BRIDGE
// (packages/intents-sdk/src/constants/poa-tokens-migrated-to-omni-bridge.ts) and its PoA bridge refuses them
// (poa-bridge.ts `supports`). On chain, 2026-11-13: every WIF withdrawal from intents.near is
// `ft_transfer_call` to omni.bridge.near (e.g. tx 7biSAtiJPQcoGb3evR1aouZChogem1YFqBmGyLiTH9Yj), and
// omni.bridge.near `get_bridged_token` maps each token to its Solana mint.
export const OMNI_BRIDGE='omni.bridge.near';
/** SDK omni-bridge-constants.ts MIN_GAS_AMOUNT: 37.4 Tgas for the `ft_transfer_call` into the bridge. */
export const OMNI_MIN_GAS='37400000000000';
/** SDK poa-constants.ts MIN_GAS_AMOUNT: 17.05 Tgas for a PoA `ft_transfer`. */
export const POA_MIN_GAS='17050000000000';
export const OMNI_API='https://mainnet.api.bridge.nearone.org';
export const WNEAR='wrap.near';
export const WNEAR_TOKEN_ID='nep141:wrap.near';

/** Gas attached to `execute_intents` (the protocol's own relayer attaches the same: tx 7biSAti…, gas 300 Tgas). */
export const EXECUTE_GAS=300_000_000_000_000n;

/** USDC on Solana inside the verifier (1Click /v0/tokens, 2026-11-13). */
export const USDC_SOL_TOKEN_ID='nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';

/** Order of the checks in `Engine::execute_signed_intent` (contracts/defuse/core/src/engine/mod.rs). A failure at one
 * stage means every earlier stage passed for that payload, and every payload before it in the list passed entirely. */
export const STAGES=['signature','payload_json','verifying_contract','deadline','public_key','nonce_salt','nonce_deadline','nonce_expiry','nonce_unused','intent_execution','invariant'];
