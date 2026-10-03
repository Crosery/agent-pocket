"""Materials + pixel textures from the spec (bpy). Images use 'Closest' interpolation so the glTF
exporter writes NEAREST samplers. Material names are the spec ids; ids prefixed `EMIT_` are the
night-glow contract with the game renderer and additionally carry an emissive map."""

import bpy
import numpy as np
from lib_bld_spec import SRC_DIR, SpecError
from lib_bld_tex import render_texture
from lib_bld_validate import EMIT_PREFIX


def texture_image(tex_id, spec, cache):
    if tex_id in cache:
        return cache[tex_id]
    textures = spec["textures"]
    if tex_id not in textures:
        raise SpecError(f"unknown texture {tex_id!r}")
    rgba = render_texture(textures[tex_id], spec.get("glyphs", {}), spec["defaults"]["patterns"])
    S = rgba.shape[0]
    out_dir = SRC_DIR / "textures"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{tex_id}.png"
    img = bpy.data.images.new(tex_id, S, S, alpha=False)
    img.pixels.foreach_set((np.flipud(rgba).astype(np.float32) / 255.0).ravel())
    img.filepath_raw = str(path)
    img.file_format = "PNG"
    img.save()
    cache[tex_id] = img
    return img


def make_material(mat_id, spec, cache):
    mats = spec["materials"]
    if mat_id not in mats:
        raise SpecError(f"unknown material {mat_id!r}")
    ms = mats[mat_id]
    emit = float(ms.get("emit", 0))
    if mat_id.startswith(EMIT_PREFIX) != (emit > 0):
        raise SpecError(
            f"material {mat_id!r}: `{EMIT_PREFIX}` prefix and emit > 0 must go together"
        )
    mat = bpy.data.materials.new(mat_id)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    img_node = nt.nodes.new("ShaderNodeTexImage")
    img_node.image = texture_image(ms["tex"], spec, cache)
    img_node.interpolation = "Closest"
    img_node.extension = "REPEAT"
    nt.links.new(img_node.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = float(
        ms.get("roughness", spec["defaults"]["roughness"])
    )
    bsdf.inputs["Metallic"].default_value = float(ms.get("metallic", 0))
    if emit > 0:
        src = img_node
        if "emitTex" in ms:
            src = nt.nodes.new("ShaderNodeTexImage")
            src.image = texture_image(ms["emitTex"], spec, cache)
            src.interpolation = "Closest"
            src.extension = "REPEAT"
        nt.links.new(src.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emit
    return mat


def uv_params(mat_id, spec):
    """(mode, repeats-per-unit) for a material: 'world' tiles by pxPerTile, 'fit' maps 0..1 per face."""
    ms = spec["materials"][mat_id]
    mode = ms.get("uv", "world")
    if mode not in ("world", "fit"):
        raise SpecError(f"material {mat_id!r}: uv must be world|fit")
    size = int(spec["textures"][ms["tex"]]["size"])
    px = float(ms.get("pxPerTile", spec["defaults"]["pxPerTile"]))
    return mode, px / size
