"""Mesh assembly, UV projection, GLB export, re-import verification and the preview contact sheet."""

import json
import math
import struct

import bmesh
import bpy
import numpy as np
from lib_bld_geo import build_part, resolve_role, with_defaults
from lib_bld_mat import make_material, uv_params
from lib_bld_spec import SRC_DIR, SpecError, ev_vec
from mathutils import Matrix, Vector

Z = Vector((0, 0, 1))


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def face_basis(n):
    if abs(n.z) > 0.999:
        return Vector((1, 0, 0)), Vector((0, 1 if n.z > 0 else -1, 0))
    u = Z.cross(n).normalized()
    return u, n.cross(u).normalized()


def _project_uvs(bm, mat_ids, spec):
    uv_layer = bm.loops.layers.uv.verify()
    params = [uv_params(m, spec) for m in mat_ids]
    for f in bm.faces:
        mode, k = params[f.material_index]
        u_ax, v_ax = face_basis(f.normal)
        coords = [(l.vert.co.dot(u_ax), l.vert.co.dot(v_ax)) for l in f.loops]
        if mode == "fit":
            us, vs = [c[0] for c in coords], [c[1] for c in coords]
            u0, v0 = min(us), min(vs)
            du, dv = max(max(us) - u0, 1e-6), max(max(vs) - v0, 1e-6)
            for l, (u, v) in zip(f.loops, coords):
                l[uv_layer].uv = ((u - u0) / du, (v - v0) / dv)
        else:
            for l, (u, v) in zip(f.loops, coords):
                l[uv_layer].uv = (u * k, v * k)


def _append(bm, sc, matrix, role_mat, mat_index, drop_ground, probes):
    """Copy a scratch mesh into bm under `matrix`, orienting normals outward per island.
    Faces flagged by `drop_ground` (downward, lying on z=0) are hidden by the terrain and skipped."""
    tmp = bmesh.new()
    verts = [tmp.verts.new(matrix @ co) for co in sc.verts]
    roles = []
    for idxs, role in sc.faces:
        try:
            tmp.faces.new([verts[i] for i in idxs])
            roles.append(role)
        except ValueError:
            continue  # degenerate / duplicate face from collapsed geometry
    tmp.faces.ensure_lookup_table()
    bmesh.ops.recalc_face_normals(tmp, faces=list(tmp.faces))
    tmp.normal_update()
    vmap = {}
    for f, role in zip(tmp.faces, roles):
        if drop_ground and f.normal.z < -0.99 and max(v.co.z for v in f.verts) < 1e-3:
            continue
        mid = role_mat(role)
        nv = []
        for v in f.verts:
            if v not in vmap:
                vmap[v] = bm.verts.new(v.co)
            nv.append(vmap[v])
        nf = bm.faces.new(nv)
        nf.material_index = mat_index(mid)
        if role in probes:
            probes[role].extend(v.co.to_tuple(4) for v in f.verts)
    tmp.free()


def build_objects(key, spec, scope):
    """Builds the building's mesh object(s); returns (objects, info dict)."""
    bspec = spec["buildings"][key]
    parts = bspec["parts"]
    nodes = {"": {"bm": bmesh.new(), "pivot": Vector((0, 0, 0))}}
    for name, nd in bspec.get("nodes", {}).items():
        nodes[name] = {"bm": bmesh.new(), "pivot": Vector(ev_vec(nd["pivot"], scope, 3))}
    mat_ids = []
    probes = {"door": []}
    drop_ground = bool(spec["defaults"].get("dropGroundFaces", True))

    def mat_index(mid):
        if mid not in mat_ids:
            mat_ids.append(mid)
        return mat_ids.index(mid)

    part_defaults = spec["defaults"]["parts"]
    for raw in parts:
        p = with_defaults(raw, part_defaults)
        node = p.get("node", "")
        if node not in nodes:
            raise SpecError(f"{key}: part uses undeclared node {node!r}")
        pivot = nodes[node]["pivot"]

        def role_mat(role, p=p):
            return resolve_role(p, role)

        for sc, m in build_part(p, scope):
            _append(nodes[node]["bm"], sc, Matrix.Translation(-pivot) @ m, role_mat, mat_index, drop_ground, probes)

    cache = {}
    materials = [make_material(mid, spec, cache) for mid in mat_ids]
    objects = []
    tris = 0
    for node, data in nodes.items():
        bm = data["bm"]
        if not bm.faces:
            bm.free()
            continue
        bm.normal_update()
        _project_uvs(bm, mat_ids, spec)
        tris += sum(len(f.verts) - 2 for f in bm.faces)
        name = key if not node else f"{key}_{node}"
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for mat in materials:
            me.materials.append(mat)
        obj = bpy.data.objects.new(name, me)
        obj.location = data["pivot"]
        bpy.context.scene.collection.objects.link(obj)
        objects.append(obj)
    for obj in objects:
        _strip_unused_slots(obj)
    return objects, {"tris": tris, "materials": mat_ids, "doors": probes["door"]}


def _strip_unused_slots(obj):
    """Drop material slots no polygon uses (slot removal resets indices, so they are re-applied)."""
    me = obj.data
    idx = [p.material_index for p in me.polygons]
    used = sorted(set(idx))
    remap = {old: new for new, old in enumerate(used)}
    keep = [me.materials[i] for i in used]
    me.materials.clear()
    for m in keep:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", [remap[i] for i in idx])
    me.update()


def export_glb(objects, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_vertex_color="NONE",
    )
    force_nearest_samplers(path)


NEAREST = 9728


def force_nearest_samplers(path):
    """The exporter writes NEAREST_MIPMAP_NEAREST for 'Closest' minification; pixel-art props want
    plain NEAREST (no mip blur), so rewrite the GLB JSON chunk in place."""
    data = path.read_bytes()
    jlen = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + jlen])
    for s in doc.get("samplers", []):
        s["magFilter"] = NEAREST
        s["minFilter"] = NEAREST
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    rest = data[20 + jlen:]
    total = 12 + 8 + len(js) + len(rest)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js + rest)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return [o for o in bpy.data.objects if o not in before]


def measure(objects):
    """World bbox, tri count, per-material face centroids for imported objects."""
    bpy.context.view_layer.update()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    tris = 0
    by_mat = {}
    for o in objects:
        if o.type != "MESH":
            continue
        mw = o.matrix_world
        me = o.data
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        for v in me.vertices:
            w = mw @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        for poly in me.polygons:
            if (
                poly.material_index < len(me.materials)
                and me.materials[poly.material_index]
            ):
                name = me.materials[poly.material_index].name
                by_mat.setdefault(name, []).append((mw @ poly.center).to_tuple())
    return {"min": lo.to_tuple(4), "max": hi.to_tuple(4), "tris": tris, "byMat": by_mat}


# --------------------------------------------------------------------------- preview


def _look_at(obj, target):
    d = (target - obj.location).normalized()
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render_preview(objects, label, out_path, pv):
    """Orthographic 3/4 render of already-imported objects with a text label."""
    scene = bpy.context.scene
    m = measure(objects)
    lo, hi = Vector(m["min"]), Vector(m["max"])
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5)
    az, el = math.radians(pv["azimuthDeg"]), math.radians(pv["elevationDeg"])
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = radius * 2 * pv["frame"]
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    dist = radius * 4 + 10
    cam.location = (
        center
        + Vector(
            (math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))
        )
        * dist
    )
    _look_at(cam, center)
    cam_data.clip_end = dist * 3
    scene.camera = cam
    sun_data = bpy.data.lights.new("sun", "SUN")
    sun_data.energy = pv["sunEnergy"]
    sun_data.angle = math.radians(pv["sunAngleDeg"])
    sun = bpy.data.objects.new("sun", sun_data)
    sun.rotation_euler = [math.radians(v) for v in pv["sunRotDeg"]]
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (*pv["bg"], 1)
    bg.inputs["Strength"].default_value = pv["ambient"]
    scene.world = world
    ground = bpy.data.meshes.new("ground")
    gbm = bmesh.new()
    bmesh.ops.create_grid(gbm, x_segments=1, y_segments=1, size=radius * 3)
    gbm.to_mesh(ground)
    gbm.free()
    gobj = bpy.data.objects.new("ground", ground)
    gmat = bpy.data.materials.new("ground")
    gmat.use_nodes = True
    gb = next(n for n in gmat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    gb.inputs["Base Color"].default_value = (*pv["ground"], 1)
    gb.inputs["Roughness"].default_value = 1
    ground.materials.append(gmat)
    gobj.location.z = -0.002
    scene.collection.objects.link(gobj)
    txt = bpy.data.curves.new("label", "FONT")
    txt.body = label
    txt.size = cam_data.ortho_scale * pv["labelSize"]
    txt.align_x = "CENTER"
    tobj = bpy.data.objects.new("label", txt)
    tmat = bpy.data.materials.new("label")
    tmat.use_nodes = True
    tb = next(n for n in tmat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    tb.inputs["Base Color"].default_value = (0, 0, 0, 1)
    tb.inputs["Emission Color"].default_value = (*pv["labelColor"], 1)
    tb.inputs["Emission Strength"].default_value = 1
    txt.materials.append(tmat)
    scene.collection.objects.link(tobj)
    tobj.parent = cam
    tobj.location = (0, -cam_data.ortho_scale * 0.45, -1)
    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x = r.resolution_y = int(pv["tilePx"])
    r.resolution_percentage = 100
    r.film_transparent = False
    r.image_settings.file_format = "PNG"
    r.filepath = str(out_path)
    scene.view_settings.view_transform = "Standard"
    if hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = int(pv["samples"])
    bpy.ops.render.render(write_still=True)


def compose_sheet(tile_paths, cols, out_path, bg):
    imgs = []
    for p in tile_paths:
        img = bpy.data.images.load(str(p))
        w, h = img.size
        arr = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
        imgs.append(np.flipud(arr))
        bpy.data.images.remove(img)
    th, tw = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    sheet = np.ones((rows * th, cols * tw, 4), dtype=np.float32)
    sheet[..., :3] = bg
    for i, im in enumerate(imgs):
        r_, c_ = divmod(i, cols)
        sheet[r_ * th : (r_ + 1) * th, c_ * tw : (c_ + 1) * tw] = im
    out = bpy.data.images.new("sheet", cols * tw, rows * th, alpha=True)
    out.pixels.foreach_set(np.flipud(sheet).ravel())
    out.filepath_raw = str(out_path)
    out.file_format = "PNG"
    out.save()


def preview_dir():
    d = SRC_DIR / "previews"
    d.mkdir(parents=True, exist_ok=True)
    return d
