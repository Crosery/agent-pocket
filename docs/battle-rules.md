# Battle rules reference

Implementation: `src/shared/battle/` (engine, formulas, ai, messages, rules) and `src/shared/creature.ts`.
Every number lives in content: `content/config.json` (`battle`, `catch`, `growth`, `creature`, `party`) and
`content/battle_rules.json` (formula structure, AI tuning). Every message is `t('battle.<key>')` from
`content/text/zh-CN/battle.json`. Statuses, volatiles, weathers and abilities are interpreted generically from their
definitions — adding one is a JSON-only change.

## Creatures

| | formula | keys |
|---|---|---|
| hp | `floor((baseMul·B + IV)·L / levelDivisor) + L + hpFlat` | `battle_rules.statFormula` |
| other stats | `floor((baseMul·B + IV)·L / levelDivisor) + otherFlat` | same |
| exp to reach L | `floor(growth[g].mul · L^growthExponent)` | `config.growth`, `battle_rules.growthExponent` |
| new creature | last `party.maxMoves` distinct learnset moves ≤ L; IV `0..creature.ivMax`; `abilities[1]` with `creature.secondAbilityChance`; shiny `battle.shinyRate` | |
| level up | keeps damage taken, `+creature.levelUpFriendship` (cap `battle_rules.creature.friendshipMax`); learns the level's move if a slot is free, else reports it learnable | |
| evolve | keeps hp ratio and ability slot; learns new-species learnset entries at level 0 or the current level while slots are free | |
| sanitize | strict clamp/repair of every field; moves must be legal (own or pre-evolution learnset ≤ L, teachables); text stripped of control chars and length-capped | `battle_rules.creature`, `net.nameMaxLen` |

## Turn order

1. Forfeit ends the battle immediately.
2. Action kinds resolve in `battle_rules.actionOrder` (default switch → item → run → move).
3. Moves: higher priority first (`MoveDef.priority` + ability `priority` effects whose condition holds), then holders of
   `moveLast` after others, then higher effective speed, ties by coin flip.
   Effective speed = `spe · stage · StatusDef.speedMul · ability statMul(spe)`.

Stage multiplier: `(b+s)/b` for `s ≥ 0`, `b/(b−s)` otherwise; `b = stageBase.stat` for stats, `stageBase.accEva` for
accuracy/evasion. Stages are clamped to `±battle.statStageLimit`.

## Damage (gen 5)

```
base = floor(floor(floor(levelMul·L/levelDivisor + levelAdd) · P · A / D) / divisor) + add
dmg  = max(minDamage, floor(base · random · weather · crit · STAB · type · physicalMul · damageTakenMul))
```

- `P` = move power × attacker ability `powerMul` (conditions evaluated on the attacker).
- `random` ∈ `[battle.randomMin, battle.randomMax]`; weather = `WeatherDef.powerMul[moveType]`.
- STAB `battle.stab` (ability `stab` overrides); type = `typeEffectiveness` (0 ⇒ no damage, "noEffect").
- Crit chance `battle.critChanceByStage[stage]`, stage = `highCritStages` (move `highCrit`) + ability `critStage` +
  volatile `critStageAdd`. Crit multiplier `battle.critMultiplier` (ability `critMul` overrides); crits ignore the
  attacker's negative attack stages and the defender's positive defense stages.
- `physicalMul` = attacker's `StatusDef.physicalMul` on physical moves; `damageTakenMul` = defender abilities.
- `ignoreFoeBoosts` ignores the defender's positive defense and evasion stages.
- Struggle (no usable move): typeless, power `battle.struggle.power`, recoil `battle.struggle.recoilFraction` of max hp.
- Confusion-like self hit: typeless physical, power `battle.confusionSelfHitPower`, stats and random only.
- Accuracy: `accuracy · stage(acc − eva) · accuracyMul · statMul(acc)/statMul(eva)`; accuracy 0 or `alwaysHit` never misses;
  `ignoreEvasion` ignores positive evasion.

## Chance conventions

`MoveEffect.chance` and ability `chance` fields are **percentages** (1..100). Fields named `*Chance`
(`skipChance`, `cureChancePerTurn`, `selfHitChance`, `cureStatusChance`, `secondAbilityChance`) are **fractions** (0..1).

## Statuses (`StatusDef`)

Before acting: `cureChancePerTurn` roll → cured; timed statuses (`durationMin/Max`, rolled on infliction) count down
per action attempt and cure at 0; then `skipChance` roll loses the turn. End of turn: `dotFraction` of max hp.
`speedMul`, `physicalMul` modify speed/damage, `catchBonus` multiplies catch odds. Immunity: `types.statusImmunities`
and ability `immune.statuses`. Fainting clears status.

## Volatiles (`VolatileDef`)

Cleared on switch-out/faint. Timed ones (`durationMin/Max`) tick down at end of turn; others last until switch-out.
`flinch` (skips the move if applied before the holder acts) and `protects` are turn-scoped.
`selfHitChance` → self hit; `protects` blocks foe-targeting moves (repeat success `battle.protectChainDecay^chain`);
`drainFraction` → end-of-turn hp transfer to the foe; `critStageAdd`; `blocksStatusMoves`. Immunity: ability `immune.volatiles`.

## Weather (`WeatherDef`)

Field weather from `BattleInit.weather` lasts all battle; move-set weather lasts `battle.weatherTurns`. End of turn:
`continueText` (or `endText` when it expires), chip `chip.fraction` to non-exempt types, heal `heal.fraction` to listed
types. Texts substitute `{weather}` with `nameZh`.

## Abilities (`AbilityEffect`)

Conditions (`AbilityCondition`) are evaluated on the holder: `hpBelow`, `hpFull`, `weather`, and for the move involved
`moveTypes`, `moveNotOwnType`, `moveCategory` (`damaging` = non-status), `superEffective`.
An `{t:'ability'}` event plus `battle.abilityActivated` is emitted when an effect visibly acts (switch-in/out, turn-end,
immunity on a status move, afterHitBy, dealDamage procs, knockOut, absorbType, alwaysEscape, blockFoeStatusMoves,
noStatDrops, ignoreProtect, and situational powerMul/damageTakenMul — those with hp/superEffective/weather conditions).

## Items in battle

Player items are validated per target (the client owns bag counts); AI trainers spend their own copy of
`BattleSideInit.items`. `heal`, `cure`, `healCure`, `revive` (bench), `pp` (`all` or the most-depleted move),
`battleBoost`, `escape` (wild only), `ball` (wild + `canCatch`).

## Catching (gen 3)

`a = floor(((hpMaxMul·M − hpCurMul·H) · catchRate · ball) / (hpMaxMul·M)) · StatusDef.catchBonus`; caught when
`a ≥ catchFormula.rateMax`, else `catch.shakeChecks` checks each passing with `(a/rateMax)^(1/checks)`.
Ball multiplier = `catchMultiplier`, or `catch.ballBonus[bonus]` when its condition holds: `night` (time of day night),
`quick` (turn 1), `status`, `lowLevel` (level ≤ `lowLevelMax`), `rare` (rarity order ≥ `rareMinRarityOrder`);
`master` always catches.

## Running

Wild battles only. Ability `alwaysEscape` or an `escape` item always succeeds; otherwise succeeds when at least as fast,
else `int(0, runRollMax−1) < floor(mine·battle.runBase/theirs) + battle.runAttemptBonus·attempts`.

## Fainting, switching, ending

AI sides replace fainted creatures at end of turn; human sides get `{kind:'switch', forced:true}`.
The battle ends when a side has no usable creature (`win`/`lose`, both ⇒ `draw`), on catch, run or forfeit.
Trainer wins emit `money` (`BattleInit.rewardMoney`).

## Experience

When a foe faints (and `BattleInit.expGain`): `yield = floor(baseExp·L/battle.expDivisor · (trainer ? battle.trainerExpMultiplier : 1))`,
split equally among living side-0 creatures that faced it. Emits `exp`, `levelUp`, `learnMove`/`moveLearnable`;
`evolveReady` at the end for creatures that levelled this battle (not on lose/forfeit/draw).
`levelCap` makes creatures fight at `min(level, cap)`; hp is rescaled to the capped max and restored at the end.

## AI (`battle_rules.ai`)

Level: `BattleSideInit.aiLevel`, else wild by `wildLevelByRarityOrder[rarity.order]`, else `defaultLevel`.
`featureLevel` decides which behaviours each level unlocks: scored moves (power × effectiveness × STAB × weather ×
accuracy), status-move evaluation, heal/cure items below `healItemBelowHpRatio`, defensive switching against
`switchThreatEffectiveness`, damage estimation with KO bonus, replacement ordering. All scores/thresholds are keys of `ai`.

## Determinism & perspective

All randomness comes from `new Rng(init.seed)` (sfc32). Events use absolute sides (side 0 = local player).
`perspective(events, 1)` flips sides and results, drops side-0 progression events, and swaps in side-1 wording for
viewer-relative messages (kept off the event object; pass the original event objects, not JSON copies).
