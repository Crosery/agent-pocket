"""Spec loading and the tiny safe expression language used by buildings_spec.json.

Numbers in the spec may be literals or strings such as "W-0.3" / "max(H*0.5, wallH)".
Names resolve against the building scope: W, D, H (PropDef footprint/height), DX, DY (PropDef door
offsets, 0 when absent), DOORX (door tile centre x), HAS_DOOR, then spec-level defaults.vars and per-building vars in order.
"""

import ast
import json
import math
import operator
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SPEC_PATH = ROOT / "tools" / "blender" / "buildings_spec.json"
PROPS_PATH = ROOT / "content" / "props.json"
MODELS_DIR = ROOT / "public" / "assets" / "models"
SRC_DIR = ROOT / "assets_src" / "blender" / "buildings"

_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
    ast.FloorDiv: operator.floordiv,
}
_CMPOPS = {
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
}
_FUNCS = {
    "min": min,
    "max": max,
    "abs": abs,
    "floor": math.floor,
    "ceil": math.ceil,
    "sqrt": math.sqrt,
    "sin": lambda d: math.sin(math.radians(d)),
    "cos": lambda d: math.cos(math.radians(d)),
    "tan": lambda d: math.tan(math.radians(d)),
    "atan": lambda v: math.degrees(math.atan(v)),
    "atan2": lambda y, x: math.degrees(math.atan2(y, x)),
    "round": round,
}


class SpecError(Exception):
    pass


def _eval_node(node, scope, src):
    if isinstance(node, ast.Expression):
        return _eval_node(node.body, scope, src)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name):
        if node.id not in scope:
            raise SpecError(f"unknown name {node.id!r} in expression {src!r}")
        return scope[node.id]
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        return _BINOPS[type(node.op)](
            _eval_node(node.left, scope, src), _eval_node(node.right, scope, src)
        )
    if isinstance(node, ast.UnaryOp) and isinstance(
        node.op, (ast.USub, ast.UAdd, ast.Not)
    ):
        v = _eval_node(node.operand, scope, src)
        return (
            -v
            if isinstance(node.op, ast.USub)
            else (v if isinstance(node.op, ast.UAdd) else (0 if v else 1))
        )
    if (
        isinstance(node, ast.Compare)
        and len(node.ops) == 1
        and type(node.ops[0]) in _CMPOPS
    ):
        ok = _CMPOPS[type(node.ops[0])](
            _eval_node(node.left, scope, src),
            _eval_node(node.comparators[0], scope, src),
        )
        return 1 if ok else 0
    if isinstance(node, ast.BoolOp):
        vals = [_eval_node(v, scope, src) for v in node.values]
        return (
            (1 if all(vals) else 0)
            if isinstance(node.op, ast.And)
            else (1 if any(vals) else 0)
        )
    if isinstance(node, ast.IfExp):
        return _eval_node(
            node.body if _eval_node(node.test, scope, src) else node.orelse, scope, src
        )
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in _FUNCS
        and not node.keywords
    ):
        return _FUNCS[node.func.id](*[_eval_node(a, scope, src) for a in node.args])
    raise SpecError(f"unsupported syntax in expression {src!r}")


def ev(value, scope):
    """Evaluate a spec scalar (number | expression string)."""
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            tree = ast.parse(value, mode="eval")
        except SyntaxError as exc:
            raise SpecError(f"bad expression {value!r}: {exc}") from exc
        return _eval_node(tree, scope, value)
    raise SpecError(f"expected number or expression, got {value!r}")


def ev_vec(value, scope, n=None):
    if not isinstance(value, list):
        raise SpecError(f"expected list, got {value!r}")
    out = [float(ev(v, scope)) for v in value]
    if n is not None and len(out) != n:
        raise SpecError(f"expected {n} components, got {value!r}")
    return out


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_spec():
    return load_json(SPEC_PATH)


def load_props():
    return {p["key"]: p for p in load_json(PROPS_PATH)}


def building_scope(spec, prop, bspec):
    """Variables visible to a building's expressions, derived from PropDef + spec vars (in order)."""
    w, d = prop["footprint"]
    door = prop.get("door")
    scope = {
        "W": float(w),
        "D": float(d),
        "H": float(prop["height"]),
        "DX": float(door[0]) if door else 0.0,
        "DY": float(door[1]) if door else 0.0,
        "HAS_DOOR": 1 if door else 0,
        # door tile = column floor(W/2)+DX of the footprint (src/shared/world/collision.ts propDoor),
        # expressed relative to the footprint centre: +0.5 for even widths when DX = 0
        "DOORX": (math.floor(w / 2) + float(door[0]) - (w - 1) / 2) if door else 0.0,
    }
    for src in (spec.get("defaults", {}).get("vars", {}), bspec.get("vars", {})):
        for k, v in src.items():
            scope[k] = float(ev(v, scope))
    return scope
