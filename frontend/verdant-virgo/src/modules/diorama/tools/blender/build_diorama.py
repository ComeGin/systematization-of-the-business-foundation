# 模型（diorama.glb）を Blender で組み立て、焼き込み、書き出すスクリプト（計画 Task 4）。
# 動かし方: ホストの Windows の Blender（5.2）で、MCP の execute_blender_code にこのファイルの中身を渡して実行する（STAGES で段を選ぶ）。
# 正本はこのスクリプトと ambientCG のテクスチャ（Wood092・Paper001。CC0）。.blend はこのスクリプトで作り直せる作業ファイル。
# 座標は Blender（Z 上・-Y が手前）。glTF の書き出しで Y 上に変わる。部品・ノード名の約束は src/modules/diorama/lib/parts.ts・pages.ts。
import bpy, os, math, random, time
from mathutils import Vector

ROOT = r"C:\Users\kamegin\ComeGin-diorama"
TEX = os.path.join(ROOT, "textures")
STAGES = globals().get("STAGES", ["build", "bake", "export"])

def col():
    return bpy.data.collections["diorama"]

def bsdf_of(m):
    m.use_nodes = True
    nt = m.node_tree
    b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None) or nt.nodes.new("ShaderNodeBsdfPrincipled")
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    return nt, b

def tex_mat(name, aid, tint=(1, 1, 1, 1), scale=1.0, rough=0.75):
    m = bpy.data.materials.new(name)
    nt, b = bsdf_of(m)
    tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (scale, scale, scale)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(os.path.join(TEX, aid, f"{aid}_1K-JPG_Color.jpg"), check_existing=True)
    t.projection = "BOX"; t.projection_blend = 0.3
    nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"; mix.inputs["Factor"].default_value = 1.0
    mix.inputs[7].default_value = tint
    nt.links.new(t.outputs["Color"], mix.inputs[6]); nt.links.new(mix.outputs[2], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    return m

def flat_mat(name, rgba, rough=0.6):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt, b = bsdf_of(m)
    b.inputs["Base Color"].default_value = rgba; b.inputs["Roughness"].default_value = rough
    return m

def _link(o, parent):
    for c in list(o.users_collection): c.objects.unlink(o)
    col().objects.link(o)
    if parent is not None:
        mw = o.matrix_world.copy(); o.parent = parent; o.matrix_world = mw
    return o

def box(name, size, loc, mat, bevel=0.012, parent=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = 2
        bpy.ops.object.modifier_apply(modifier="bevel")
    o.data.materials.append(mat)
    return _link(o, parent)

def cyl(name, r, depth, loc, mat, rot=(0, 0, 0), verts=32, parent=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, rotation=rot, vertices=verts)
    o = bpy.context.active_object; o.name = name; o.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return _link(o, parent)

def empty(name, loc, parent=None, size=0.1):
    # bpy.data.objects.new で作った直後は matrix_world がまだ計算されていない（単位行列）。親は平行移動だけの空なので、位置の差で置く
    o = bpy.data.objects.new(name, None); o.empty_display_size = size
    col().objects.link(o)
    if parent is not None:
        o.parent = parent; o.matrix_parent_inverse.identity()
        o.location = Vector(loc) - parent.location
    else:
        o.location = loc
    return o

PIDS = ["base", "shelf", "desk", "roster", "pipe", "gauge", "agents", "approval", "shipping", "site", "workshop", "drafting", "bridge", "priceTag"]

# ページごとのカメラ（位置・注視点・焦点距離 mm）。名前は lib/pages.ts の camera
CAMS = {
    "cam_top": ((-5.4, -10.6, 7.0), (-2.9, 0.45, 0.2), 36),
    "cam_services": ((-3.2, -10.8, 7.2), (-0.9, 0.3, 0.2), 40),
    "cam_service_environment-setup": ((-5.6, -6.0, 2.0), (-1.0, -0.4, 0.1), 32),
    "cam_service_development": ((-1.6, -0.4, 3.2), (-2.1, 1.65, 0.4), 32),
    "cam_service_consulting": ((0.6, -0.2, 3.2), (0.2, 1.7, 0.45), 32),
    "cam_service_partnership": ((4.9, -0.6, 1.6), (3.3, 1.35, 0.4), 32),
    "cam_about": ((0.0, -2.0, 1.9), (0.95, 0.6, 0.5), 32),
    "cam_pricing": ((-1.5, -3.5, 1.2), (-2.35, -1.72, 0.28), 40),
    "cam_blog": ((-1.0, -1.6, 1.8), (-1.9, 0.75, 0.5), 32),
    "cam_contact": ((0.4, -3.3, 1.9), (1.55, -0.9, 0.5), 32),
    "cam_contactThanks": ((2.4, -3.0, 1.5), (1.5, -0.9, 0.55), 36),
}

def build():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for c in list(bpy.data.collections): bpy.data.collections.remove(c)
    for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)
    for i in list(bpy.data.images):
        if i.name.startswith("bake_"): bpy.data.images.remove(i)
    for cam in list(bpy.data.cameras): bpy.data.cameras.remove(cam)
    c = bpy.data.collections.new("diorama"); bpy.context.scene.collection.children.link(c)
    random.seed(7)
    W = tex_mat("wood", "Wood092", scale=0.6, rough=0.6)
    WD = tex_mat("wood_dark", "Wood092", tint=(0.55, 0.42, 0.32, 1), scale=0.6, rough=0.6)
    P = tex_mat("paper", "Paper001", tint=(1.0, 0.985, 0.95, 1), scale=1.2, rough=0.85)
    PS = tex_mat("paper_shade", "Paper001", tint=(0.86, 0.84, 0.80, 1), scale=1.2, rough=0.85)
    B = flat_mat("brand_blue", (0.0065, 0.29, 0.81, 1), 0.5)
    I = flat_mat("ink", (0.04, 0.04, 0.05, 1), 0.7)
    BR = flat_mat("brass", (0.6, 0.42, 0.18, 1), 0.35)
    parts = {}
    def part(pid, x, y):
        e = empty(f"part_{pid}", (x, y, 0)); parts[pid] = e; return e

    e = part("base", 0, 0)
    box("base_board", (5.6, 4.2, 0.3), (0, 0, -0.15), W, bevel=0.03, parent=e)
    box("base_edge", (5.64, 4.24, 0.06), (0, 0, -0.27), WD, bevel=0.02, parent=e)

    x, y = -1.9, 0.75; e = part("shelf", x, y)
    for sx in (-0.43, 0.43): box("shelf_side", (0.04, 0.42, 1.0), (x + sx, y, 0.5), P, parent=e)
    for z in (0.02, 0.35, 0.68, 0.98): box("shelf_plank", (0.9, 0.42, 0.04), (x, y, z), P, parent=e)
    box("shelf_back", (0.9, 0.02, 1.0), (x, y + 0.2, 0.5), PS, bevel=0.004, parent=e)
    for z0 in (0.04, 0.37, 0.70):
        cx = x - 0.38
        while cx < x + 0.34:
            w = random.uniform(0.035, 0.07); h = random.uniform(0.18, 0.27)
            mat = B if random.random() < 0.12 else (PS if random.random() < 0.5 else P)
            box("shelf_book", (w, 0.3, h), (cx + w / 2, y - 0.02, z0 + h / 2), mat, bevel=0.004, parent=e)
            cx += w + 0.008

    x, y = 1.55, -0.95; e = part("desk", x, y)
    box("desk_counter", (1.1, 0.5, 0.42), (x, y, 0.21), P, parent=e)
    box("desk_top", (1.2, 0.58, 0.04), (x, y, 0.44), PS, parent=e)
    box("desk_back", (1.1, 0.04, 0.72), (x, y + 0.27, 0.78), P, parent=e)
    box("desk_window", (0.62, 0.05, 0.3), (x, y + 0.27, 0.86), I, bevel=0.004, parent=e)
    cyl("desk_bell", 0.05, 0.05, (x - 0.35, y - 0.1, 0.485), BR, parent=e)
    box("desk_bubble", (0.22, 0.02, 0.14), (x + 0.38, y + 0.05, 0.72), B, bevel=0.02, parent=e)
    cyl("desk_bubble_stick", 0.008, 0.25, (x + 0.38, y + 0.05, 0.56), P, parent=e)

    x, y = 0.05, -1.35; e = part("roster", x, y)
    box("roster_box", (0.62, 0.42, 0.2), (x, y, 0.1), P, parent=e)
    for i in range(9):
        mat = B if i == 4 else (PS if i % 2 else P)
        box("roster_card", (0.54, 0.01, 0.17), (x, y - 0.17 + i * 0.04, 0.2), mat, bevel=0.002, parent=e, rot=(math.radians(-12), 0, 0))

    x, y = 0.8, -0.35; e = part("pipe", x, y)
    cyl("pipe_v", 0.055, 0.42, (x, y, 0.21), P, parent=e)
    cyl("pipe_h1", 0.045, 0.5, (x - 0.25, y, 0.3), P, rot=(0, math.radians(90), 0), parent=e)
    cyl("pipe_h2", 0.045, 0.4, (x, y + 0.2, 0.18), P, rot=(math.radians(90), 0, 0), parent=e)
    for jp in ((x, y, 0.3), (x, y, 0.18)): cyl("pipe_joint", 0.07, 0.07, jp, BR, parent=e)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.08, minor_radius=0.012, location=(x, y, 0.47))
    o = bpy.context.active_object; o.name = "pipe_valve"; o.data.materials.append(BR); _link(o, e)

    x, y = -1.95, -1.0; e = part("gauge", x, y)
    box("gauge_stand", (0.74, 0.26, 0.4), (x, y, 0.2), P, parent=e)
    for i, dx in enumerate((-0.22, 0, 0.22)):
        cyl("gauge_dial", 0.09, 0.03, (x + dx, y - 0.135, 0.26), B if i == 1 else PS, rot=(math.radians(90), 0, 0), parent=e)
        cyl("gauge_face", 0.075, 0.01, (x + dx, y - 0.152, 0.26), P, rot=(math.radians(90), 0, 0), parent=e)
        box("gauge_needle", (0.008, 0.006, 0.065), (x + dx + 0.012, y - 0.16, 0.285), I, bevel=0, parent=e, rot=(0, math.radians(-25 + i * 25), 0))

    x, y = -0.6, 0.85; e = part("agents", x, y)
    box("agents_body", (0.76, 0.7, 1.15), (x, y, 0.575), P, parent=e)
    box("agents_roof", (0.84, 0.78, 0.05), (x, y, 1.175), PS, parent=e)
    for r in range(3):
        for ci in range(3):
            box("agents_window", (0.14, 0.02, 0.16), (x - 0.22 + ci * 0.22, y - 0.355, 0.3 + r * 0.3), B if (r, ci) == (1, 1) else I, bevel=0.003, parent=e)
    cyl("agents_antenna", 0.008, 0.35, (x + 0.25, y + 0.2, 1.37), BR, parent=e)

    x, y = 0.75, 0.55; e = part("approval", x, y)
    box("approval_podium", (0.56, 0.46, 0.5), (x, y, 0.25), P, parent=e)
    box("approval_top", (0.64, 0.54, 0.04), (x, y, 0.52), PS, parent=e)
    box("approval_doc", (0.22, 0.3, 0.006), (x - 0.08, y, 0.545), P, bevel=0, parent=e)
    cyl("approval_stamp_grip", 0.025, 0.1, (x + 0.15, y - 0.05, 0.6), BR, parent=e)
    cyl("approval_stamp_head", 0.045, 0.03, (x + 0.15, y - 0.05, 0.555), B, parent=e)

    x, y = 1.85, 0.95; e = part("shipping", x, y)
    box("shipping_body", (0.82, 0.62, 0.62), (x, y, 0.31), P, parent=e)
    box("shipping_mouth", (0.5, 0.03, 0.32), (x, y - 0.31, 0.26), I, bevel=0.004, parent=e)
    box("shipping_ramp", (0.5, 0.42, 0.03), (x, y - 0.5, 0.1), PS, parent=e, rot=(math.radians(-22), 0, 0))
    box("shipping_arrow", (0.24, 0.02, 0.05), (x, y - 0.315, 0.5), B, bevel=0.006, parent=e)

    x, y = 2.25, -0.05; e = part("site", x, y)
    box("site_stand", (0.18, 0.18, 0.02), (x, y, 0.01), PS, parent=e)
    box("site_neck", (0.04, 0.04, 0.16), (x, y, 0.1), PS, parent=e)
    box("site_frame", (0.9, 0.06, 0.6), (x, y, 0.48), P, parent=e)
    box("site_screen", (0.82, 0.01, 0.52), (x, y - 0.031, 0.48), I, bevel=0, parent=e)
    for w, z in ((0.36, 0.6), (0.44, 0.54), (0.28, 0.49)):
        box("site_line", (w, 0.004, 0.025), (x - 0.38 + w / 2, y - 0.037, z), P, bevel=0, parent=e)
    box("site_cta", (0.14, 0.004, 0.045), (x - 0.31, y - 0.037, 0.4), B, bevel=0, parent=e)
    box("site_media", (0.26, 0.004, 0.3), (x + 0.22, y - 0.037, 0.5), PS, bevel=0, parent=e)
    mk = empty("site_screen_marker", (x, y - 0.04, 0.48), parent=e); mk.scale = (0.82, 0.01, 0.52)

    x, y = -2.1, 1.65; e = part("workshop", x, y)
    box("workshop_top", (0.95, 0.46, 0.05), (x, y, 0.38), P, parent=e)
    for lx in (-0.42, 0.42):
        for ly in (-0.18, 0.18): box("workshop_leg", (0.04, 0.04, 0.36), (x + lx, y + ly, 0.18), PS, parent=e)
    box("workshop_vise", (0.14, 0.12, 0.1), (x + 0.3, y - 0.12, 0.455), PS, parent=e)
    cyl("workshop_gear", 0.08, 0.03, (x - 0.2, y, 0.42), B, verts=12, parent=e)
    cyl("workshop_hammer_h", 0.012, 0.26, (x + 0.02, y + 0.08, 0.42), WD, rot=(0, math.radians(90), math.radians(20)), parent=e)
    box("workshop_hammer_head", (0.04, 0.09, 0.04), (x + 0.14, y + 0.12, 0.42), BR, bevel=0.005, parent=e)

    x, y = 0.2, 1.7; e = part("drafting", x, y)
    for lx in (-0.32, 0.32): box("drafting_leg", (0.04, 0.04, 0.42), (x + lx, y + 0.1, 0.21), PS, parent=e)
    box("drafting_board", (0.82, 0.56, 0.035), (x, y, 0.48), P, parent=e, rot=(math.radians(22), 0, 0))
    box("drafting_sheet", (0.6, 0.42, 0.004), (x, y - 0.01, 0.502), PS, bevel=0, parent=e, rot=(math.radians(22), 0, 0))
    for i in range(4):
        box("drafting_line", (0.42 - i * 0.06, 0.012, 0.002), (x - 0.02, y - 0.12 + i * 0.08, 0.46 + i * 0.032), B, bevel=0, parent=e, rot=(math.radians(22), 0, 0))
    box("drafting_ruler", (0.5, 0.04, 0.008), (x + 0.04, y - 0.2, 0.43), BR, bevel=0.002, parent=e, rot=(math.radians(22), 0, math.radians(8)))

    x, y = 3.05, 1.35; e = part("bridge", x, y)
    box("bridge_deck", (1.1, 0.34, 0.04), (x, y, 0.36), P, parent=e)
    for sy in (-0.16, 0.16): box("bridge_rail", (1.1, 0.02, 0.14), (x, y + sy, 0.45), PS, bevel=0.004, parent=e)
    for px in (-0.45, 0.45): box("bridge_post", (0.04, 0.3, 0.36), (x + px, y, 0.18), PS, parent=e)
    box("neighbor_plinth", (0.9, 0.9, 0.16), (x + 0.95, y, -0.08), W, bevel=0.02, parent=e)
    box("neighbor_body", (0.66, 0.66, 0.78), (x + 0.95, y, 0.39), PS, parent=e)
    box("neighbor_door", (0.16, 0.02, 0.26), (x + 0.95, y - 0.34, 0.13), B, bevel=0.004, parent=e)

    x, y = -2.45, -1.72; e = part("priceTag", x, y)
    cyl("tag_stake", 0.012, 0.42, (x, y, 0.21), BR, parent=e)
    box("tag_card", (0.3, 0.012, 0.19), (x + 0.17, y, 0.3), P, bevel=0.01, parent=e, rot=(0, math.radians(-8), 0))
    cyl("tag_dot", 0.025, 0.014, (x + 0.08, y - 0.008, 0.33), B, rot=(math.radians(90), 0, 0), parent=e)

    lamp = empty("lamp", (0.0, 0.1, 3.3))
    cyl("lamp_cord", 0.008, 2.0, (0.0, 0.1, 4.3), I, parent=lamp)
    bpy.ops.mesh.primitive_cone_add(radius1=0.42, radius2=0.06, depth=0.34, location=(0.0, 0.1, 3.3), vertices=48)
    o = bpy.context.active_object; o.name = "lamp_shade"; o.data.materials.append(I); bpy.ops.object.shade_smooth(); _link(o, lamp)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, location=(0.0, 0.1, 3.14))
    o = bpy.context.active_object; o.name = "lamp_bulb"; o.data.materials.append(flat_mat("bulb", (1.0, 0.85, 0.6, 1), 0.3)); _link(o, lamp)

    empty("avatar_spot", (1.2, 0.75, 0.0))

    # 部品ごとにメッシュを 1 つにまとめ、ボタンを重ねる点（anchor）と接地影の板（shadow）を置く
    shadow_mat = flat_mat("shadow", (0, 0, 0, 1), 1.0)
    for pid in PIDS:
        e = parts[pid]
        meshes = [o for o in e.children if o.type == "MESH"]
        bpy.ops.object.select_all(action="DESELECT")
        for o in meshes: o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        m = bpy.context.active_object; m.name = f"{pid}_mesh"; m.data.name = f"{pid}_mesh"
        pts = [m.matrix_world @ Vector(cc) for cc in m.bound_box]
        xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
        if pid == "base":
            anchor = (0.0, -1.85, 0.05)
        elif pid == "bridge":
            anchor = (e.location.x, e.location.y, 0.62)
        else:
            anchor = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, max(zs) + 0.12)
        empty(f"anchor_{pid}", anchor, parent=e)
        if pid not in ("base", "priceTag"):
            if pid == "bridge":
                cx, cy, w, d = e.location.x, e.location.y, 1.0, 0.5
            else:
                cx, cy, w, d = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, max(xs) - min(xs), max(ys) - min(ys)
            bpy.ops.mesh.primitive_plane_add(size=1, location=(cx, cy, 0.004))
            s = bpy.context.active_object; s.name = f"shadow_{pid}"; s.scale = (w * 1.25, d * 1.25, 1)
            bpy.ops.object.transform_apply(scale=True)
            s.data.materials.append(shadow_mat); _link(s, None); s.hide_render = True

    for name, (loc, target, lens) in CAMS.items():
        data = bpy.data.cameras.new(name); cam = bpy.data.objects.new(name, data); col().objects.link(cam)
        data.lens = lens; data.sensor_fit = "HORIZONTAL"; data.clip_start = 0.1; data.clip_end = 60
        cam.location = loc
        cam.rotation_mode = "QUATERNION"; cam.rotation_quaternion = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y")
    bpy.context.scene.camera = bpy.data.objects["cam_top"]
    bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y = 1600, 900

def bake_part(pid, size, hide_others=False):
    m = bpy.data.objects[f"{pid}_mesh"]
    others = [o for o in bpy.data.objects if o.type == "MESH" and o.name.endswith("_mesh") and o is not m]
    prev = {o.name: o.hide_render for o in others}
    if hide_others:
        for o in others: o.hide_render = True
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = m; m.select_set(True)
    # 箱・円柱は最初から重なった UV を持つので、必ず作り直す（重なったまま焼くと色が混ざる）
    while m.data.uv_layers: m.data.uv_layers.remove(m.data.uv_layers[0])
    m.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.015)
    bpy.ops.object.mode_set(mode="OBJECT")
    im = bpy.data.images.get(f"bake_{pid}") or bpy.data.images.new(f"bake_{pid}", size, size, alpha=False)
    for slot in m.material_slots:
        nt = slot.material.node_tree
        n = nt.nodes.get("BAKE") or nt.nodes.new("ShaderNodeTexImage")
        n.name = "BAKE"; n.image = im
        for x in nt.nodes: x.select = False
        n.select = True; nt.nodes.active = n
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT", "COLOR"})
    for o in others: o.hide_render = prev[o.name]

def bake(pids=None):
    # 均一な白い光（環境光だけ）の下の色＝紙・木の色 × 陰影（AO）。光の向きは three のランプが受け持つ
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"; scene.cycles.device = "CPU"; scene.cycles.samples = 48; scene.cycles.use_denoising = True
    scene.render.bake.margin = 8
    w = scene.world or bpy.data.worlds.new("World"); scene.world = w; w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == "BACKGROUND"); bg.inputs[0].default_value = (1, 1, 1, 1); bg.inputs[1].default_value = 1.0
    for o in bpy.data.objects:
        if o.type == "LIGHT": o.hide_render = True
    for pid in (pids or PIDS):
        bake_part(pid, 1024 if pid == "base" else 512, hide_others=(pid == "base"))

def apply_baked():
    for pid in PIDS:
        m = bpy.data.objects[f"{pid}_mesh"]
        mat = bpy.data.materials.get(f"baked_{pid}") or bpy.data.materials.new(f"baked_{pid}")
        nt, b = bsdf_of(mat)
        t = nt.nodes.get("TEX") or nt.nodes.new("ShaderNodeTexImage"); t.name = "TEX"; t.image = bpy.data.images[f"bake_{pid}"]
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        b.inputs["Roughness"].default_value = 0.6 if pid == "base" else 0.85
        m.data.materials.clear(); m.data.materials.append(mat)

def export():
    apply_baked()
    path = os.path.join(ROOT, "diorama.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for o in col().objects: o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_cameras=True, export_lights=False,
        export_image_format="WEBP", export_image_quality=82, export_apply=True, export_yup=True,
        export_draco_mesh_compression_enable=False, export_meshopt_compression_enable=True, export_extras=False,
    )
    return os.path.getsize(path)

_t = time.time(); _out = {}
if "build" in STAGES: build(); _out["built"] = len(bpy.data.objects)
if "bake" in STAGES: bake(globals().get("BAKE_PIDS")); _out["baked"] = True
if "export" in STAGES: _out["glb_bytes"] = export()
_out["sec"] = round(time.time() - _t, 1)
