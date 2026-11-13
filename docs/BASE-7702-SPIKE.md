# Base EIP-7702 spike: batched USDC transfers, our gas wallet sends

The user's EOA signs two things: an EIP-7702 authorization to Uniswap Calibur v1.1.0, and an EIP-712 `SignedBatchedCall` of N USDC transfers that names our gas wallet as executor. Our gas wallet then sends ONE type-4 transaction (`to` = the user's EOA, `data` = `execute(SignedBatchedCall, wrappedSignature)`, `authorizationList` = [the authorization]) and pays the gas. Nothing is deployed, and there is no bundler, paymaster or ETH top-up.

Files:
- `connector/core/pipeline/base/calibur-7702.mjs`: the builders and server checks
- `connector/core/pipeline/base/calibur-7702.test.mjs`: fixed vectors
- `ops/base-7702-spike.mjs`: plan and live runner

Design source: `~/.world/team/director/docs/plans/near-hackathon/EIP7702-OWN-GAS-RESEARCH.md`.

## Calibur encoding, settled from source

Source checked: `github.com/Uniswap/calibur` at tag `v1.1.0` (249cac5). Its `src/` is byte-identical to:
- commit d7dbc80, the deployment commit listed in the README table for Base.
- all 36 `src/` files of Sourcify's verified sources for chain 8453 at `0x000000005c84F8Fd50b21CAC312528A64437030e`. That entry is a full match ("creationMatch":"match","runtimeMatch":"match") for contract `src/CaliburEntry.sol:CaliburEntry`, compiled with solc 0.8.29.

The runtime is 22,020 bytes. The selector `execute((((address,uint256,bytes)[],bool),uint256,bytes32,address,uint256),bytes)` = `0xc3c16ee4` appears in the verified ABI and as a PUSH4 in the deployed runtime.

| Question | Answer | Source |
|---|---|---|
| EIP-712 domain | `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)`, typehash `0xd87cd6ef…6472`. Values: name `"Calibur"`, version `"1.0.0"`, chainId `block.chainid`, verifyingContract `address(this)` = **the user's EOA** | `src/EIP712.sol` (`_domainNameAndVersion`, `domainSeparator`, `eip712Domain`) |
| Salt | `bytes32((uint256(saltPrefix) << 160) \| uint160(implementation))`. `implementation` is the Calibur singleton, set as an immutable (`_cachedImplementation = address(this)` in the constructor). `saltPrefix` is 0 until the EOA calls `updateSalt()`. Fresh account: `0x000000000000000000000000000000005c84f8fd50b21cac312528a64437030e` | `src/libraries/PrefixedSaltLib.sol`, `src/EIP712.sol` |
| Signature wrapping | `wrappedSignature = abi.encode(bytes signature, bytes hookData)`. `hookData` is empty for the root key, and `signature` is the 65-byte ECDSA signature over the typed-data digest. A signature shorter than 64 bytes reverts `InvalidSignatureLength` (0x4be6321b). Bad offsets revert `SliceOutOfBounds` (0x3b99b53d) | `src/libraries/WrappedSignatureLib.sol` (`decodeWithHookData`), `src/libraries/CalldataDecoder.sol` (`safeToBytes`) |
| Types | `SignedBatchedCall(BatchedCall batchedCall,uint256 nonce,bytes32 keyHash,address executor,uint256 deadline)BatchedCall(Call[] calls,bool revertOnFailure)Call(address to,uint256 value,bytes data)`. Hashing is standard EIP-712 (`bytes` hashed, arrays as keccak of concatenated struct hashes), so `eth_signTypedData_v4` produces it | `src/libraries/SignedBatchedCallLib.sol`, `BatchedCallLib.sol`, `CallLib.sol` |
| Root key | `keyHash = 0` is the EOA's own secp256k1 key (`getKey(0)` = `KeyLib.toRootKey()`). It has no hook and no expiry | `src/KeyManagement.sol`, `src/libraries/KeyLib.sol`, `SettingsLib.ROOT_KEY_SETTINGS` |
| Check order in `execute` | (1) `executor == 0 \|\| executor == msg.sender`, else `Unauthorized`. (2) `deadline == 0 \|\| block.timestamp <= deadline`, else `SignatureExpired`. (3) `_useNonce`, else `InvalidNonce`. (4) signature over `hashTypedData(hash(batch))`, else `InvalidSignature`. (5) calls in order, where `revertOnFailure` reverts `CallFailed(bytes)` | `src/Calibur.sol` (`execute`, `_handleVerifySignature`, `_processBatch`) |
| Nonce | `(uint192 key << 64) \| uint64 seq`. The seq for that key must match exactly, then it increments. `getSeq(key)` reads it | `src/NonceManager.sol` |

Every one of these facts is pinned in `calibur-7702.test.mjs`, where the digest is recomputed Solidity-style. The simulation then confirmed them against the deployed bytecode: a signature built this way executes.

## Commands

```
cd connector && node --test core/pipeline/base/calibur-7702.test.mjs
node ops/base-7702-spike.mjs --plan                 # 2 legs x 0.01 USDC, fresh random recipients
node ops/base-7702-spike.mjs --plan --legs 5
node ops/base-7702-spike.mjs --plan --legs 5 --to 0xA..,0xB..   # recipients repeat to fill the legs
```

`--plan` reads no key and sends nothing:
- A throwaway key plays the user.
- The sender is `--gas-wallet`, else `$YEET_BASE_GAS_WALLET`, else a throwaway address.
- The RPC is `--rpc`, else `$BASE_RPC_URL`, else `https://mainnet.base.org`. That endpoint (`reth/v2.5.2 … base/v1.5.4`) supports `eth_simulateV1` with state and block overrides, `authorizationList` in simulated calls and `eth_estimateGas`.
- It exits 0 only when every case passed.

Live, run by the Director only:

```
BASE_7702_CONFIRM=send-spike YEET_LIVE=1 YEET_BASE_GAS_WALLET=<gas wallet address> \
YEET_BASE_GAS_WALLET_KEY_FILE=<key file, default ~/.local/state/yeet/keys/base-gas-wallet.key> \
  node ops/base-7702-spike.mjs --live --wallet <test wallet json> [--legs 2] [--amount 0.01]

BASE_7702_CONFIRM=send-spike YEET_LIVE=1 YEET_BASE_GAS_WALLET=... YEET_BASE_GAS_WALLET_KEY_FILE=... \
  node ops/base-7702-spike.mjs --revoke --live --wallet <test wallet json>
```

Optional: `BASE_RPC_URL` (must support `eth_simulateV1`).

`--live` refuses (and signs nothing) in each of these cases:
- the confirm value is missing
- the rpc.mjs broadcast gate is closed (`YEET_LIVE=1`, kill switch off, `YEET_BASE_PAUSE` off)
- the gas wallet key does not load
- the chain is not 8453
- the user's address equals the gas wallet's
- the user's code is anything other than empty or the Calibur designator
- the user or the gas wallet has a pending transaction
- the user holds less USDC than the batch
- the gas wallet ETH is below `gas × maxFee + L1 upper bound`
- the gas is above `120000 + 45000 × legs`

Before broadcasting it does all of the following:
- re-verifies the authorization (chain, contract, nonce = pending nonce, signer)
- recovers the batch signer
- rebuilds the batch field by field
- simulates the exact call with the real `authorizationList` and requires every leg's Transfer log
- parses the signed bytes back and compares every field

After the receipt it checks:
- each leg's `Transfer(user → to_i, amount_i)` log, never the status alone
- that the code is `0xef0100‖Calibur`
- that `getSeq(key)` advanced

It prints the tx hash, gas used, effective gas price, the L2, L1 and total fee in wei and ETH, and the per-leg log index. Recipients default to the user itself and the gas wallet, alternating. `--revoke` requires the user to carry a designator. It sends one type-4 transaction with an authorization to `address(0)` (`to` = the user, empty data) and requires the code to be `0x` afterwards. No key value is printed.

## What the simulation proved (Base mainnet state, 2026-11-13)

All cases below ran in one `eth_simulateV1` per case on `latest`. The overrides were: the USDC balance via `usdcBalanceOverride`, ETH for the sender and, where stated, the user's code set to `0xef0100‖Calibur`.

| Case | 2 legs | 5 legs (fresh recipients) |
|---|---|---|
| Positive, code override (an already-delegated user) | success, 2/2 Transfer logs, balances −20000 / +10000 / +10000; gas 140,357 | success, 5/5, balances −50000 / 5 × +10000; gas 237,416 |
| Positive, real `authorizationList`, no code override (first trade) | success, 2/2; gas 152,857 | success, 5/5; gas 249,916 |
| `eth_estimateGas` of the exact type-4 call | 165,952 (planned limit +25% = 207,440) | 264,166 (limit 330,208) |

Random recipient bytes shift the calldata gas by a few dozen between runs.
| Stale authorization nonce | **success with 0 transfers** (the silent no-op) | same |
| Wrong executor (a stranger submits the same signed batch) | `Unauthorized` | `Unauthorized` |
| Stranger rewrites `executor` to itself | `InvalidSignature` | `InvalidSignature` |
| Replay of the same nonce (second execute in the same block) | first success, second `InvalidNonce` | same |
| Altered recipient / altered amount, original signature | `InvalidSignature` / `InvalidSignature` | same |
| Same signed batch in a block 1 s after its deadline | `SignatureExpired` | `SignatureExpired` |
| Revoke (authorization to `address(0)`), then the same batch | revoke success (36,800 gas), then 0 transfers | same |

**Fees.**
- Max fee at 2× the current gas price (12 Mwei) is about 0.0000026 ETH for 2 legs and 0.0000041 ETH for 5 legs, L1 upper bound included.
- The signed type-4 transaction is 1,301 bytes for 2 legs and 2,069 bytes for 5.
- With 5 legs to two repeated, already-funded recipients, the estimate is 163,077, because a fresh recipient costs a new balance slot of about 20k gas.

**Gas per leg and per authorization.**
- Each extra leg to a fresh address costs about 32k gas.
- The authorization costs 12,500 net here. The throwaway account exists (balance override), so EIP-7702 refunds 12,500 of the 25,000. A user address with zero ETH and nonce 0 is "empty" and pays the full 25,000.

**Cheap reverts.** They all report 38,730. That is the EIP-7623 calldata floor (21000 + 10 × tokens), not a coincidence of the revert paths.

## What only the live run and a Privy phone test can prove

Live (`--live`, then `--revoke --live`):
- Base's sequencer includes a type-4 transaction from our gas wallet with a third-party authorization.
- The real receipt shows `gasUsed`, `l1Fee` and every leg's Transfer log.
- The code after is `0xef0100‖Calibur`.
- The revoke clears it.
- Inclusion races against the user's nonce on a real wallet.
- Basescan and 1Click see N deposits under one hash.

Privy, on an iPhone inside ChatGPT:
- The card's js-sdk-core `rpc` passes `{method:"eth_sign7702Authorization", params:{contract, chain_id:8453, nonce}}` from a user session. It must return `data.authorization {contract, chain_id, nonce, r, s, y_parity}`; `fromPrivyAuthorization` maps it to the tuple.
- The card passes `{method:"eth_signTypedData_v4", params:{typed_data}}`, where `typed_data` is exactly `privyTypedData(user, batch)`, with `primary_type` and the `EIP712Domain` with `salt`. It must return `data.signature` that recovers to the user.
- Whether any modal appears.
- Whether a Privy policy allowlisting the Calibur contract applies to user-owned wallets.
- The fallback if the first method is refused: `secp256k1_sign` over `authorizationDigest`.

## Server validations a production driver needs

**Authorization:**
- `chainId == 8453`. Never 0: `authorizationRequest` refuses it.
- `address == 0x000000005c84F8Fd50b21CAC312528A64437030e` exactly.
- `nonce ==` the user's `eth_getTransactionCount(pending)`, which must equal `latest`.
- `recoverAuthorizationAddress == user`. These checks are `assertAuthorization`.
- Skip the authorization when the code is already `0xef0100‖Calibur`, and send a type-2 `execute` instead.
- Refuse any other code, such as a foreign delegation or a contract.

**Batch:**
- Rebuild it from our stored legs and compare it field by field (`assertBatchMatches`):
  - N calls, each to USDC with value 0 and `data == transfer(deposit_i, amount_i)`, in order
  - `revertOnFailure == true`
  - `keyHash == 0`
  - `executor ==` our gas wallet, never 0
  - `deadline` is the quote expiry, at most about 10 minutes
  - `nonce == (key(trade_id) << 64) | getSeq(key)`
- Recover the typed-data signer and require it to equal the user, with the domain built from the user address and `saltPrefix` 0.
  - If the account ever called `updateSalt`, read `eip712Domain()` from the EOA and use its salt.

**Transaction:**
- `eth_simulateV1` or `eth_call` the exact call with its real `authorizationList`, and require every leg's Transfer log before signing.
- Cap the gas per leg count and the fees with `YEET_BASE_MAX_FEE_WEI`.
- Parse the signed bytes back and compare them (`assertType4Bytes`).
- Serialize per user so that no other user transaction lands between signing and inclusion.
- Re-check the user nonce right before broadcast.

**After inclusion:**
- A leg landed only if its own USDC `Transfer(user → deposit_i, amount_i)` log is in the receipt (`legEvidence`). Never judge by status: a stale authorization gives a successful transaction that moves nothing.
- Check that the code is the Calibur designator and that `getSeq(key)` advanced.
- Account the gas wallet's cost as `gasUsed × effectiveGasPrice + l1Fee`.
