#!/usr/bin/env python3
"""Build content/species.json and docs/roster.md from the researched roster.

Pure transform: docs/research/roster-final.json + docs/research/designs.json + content tables
+ tools/data/species_rules.json -> SpeciesDef[] (src/shared/types.ts). Every selection rule, weight and
threshold lives in species_rules.json; this file holds only the algorithms. Deterministic (no RNG).

Usage: python3 tools/data/build_species.py [--no-doc] [--check]
Output is laid out by tools/content_fmt.py; --check exits 1 if species.json / roster.md are stale.
"""

import hashlib
import json
import math
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
RULES = json.loads((pathlib.Path(__file__).with_name("species_rules.json")).read_text())
SRC = {k: json.loads((ROOT / v).read_text()) for k, v in RULES["sources"].items()}

STAT_KEYS = RULES["statKeys"]
LR = RULES["learnset"]
MOVES = SRC["moves"]
MOVE_BY_ID = {m["id"]: m for m in MOVES}
MOVE_INDEX = {m["id"]: i for i, m in enumerate(MOVES)}
ABILITY_IDS = {a["id"] for a in SRC["abilities"]}
RARITY = {r["id"]: r for r in SRC["rarities"]}
TYPE_IDS = [t["id"] for t in SRC["types"]["types"]]
TYPE_NAME = {t["id"]: t["nameZh"] for t in SRC["types"]["types"]}
CHART = SRC["types"]["chart"]
BIOME_IDS = {b["id"] for b in SRC["biomes"]}
GROWTH_IDS = set(SRC["config"]["growth"])
CHIPS = [
    (it["id"], it["effect"]["move"])
    for it in SRC["items"]
    if it["effect"].get("kind") == "chip"
]
DESIGN = {d["id"]: d for d in SRC["designs"]}

NOTES = []


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def jitter(key, j):
    if j <= 0:
        return 0
    return int(hashlib.md5(key.encode()).hexdigest(), 16) % (2 * j + 1) - j


def bst(s):
    return sum(s["baseStats"][k] for k in STAT_KEYS)


def share(s, k):
    return s["baseStats"][k] / bst(s)


def top_stats(s):
    hi = max(s["baseStats"][k] for k in STAT_KEYS)
    return {k for k in STAT_KEYS if s["baseStats"][k] == hi}


def kw_text(s):
    return " ".join(str(s.get(f, "")).lower() for f in RULES["keywordFields"])


def attack_pref(s):
    a, p, m = (
        s["baseStats"]["atk"],
        s["baseStats"]["spa"],
        RULES["attackPreference"]["margin"],
    )
    if a >= p * (1 + m):
        return "physical"
    if p >= a * (1 + m):
        return "special"
    return "mixed"


def band_pos(s):
    lo, hi = RARITY[s["rarity"]]["bst"]
    return clamp((bst(s) - lo) / (hi - lo), 0, 1) if hi > lo else 0.5


# ---------------------------------------------------------------------------
# move analysis (derived from move effects; nothing hand-tabled)
# ---------------------------------------------------------------------------


def kinds(m):
    return {e["kind"] for e in m["effects"]}


def damaging(m):
    return m["category"] != "status"


def eff_power(m):
    for e in m["effects"]:
        if e["kind"] == "fixedDamage":
            fp = LR["fixedDamagePower"]
            return (
                fp["level"]
                if e["amount"] == "level"
                else e["amount"] * fp["perFixedPoint"]
            )
    return m["power"]


def self_debuff(m):
    return any(
        e["kind"] == "stat" and e["target"] == "self" and sum(e["stats"].values()) < 0
        for e in m["effects"]
    )


def status_class(m):
    ks = kinds(m)
    vols = {e.get("volatile") for e in m["effects"] if e["kind"] == "volatile"}
    if "weather" in ks:
        return "weather"
    if "protect" in vols:
        return "protect"
    if "heal" in ks:
        return "heal"
    if "focus" in vols:
        return "focus"
    if any(
        e["kind"] in ("status", "volatile") and e["target"] == "enemy"
        for e in m["effects"]
    ):
        return "inflict"
    stat = [e for e in m["effects"] if e["kind"] == "stat"]
    if any(e["target"] == "enemy" and sum(e["stats"].values()) < 0 for e in stat):
        return "debuff"
    if any(e["target"] == "self" and sum(e["stats"].values()) > 0 for e in stat):
        return "buff"
    return "other"


def boosts(m):
    out = set()
    for e in m["effects"]:
        if e["kind"] == "stat" and e["target"] == "self":
            out |= {k for k, v in e["stats"].items() if v > 0}
    return out


EXCLUDED = {m["id"] for m in MOVES if kinds(m) & set(LR["excludeEffects"])}


# ---------------------------------------------------------------------------
# per-species context
# ---------------------------------------------------------------------------


def signature_set(s):
    sig = set(LR["signatureByCategory"].get(s["category"], []))
    for t in s["types"]:
        sig |= set(LR["signatureByType"].get(t, []))
    text = kw_text(s)
    for rule in LR["signatureByKeyword"]:
        if re.search(rule["match"], text):
            sig |= set(rule["moves"])
    unknown = sig - set(MOVE_BY_ID)
    if unknown:
        raise SystemExit(f"species_rules: unknown signature moves {sorted(unknown)}")
    return sig


def coverage_types(s):
    base = LR["coverageByFamily"].get(s["family"]) or LR["coverageByCategory"].get(
        s["category"], []
    )
    cov = [t for t in base if t not in s["types"]]
    if not cov:
        cov = [t for t in LR["universalTypes"] if t not in s["types"]]
    return cov[: LR["coverageCount"][s["rarity"]]] or cov[:1]


def power_bias(s):
    pb = LR["powerBias"]
    return clamp(pb["stage"][str(s["stage"])] + pb["rarity"][s["rarity"]], 0, 1)


class Ctx:
    def __init__(self, s):
        self.s = s
        self.types = s["types"]
        self.pref = attack_pref(s)
        self.sig = signature_set(s)
        self.cov = coverage_types(s)
        self.bias = power_bias(s)
        self.fast = share(s, "spe") >= LR["weights"]["fastStatShare"]
        self.tops = top_stats(s)


def score_damaging(ctx, m, band, target, role, primary):
    w, pen = LR["weights"], LR["penalties"]
    exempt = set(LR["rolePenaltyExempt"].get(role, []))
    lo, hi = band
    p = eff_power(m)
    sc = w["power"] * (1 - min(1, abs(p - target) / max(1, hi - lo)))
    if ctx.pref == "mixed" or m["category"] == ctx.pref:
        sc += w["categoryMatch"] * (0.5 if ctx.pref == "mixed" else 1)
    if m["id"] in ctx.sig:
        sc += w["signature"]
    if m["type"] == primary:
        sc += w["primaryType"]
    ks = kinds(m)
    for k in ("recharge", "recoil", "multiHit", "fixedDamage"):
        if k in ks and k not in exempt:
            sc -= pen[k]
    if self_debuff(m) and "selfDebuff" not in exempt:
        sc -= pen["selfDebuff"]
    if 0 < m["accuracy"] < pen["lowAccuracyBelow"] and "lowAccuracy" not in exempt:
        sc -= pen["lowAccuracy"]
    if m["priority"] > 0:
        sc += w["fastPriorityBonus"] if ctx.fast else -pen["priority"]
    return sc


def pick_damaging(ctx, types, band, role, used, bias=None, sig_only=False):
    lo, hi = band
    target = lo + (hi - lo) * (ctx.bias if bias is None else bias)
    bw = LR["bandWiden"]
    for step in range(bw["maxSteps"] + 1):
        d = step * bw["step"]
        cands = [
            m
            for m in MOVES
            if damaging(m)
            and m["type"] in types
            and m["id"] not in used
            and m["id"] not in EXCLUDED
            and lo - d <= eff_power(m) <= hi + d
            and (not sig_only or m["id"] in ctx.sig)
        ]
        if cands:
            return max(
                cands,
                key=lambda m: (
                    score_damaging(ctx, m, band, target, role, ctx.types[0]),
                    -MOVE_INDEX[m["id"]],
                ),
            )["id"]
    return None


def pick_status(ctx, classes, used):
    ss = LR["statusScore"]
    universal = [t for t in LR["universalTypes"] if t not in ctx.types]
    allowed = list(ctx.types) + universal
    best = None
    for m in MOVES:
        if (
            damaging(m)
            or m["id"] in used
            or m["id"] in EXCLUDED
            or m["type"] not in allowed
        ):
            continue
        cls = status_class(m)
        if cls not in classes:
            continue
        sc = ss["classRank"] * (len(classes) - classes.index(cls)) / len(classes)
        sc += (
            ss["ownPrimary"]
            if m["type"] == ctx.types[0]
            else ss["ownSecondary"]
            if m["type"] in ctx.types
            else ss["universal"]
        )
        b = boosts(m)
        want = {"physical": {"atk"}, "special": {"spa"}, "mixed": {"atk", "spa"}}[
            ctx.pref
        ]
        if b & want:
            sc += ss["attackStatFit"]
        if "spe" in b and ctx.fast:
            sc += ss["speedFit"]
        if b & {"def", "spd"} and ctx.tops & {"hp", "def", "spd"}:
            sc += ss["defenseFit"]
        if m["id"] in ctx.sig:
            sc += ss["signature"]
        key = (sc, -MOVE_INDEX[m["id"]])
        if best is None or key > best[0]:
            best = (key, m["id"])
    return best[1] if best else None


def slot_types(ctx, slot):
    role, t = slot["role"], ctx.types
    if role == "stab":
        return [[t[0]]]
    if role == "stab2":
        return [[t[1]] if len(t) > 1 else [t[0]]]
    if role == "coverage":
        i = slot.get("coverageIndex", 0)
        order = (
            ctx.cov[i % len(ctx.cov) :] + ctx.cov[: i % len(ctx.cov)] if ctx.cov else []
        )
        return [[c] for c in order] + [list(t)]
    if role == "finisher":
        return [list(t)]
    return [list(t)]


def fill_slot(ctx, slot, used):
    role = slot["role"]
    if role == "status":
        return pick_status(ctx, slot["classes"], used)
    if role == "sig":
        mv = pick_damaging(ctx, TYPE_IDS, slot["band"], role, used, sig_only=True)
        if mv:
            return mv
        return pick_damaging(ctx, list(ctx.types), slot["band"], role, used)
    for types in slot_types(ctx, slot):
        mv = pick_damaging(ctx, types, slot["band"], role, used)
        if mv:
            return mv
    return None


def template_levels(sid):
    j = LR["levelJitter"]
    return [
        max(LR["minSlotLevel"], sl["level"] + jitter(f"{sid}:{i}", j))
        for i, sl in enumerate(LR["slots"])
    ]


def base_learnset(ctx):
    s = ctx.s
    used = set()
    out = []
    l1 = LR["level1"]
    own = list(ctx.types)
    groups = {
        "own": own,
        "universal": [t for t in LR["universalTypes"] if t not in own],
    }
    dmg = l1["damaging"]
    mv = None
    for g in dmg["types"]:
        mv = pick_damaging(ctx, groups[g], dmg["band"], "l1", used, bias=dmg["target"])
        if mv:
            break
    out.append({"level": 1, "move": mv, "role": "stab"})
    used.add(mv)
    mv = pick_status(ctx, l1["status"]["classes"], used)
    out.append({"level": 1, "move": mv, "role": "status"})
    used.add(mv)
    for sl, lv in zip(LR["slots"], template_levels(s["id"])):
        mv = fill_slot(ctx, sl, used)
        if mv:
            out.append({"level": lv, "move": mv, "role": sl["role"]})
            used.add(mv)
    return out


def evolved_learnset(ctx, pre, pre_ls, evo_level):
    s = ctx.s
    inherited = []
    for e in pre_ls:
        if e["level"] < evo_level:
            inherited.append({**e, "level": max(1, e["level"]), "inherited": True})
    used = {e["move"] for e in inherited}
    out = list(inherited)
    em = LR["evolutionMove"]
    band = [b for lv, b in em["bands"] if lv <= evo_level][-1]
    new_types = [t for t in s["types"] if t not in pre["types"]] or [s["types"][0]]
    mv = pick_damaging(ctx, new_types, band, "stab", used) or pick_damaging(
        ctx, list(s["types"]), band, "stab", used
    )
    if mv:
        out.append({"level": em["level"], "move": mv, "role": "evo"})
        used.add(mv)
    for sl, lv in zip(LR["slots"], template_levels(s["id"])):
        if lv < evo_level:
            continue
        mv = fill_slot(ctx, sl, used)
        if mv:
            gap = LR["inheritReplaceGap"]
            out = [
                e
                for e in out
                if not (
                    e.get("inherited")
                    and e["level"] > 1
                    and e["role"] == sl["role"]
                    and e["level"] >= lv - gap
                )
            ]
            out.append({"level": lv, "move": mv, "role": sl["role"]})
            used.add(mv)
    drop_order = LR["inheritDropOrder"]
    while len(out) > LR["maxEntries"]:
        cands = [e for e in out if e.get("inherited") and e["level"] > 1]
        if not cands:
            break
        victim = min(
            cands,
            key=lambda e: (
                drop_order.index(e["role"])
                if e["role"] in drop_order
                else len(drop_order),
                e["level"],
            ),
        )
        out.remove(victim)
    return out


def finalize_learnset(entries):
    order = sorted(range(len(entries)), key=lambda i: (entries[i]["level"], i))
    return [{"level": entries[i]["level"], "move": entries[i]["move"]} for i in order]


# ---------------------------------------------------------------------------
# abilities / teachables / numbers
# ---------------------------------------------------------------------------


def cond_holds(s, c):
    if "rarity" in c and s["rarity"] not in c["rarity"]:
        return False
    if "category" in c and s["category"] not in c["category"]:
        return False
    if "types" in c and not set(c["types"]) & set(s["types"]):
        return False
    if "stage" in c and s["stage"] not in c["stage"]:
        return False
    if "topStat" in c and not set(c["topStat"]) & top_stats(s):
        return False
    if any(share(s, k) < v for k, v in c.get("statShareMin", {}).items()):
        return False
    if any(share(s, k) > v for k, v in c.get("statShareMax", {}).items()):
        return False
    for key, val in (
        ("capabilityScore", s.get("capabilityScore", 0)),
        ("hotnessScore", s.get("hotnessScore", 0)),
        ("bst", bst(s)),
    ):
        short = key.replace("Score", "")
        if f"{short}Min" in c and val < c[f"{short}Min"]:
            return False
        if f"{short}Max" in c and val > c[f"{short}Max"]:
            return False
    if "idMatch" in c and not re.search(c["idMatch"], s["id"]):
        return False
    return "keywords" not in c or bool(re.search(c["keywords"], kw_text(s)))


def pick_abilities(s):
    ar = RULES["abilities"]
    score, first = {}, {}
    for i, r in enumerate(ar["rules"]):
        if r["ability"] not in ABILITY_IDS:
            raise SystemExit(f"species_rules: unknown ability {r['ability']}")
        if cond_holds(s, r["if"]):
            score[r["ability"]] = score.get(r["ability"], 0) + r["score"]
            first.setdefault(r["ability"], i)
    ranked = sorted(score, key=lambda a: (-score[a], first[a]))
    out = ranked[:1]
    for a in ranked[1:]:
        if len(out) >= ar["max"]:
            break
        if score[a] >= ar["secondMinScore"]:
            out.append(a)
    if not out:
        out = [ar["fallbackByType"][s["types"][0]]]
    return out


def pick_teachable(ctx, learnset):
    tr = RULES["teachable"]
    sc_ = tr["scores"]
    s = ctx.s
    compat = tr["compatByCategory"].get(s["category"], [])
    learned = {e["move"] for e in learnset} if tr["excludeLearnset"] else set()
    scored = []
    for idx, (_iid, mid) in enumerate(CHIPS):
        m = MOVE_BY_ID[mid]
        if mid in learned:
            continue
        if m["type"] == s["types"][0]:
            sc = sc_["ownPrimary"]
        elif m["type"] in s["types"]:
            sc = sc_["ownSecondary"]
        elif m["type"] in compat:
            sc = sc_["compat"]
        elif tr["includeCoverageTypes"] and m["type"] in ctx.cov:
            sc = sc_["coverageOnly"]
        else:
            continue
        if damaging(m) and (ctx.pref == "mixed" or m["category"] == ctx.pref):
            sc += sc_["categoryMatch"]
        if not damaging(m):
            sc += sc_["status"]
        if m["type"] in ctx.cov:
            sc += sc_["coverage"]
        scored.append((-sc, idx, mid))
    scored.sort()
    n = tr["maxByRarity"][s["rarity"]]
    out = [mid for _, _, mid in scored[:n]]
    if len(out) < tr["min"]:
        raise SystemExit(
            f"{s['id']}: only {len(out)} teachable chips (min {tr['min']})"
        )
    return out


def catch_rate(s):
    cr = RULES["catchRate"]
    lo, hi = RARITY[s["rarity"]]["catchRate"]
    t = clamp(
        cr["stageT"][str(s["stage"])] * cr["stageWeight"]
        + band_pos(s) * cr["bstWeight"],
        0,
        1,
    )
    return round(hi - t * (hi - lo))


def base_exp(s):
    be = RULES["baseExp"]
    f = max(be["perBstByStage"][str(s["stage"])], be["minPerBstByRarity"][s["rarity"]])
    return round(bst(s) * f)


def growth_for(s, family_members):
    g = RULES["growth"]
    if g["basis"] == "familyMaxRarity":
        ref = max(family_members, key=lambda x: (RARITY[x["rarity"]]["order"], bst(x)))
    else:
        ref = s
    v = g["byRarity"][ref["rarity"]]
    if isinstance(v, list):
        v = v[0] if band_pos(ref) < g["split"] else v[1]
    return v


def size_for(s):
    z = RULES["size"]
    v = (
        z["categoryBase"][s["category"]]
        + z["stageAdd"][str(s["stage"])]
        + z["rarityAdd"][s["rarity"]]
    )
    return round(clamp(v, z["min"], z["max"]), z["round"])


def scale_to(stats, target):
    total = sum(stats[k] for k in STAT_KEYS)
    f = target / total
    out = {k: max(1, round(stats[k] * f)) for k in STAT_KEYS}
    drift = target - sum(out.values())
    big = max(STAT_KEYS, key=lambda k: out[k])
    out[big] += drift
    return out


def fit_bst(s):
    """Rarity band fit: researched stats outside [floor, hi] are scaled proportionally to the nearest edge.
    The floor sits `bandFloor` of the way up the band so no species is a weak outlier of its rarity."""
    lo, hi = RARITY[s["rarity"]]["bst"]
    lo = lo + RULES["statShape"]["bandFloor"] * (hi - lo)
    total = bst(s)
    if lo <= total <= hi:
        return dict(s["baseStats"])
    target = round(clamp(total, lo, hi))
    NOTES.append(
        f"{s['id']}: BST {total} outside {s['rarity']} [{round(lo)},{hi}] -> scaled to {target}"
    )
    return scale_to(s["baseStats"], target)


def enforce_evolution(fitted, roster):
    """Evolution step rule (statShape.evolutionStep): an evolved form is `min`..`max` times its pre-evolution's BST.
    The side that can move inside its rarity band does; links no band combination can satisfy are left as researched."""
    ss = RULES["statShape"]
    es = ss["evolutionStep"]
    by_id = {s["id"]: s for s in roster}
    links = [(s["id"], s["evolvesTo"]) for s in roster if s.get("evolvesTo")]

    def edges(sid):
        lo, hi = RARITY[by_id[sid]["rarity"]]["bst"]
        return lo + ss["bandFloor"] * (hi - lo), hi

    for _ in range(3):
        for a, e in links:
            fa, ha = edges(a)
            fe, he = edges(e)
            ba, be = sum(fitted[a].values()), sum(fitted[e].values())
            na, ne = ba, be
            if be < ba * es["min"]:
                ne = min(he, max(be, math.ceil(ba * es["min"])))
                na = max(fa, min(ba, math.floor(ne / es["min"])))
            elif be > ba * es["max"]:
                na = max(ba, min(ha, math.ceil(be / es["max"])))
                ne = max(fe, min(be, math.floor(na * es["max"])))
            if (na, ne) != (ba, be):
                fitted[a] = scale_to(fitted[a], int(na))
                fitted[e] = scale_to(fitted[e], int(ne))
                NOTES.append(f"{a} -> {e}: evolution step set to BST {int(na)} -> {int(ne)}")
    return fitted


def shape_stats(stats):
    """Speed band (species_rules.json statShape): compress speed toward the pivot, refund the difference."""
    sb = RULES["statShape"]["speedBand"]
    out = dict(stats)
    delta = round((out["spe"] - sb["pivot"]) * (1 - sb["keep"]))
    out["spe"] -= delta
    refund = sb["refund"]
    share, rest = divmod(delta, len(refund))
    for i, k in enumerate(refund):
        out[k] += share + (1 if i < rest else 0)
    return out


# ---------------------------------------------------------------------------
# roster ordering / evolution
# ---------------------------------------------------------------------------


def ordered_roster(roster):
    by_id = {s["id"]: s for s in roster}
    pre = {}
    for s in roster:
        to = s.get("evolvesTo") or ""
        if to:
            if to not in by_id:
                raise SystemExit(f"{s['id']}: evolvesTo {to} missing from roster")
            if to in pre:
                raise SystemExit(f"{to}: evolves from both {pre[to]} and {s['id']}")
            pre[to] = s["id"]
    families = []
    members = {}
    for s in roster:
        if s["family"] not in members:
            families.append(s["family"])
            members[s["family"]] = []
        members[s["family"]].append(s)
    order = []
    for f in families:
        seen = set()
        for root in [x for x in members[f] if x["id"] not in pre]:
            cur = root
            while cur and cur["id"] not in seen:
                seen.add(cur["id"])
                order.append(cur)
                cur = by_id.get(cur.get("evolvesTo") or "")
        for x in members[f]:
            if x["id"] not in seen:
                raise SystemExit(
                    f"{x['id']}: not reachable from a stage-1 root of family {f}"
                )
    return order, pre, members


def build():
    roster = SRC["roster"]
    order, pre, members = ordered_roster(roster)
    by_id = {s["id"]: s for s in roster}
    learnsets = {}
    out = []
    starters = set(RULES["starters"])
    fitted = enforce_evolution({s["id"]: fit_bst(s) for s in roster}, roster)
    for dex, s in enumerate(order, start=1):
        s = {**s, "baseStats": shape_stats(fitted[s["id"]])}
        for t in s["types"]:
            if t not in TYPE_IDS:
                raise SystemExit(f"{s['id']}: unknown type {t}")
        for b in s["habitats"]:
            if b not in BIOME_IDS:
                raise SystemExit(f"{s['id']}: unknown biome {b}")
        ctx = Ctx(s)
        p = pre.get(s["id"])
        if p:
            if by_id[p]["stage"] + 1 != s["stage"]:
                raise SystemExit(
                    f"{s['id']}: stage {s['stage']} but pre-evolution {p} is stage {by_id[p]['stage']}"
                )
            ls = evolved_learnset(ctx, by_id[p], learnsets[p], by_id[p]["evolveLevel"])
        else:
            ls = base_learnset(ctx)
        learnsets[s["id"]] = ls
        final_ls = finalize_learnset(ls)
        d = DESIGN.get(s["id"], {})
        sp = {
            "id": s["id"],
            "dexNo": dex,
            "nameZh": s["nameZh"],
            "nameEn": s["nameEn"],
            "company": s["company"],
            "country": s["country"],
            "category": s["category"],
            "family": s["family"],
            "stage": s["stage"],
        }
        if s.get("evolvesTo"):
            evo = RULES.get("evolution", {})
            kind = s.get("evolutionKind") or evo.get("defaultKind", "post-training")
            if kind not in {"post-training", "version"}:
                raise SystemExit(f"{s['id']}: invalid evolutionKind {kind!r}")
            sp["evolvesTo"] = {"id": s["evolvesTo"], "level": s["evolveLevel"], "kind": kind}
        if p:
            sp["evolvesFrom"] = p
        sp.update(
            {
                "types": list(s["types"]),
                "rarity": s["rarity"],
                "baseStats": s["baseStats"],
                "abilities": pick_abilities(s),
                "learnset": final_ls,
                "teachable": pick_teachable(ctx, final_ls),
                "catchRate": catch_rate(s),
                "baseExp": base_exp(s),
                "growth": growth_for(s, members[s["family"]]),
                "habitats": list(s["habitats"]),
                "dexEntry": s["dexEntryZh"],
                "releaseDate": s["releaseDate"],
                "personality": d.get("personality", ""),
                "size": size_for(s),
            }
        )
        if s["id"] in starters:
            sp["starter"] = True
        if d.get("chibiDesign"):
            sp["designPrompt"] = d["chibiDesign"]
        out.append(sp)
    check(out)
    return out


def check(species):
    ids = {s["id"] for s in species}
    errs = []
    missing = set(RULES["starters"]) - ids
    if missing:
        errs.append(f"starters missing: {sorted(missing)}")
    for s in species:
        n = len(s["learnset"])
        if not LR["minEntries"] <= n <= LR["maxEntries"]:
            errs.append(f"{s['id']}: learnset size {n}")
        if len({e["move"] for e in s["learnset"]}) != n:
            errs.append(f"{s['id']}: duplicate learnset move")
        if sum(1 for e in s["learnset"] if e["level"] == 1) < 2:
            errs.append(f"{s['id']}: fewer than 2 level-1 moves")
        for e in s["learnset"]:
            if e["move"] not in MOVE_BY_ID:
                errs.append(f"{s['id']}: unknown move {e['move']}")
        for a in s["abilities"]:
            if a not in ABILITY_IDS:
                errs.append(f"{s['id']}: unknown ability {a}")
        if s["growth"] not in GROWTH_IDS:
            errs.append(f"{s['id']}: unknown growth {s['growth']}")
        lo, hi = RARITY[s["rarity"]]["catchRate"]
        if not lo <= s["catchRate"] <= hi:
            errs.append(f"{s['id']}: catchRate {s['catchRate']} outside [{lo},{hi}]")
    if errs:
        raise SystemExit("\n".join(errs))


# ---------------------------------------------------------------------------
# docs/roster.md
# ---------------------------------------------------------------------------


def roster_doc(species):
    L = RULES["rosterDocLabels"]
    by_id = {s["id"]: s for s in species}
    tn = lambda s: L["typeSep"].join(TYPE_NAME[t] for t in s["types"])
    stat_total = lambda s: sum(s["baseStats"][k] for k in STAT_KEYS)
    starters = [by_id[i] for i in RULES["starters"]]
    lines = [
        L["title"],
        "",
        L["generated"],
        "",
        L["summary"].format(
            n=len(species),
            families=len({s["family"] for s in species}),
            starters=len(starters),
        ),
        "",
    ]
    lines += [L["starterTitle"], "", L["starterIntro"], ""]
    for a in starters:
        for b in starters:
            if a is not b and any(
                CHART.get(x, {}).get(y, 1) == 2 for x in a["types"] for y in b["types"]
            ):
                lines.append(
                    L["starterRow"].format(
                        a=a["nameZh"], at=tn(a), b=b["nameZh"], bt=tn(b)
                    )
                )
    lines += ["", L["starterHeader"], "|---|---|---|---|---|---|"]

    def chain(s):
        root = s
        while root.get("evolvesFrom"):
            root = by_id[root["evolvesFrom"]]
        names, cur = [], root
        while cur:
            evo = cur.get("evolvesTo")
            names.append(
                L["chainStep"].format(name=cur["nameZh"], level=evo["level"])
                if evo
                else cur["nameZh"]
            )
            cur = by_id.get(evo["id"]) if evo else None
        return L["chainSep"].join(names)

    for s in starters:
        lines.append(
            f"| {s['nameZh']} | {s['company']} | {tn(s)} | {s['rarity']} | {stat_total(s)} | {chain(s)} |"
        )
    lines += ["", L["rarityTitle"], "", L["rarityHeader"], "|---|---|---|---|---|"]

    def rng(pair):
        return L["range"].format(lo=pair[0], hi=pair[1])

    for r in sorted(RARITY.values(), key=lambda r: r["order"]):
        n = sum(1 for s in species if s["rarity"] == r["id"])
        lines.append(
            f"| {r['id']} | {r['nameZh']} | {n} | {rng(r['bst'])} | {rng(r['catchRate'])} |"
        )
    lines += ["", L["bstNotesTitle"], ""]
    lines += [f"- {n}" for n in NOTES] if NOTES else [L["bstNotesNone"]]
    lines += [
        "",
        L["tableTitle"],
        "",
        L["tableHeader"],
        "|---|---|---|---|---|---|---|---|",
    ]
    for s in species:
        evo = []
        if s.get("evolvesFrom"):
            evo.append(L["evoFrom"].format(name=by_id[s["evolvesFrom"]]["nameZh"]))
        if s.get("evolvesTo"):
            evo.append(
                L["evoTo"].format(
                    name=by_id[s["evolvesTo"]["id"]]["nameZh"],
                    level=s["evolvesTo"]["level"],
                )
            )
        cells = [
            str(s["dexNo"]),
            s["nameZh"].replace("|", "/"),
            s["company"].replace("|", "/"),
            s["country"],
            tn(s),
            s["rarity"],
            str(stat_total(s)),
            L["listSep"].join(evo) or L["evoNone"],
        ]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def formatted(species):
    """species.json text exactly as tools/content_fmt.py lays it out."""
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d) / "species.json"
        tmp.write_text(json.dumps(species, ensure_ascii=False) + "\n")
        subprocess.run(
            [sys.executable, str(ROOT / "tools" / "content_fmt.py"), str(tmp)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        return tmp.read_text()


def main():
    species = build()
    outputs = {ROOT / RULES["output"]: formatted(species)}
    if "--no-doc" not in sys.argv:
        outputs[ROOT / RULES["rosterDoc"]] = roster_doc(species)
    if "--check" in sys.argv:
        stale = [
            str(f.relative_to(ROOT))
            for f, text in outputs.items()
            if not f.exists() or f.read_text() != text
        ]
        if stale:
            print("stale (run python3 tools/data/build_species.py):", ", ".join(stale))
            sys.exit(1)
        print(f"up to date: {len(species)} species")
        return
    for f, text in outputs.items():
        f.write_text(text)
    for n in NOTES:
        print("note:", n)
    print(f"wrote {len(species)} species to {RULES['output']}")


if __name__ == "__main__":
    main()
