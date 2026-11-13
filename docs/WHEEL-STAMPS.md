# Wheel stamps: data contract

Server side: `connector/core/xp/spin.mjs` (wheel, coin draw), `connector/core/xp/stamps.mjs` (stamp store),
`connector/core/xp/ledger.mjs` (`set_completed` rule). Text the model reads: `spinText` in
`connector/mcp/tool-registration.mjs`.

## Rules

- Every wheel slice is one tradable catalog coin: the server's Solana catalog without USDC, in catalog order
  (SOL, WIF, BOME, TRUMP, PENGU, MELANIA, SPX, TURBO, LOUD, NEARKAT today).
- One spin per account per UTC day, as before. The XP rules are unchanged: `xp_won = base_xp + draw_xp + streak_xp`.
- The coin is a second keyed draw, HMAC(secret, `account|day|coin`), stored with the stamp. A repeat the same day
  returns the same coin, wheel and stamp, even after a catalog change.
- Each spin adds exactly 1 stamp of the landing coin, in the same database transaction as the XP row.
- A card has 7 slots. The stamp that fills a card completes a set: it is recorded once and pays `SET_COMPLETE_XP`
  (30 XP) once. The count keeps going: `card = floor(count/7)+1`, `progress = count % 7`.
- Nothing else is attached to stamps or sets. Do not describe any other outcome in the card.

## Streak milestones and extra spins

- Streak milestones fall on the 3rd and the 7th day of every 7-day block: days 3, 7, 10, 14, 17, 21, 24, 28, ...
  The milestone XP rule is unchanged (`streak_bonus_xp` 25 plus its own draw, inside the daily spin's `xp_won`).
- The daily spin that reaches a milestone also grants **one extra spin for that day**, in the same transaction.
- Spins available on a day = 1 daily spin (until used) + unused extra-spin grants for that day. A grant is good only
  on the UTC day it names: unused extra spins do not carry over.
- Each extra spin is a full spin: its own wheel, coin and draw (keyed on the grant id), XP = `base_xp + draw_xp`
  (`streak_xp` is 0), and 1 stamp. It is consumed in the same transaction as its XP row and stamp.
- Order: the daily spin first, then extra spins oldest first. When nothing is left, `daily_spin` returns the day's
  latest spin again and adds nothing.
- Grants live in `xp_spin_grant`, unique per (account, reason, unique_ref), so one cause can never grant twice.
  Reasons: `streak_milestone` (unique_ref = the day) and `trade_bonus` (reserved, no caller yet).
- Internal API for a future caller: `xpRuntime().grantSpin(account, day, reason, uniqueRef)` returns
  `{id, granted}` (`granted: false` when that cause already granted). Nothing in trade code calls it today.

## daily_spin result

```json
{
  "xp_won": 59,
  "draw_xp": 24,
  "streak_xp": 30,
  "total": 164,
  "streak_days": 3,
  "next_spin_at": "2026-11-14T00:00:00.000Z",
  "wheel": [
    {"coin": "SOL", "xp": 7}, {"coin": "WIF", "xp": 24}, {"coin": "BOME", "xp": 0}, {"coin": "TRUMP", "xp": 40},
    {"coin": "PENGU", "xp": 2}, {"coin": "MELANIA", "xp": 12}, {"coin": "SPX", "xp": 31}, {"coin": "TURBO", "xp": 5},
    {"coin": "LOUD", "xp": 15}, {"coin": "NEARKAT", "xp": 9}
  ],
  "slice": 1,
  "stamp": {"coin": "WIF", "count_after": 3, "slots": 7, "card": 1, "filled": 3, "set_completed": false},
  "set_bonus_xp": 0,
  "stamps": [
    {"coin": "SOL", "count": 0, "slots": 7, "card": 1, "progress": 0, "complete": false},
    {"coin": "WIF", "count": 3, "slots": 7, "card": 1, "progress": 3, "complete": false},
    {"coin": "BOME", "count": 1, "slots": 7, "card": 1, "progress": 1, "complete": false}
  ],
  "sets_completed": 0,
  "spin_kind": "daily",
  "spin_reason": null,
  "spins_available": 1,
  "extra_spin_reason": "streak_milestone"
}
```

(`stamps` is cut short above; the server always lists every catalog coin. The example is the daily spin on streak
day 3: `streak_xp` 30 = 25 + its draw of 5, and the milestone left one extra spin.)

| Field | Meaning |
|---|---|
| `wheel` | One slice per coin, catalog order. `xp` is the bonus value shown on that slice. Every slice shows a different value. A coin that left the catalog but was won that day is added at the end. |
| `slice` | Index into `wheel` where the spin lands. `wheel[slice].coin == stamp.coin` and `wheel[slice].xp == draw_xp`. |
| `stamp.count_after` | This coin's total stamps after this spin (all cards). |
| `stamp.card` | The card this stamp landed on (1-based): `ceil(count_after/7)`. |
| `stamp.filled` | Slots filled on that card after this spin, 1 to 7. Use it for the "3 of 7" label. |
| `stamp.set_completed` | True when this stamp filled the card (`filled == 7`). |
| `set_bonus_xp` | XP this spin's stamp paid by completing a set, 0 otherwise. Not part of `xp_won`; included in `total`. |
| `stamps[]` | Every catalog coin in catalog order (zero counts included), then any coin no longer in the catalog that still has stamps. |
| `stamps[].card`, `.progress` | The card being filled now: `floor(count/7)+1`, and its filled slots `count % 7` (0 right after a set completes: the next card is empty). |
| `stamps[].complete` | True once this coin has completed at least one set (`count >= 7`). |
| `sets_completed` | Total completed sets for the account, all coins. |
| `spin_kind` | `daily` or `extra`: which spin this result is. |
| `spin_reason` | For an extra spin, why it was granted (`streak_milestone`, `trade_bonus`); null for the daily spin. |
| `spins_available` | Spins left today after this one (0 means come back at `next_spin_at`). |
| `extra_spin_reason` | Why the next available extra spin was granted, or null when none is left. |

When no spins are left, a repeat returns the day's latest spin (the `stamps` list and `total` reflect the current
state). With a spin left, calling `daily_spin` again uses it: the card should only call it on a deliberate spin.

## yeet_home xp block

`xp` gains the same two fields, so the home card can show the stamp cards before today's spin:

```json
{
  "total": 164, "streak_days": 2, "spin_available": true, "next_streak_milestone": {"days": 3, "xp": 25},
  "spins_available": 1, "extra_spin_reason": null,
  "stamps": [{"coin": "SOL", "count": 0, "slots": 7, "card": 1, "progress": 0, "complete": false}],
  "sets_completed": 0
}
```

## Text the model reads (daily_spin content)

One sentence, no other text:

- `You won 29 XP and a WIF stamp (3 of 7).`
- `You won 10 XP and a BOME stamp (7 of 7), completing a BOME set for 30 bonus XP.`
- `You won 30 XP and a WIF stamp (1 of 7), and you have 1 more spin today.`

## Contract status

The pinned contract (`connector/vendor/yeet-win/contracts/yeet-tools.json`) has closed output schemas. Until
yeet-win lists the new fields, the connector cuts `daily_spin` to its listed fields and `yeet_home.xp` to its listed
keys, so the cards keep working and the new fields stay hidden. They appear without a server change once the contract
lists them and is vendored again.
