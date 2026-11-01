# アトリエ（atelier.glb・atelier-mobile.glb・空の画像）を Blender で組み立て、焼き込み、書き出すスクリプト（計画 Task 2）。
# 動かし方: ホストの Windows の Blender（5.2）で、MCP の execute_blender_code から
#   STAGES = ["build", "bake", "export"]; exec(open(r"C:\Users\kamegin\ComeGin-atelier\incoming\build_atelier.py", encoding="utf-8").read())
# （VM から curl -T でこのファイルを送る。段は STAGES で選ぶ。sky は空の画像だけを書き出す）
# 素材（spec §5.4）:
#   Poly Haven Assets のアドオンで取り込んだ HDRI・テクスチャ・モデル（CC0）… ROOT\polyhaven\<slug>\
#   Lily Surface Scraper で ambientCG から取ったテクスチャ（CC0）… ROOT\LilySurface\ambientCG\<id>\
#   BlenderKit の無料素材（Royalty Free・CC0）… ROOT\blenderkit\<dir>\*.blend
# 座標は Blender（Z 上）。入口は y=-2、奥（相談の席）が +y。glTF の書き出しで Y 上・-Z 奥に変わる。
# ノード名の約束は src/modules/atelier/lib/{props,pages,frames}.ts と計画 Task 2 の Produces。
import bpy, os, math, time, glob
from mathutils import Vector, Matrix

ROOT = r"C:\Users\kamegin\ComeGin-atelier"
PH = os.path.join(ROOT, "polyhaven")
BK = os.path.join(ROOT, "blenderkit")
ACG = os.path.join(ROOT, "LilySurface", "ambientCG")
OUT = os.path.join(ROOT, "out")
STAGES = globals().get("STAGES", ["build", "bake", "export"])
EYE = 1.6
# 面の数の予算（spec §10）。Blender の書き出しは頂点を量子化しない（1 頂点 約 36 バイト）ので、面の数がそのまま glb の大きさになる。
# Mobile は書き出しのときに、さらに MOBILE_RATIO まで減らす
PROP_TRIS = 6500
MOBILE_RATIO = 0.5

ROOM = {"x": (-4.5, 4.5), "y": (-3.5, 17.5), "h": 6.0}
SKY = {"x": (-3.0, 3.0), "y": (-1.0, 15.0)}

# ---------------------------------------------------------------- 道具

def col():
    return bpy.data.collections["atelier"]

def bsdf_of(m):
    m.use_nodes = True
    nt = m.node_tree
    b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None) or nt.nodes.new("ShaderNodeBsdfPrincipled")
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    return nt, b

def flat_mat(name, rgba, rough=0.6, metal=0.0, emit=None, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt, b = bsdf_of(m)
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = emit
        b.inputs["Emission Strength"].default_value = 1.0
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m

def tiled_mat(name, color_path, rough=0.7, tint=None):
    # 部屋の面: 色は繰り返すテクスチャ（UVMap）、陰影は焼いた AO（UV_AO。glTF の occlusion）
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt, b = bsdf_of(m)
    for n in list(nt.nodes):
        if n.type not in ("BSDF_PRINCIPLED", "OUTPUT_MATERIAL"): nt.nodes.remove(n)
    uv = nt.nodes.new("ShaderNodeUVMap"); uv.uv_map = "UVMap"
    t = nt.nodes.new("ShaderNodeTexImage"); t.name = "COLOR"
    t.image = bpy.data.images.load(color_path, check_existing=True)
    nt.links.new(uv.outputs["UV"], t.inputs["Vector"])
    if tint:
        mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0; mix.inputs[7].default_value = tint
        nt.links.new(t.outputs["Color"], mix.inputs[6]); nt.links.new(mix.outputs[2], b.inputs["Base Color"])
    else:
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    return m

def gltf_output_group():
    g = bpy.data.node_groups.get("glTF Material Output")
    if g: return g
    g = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    g.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    g.nodes.new("NodeGroupInput")
    return g

def attach_ao(m, image):
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.name in ("AO_UV", "AO_TEX", "AO_OUT"): nt.nodes.remove(n)
    uv = nt.nodes.new("ShaderNodeUVMap"); uv.name = "AO_UV"; uv.uv_map = "UV_AO"
    t = nt.nodes.new("ShaderNodeTexImage"); t.name = "AO_TEX"; t.image = image
    sep = nt.nodes.new("ShaderNodeSeparateColor"); sep.name = "AO_SEP"
    go = nt.nodes.new("ShaderNodeGroup"); go.name = "AO_OUT"; go.node_tree = gltf_output_group()
    nt.links.new(uv.outputs["UV"], t.inputs["Vector"])
    nt.links.new(t.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Red"], go.inputs["Occlusion"])

def link(o, parent=None):
    for c in list(o.users_collection): c.objects.unlink(o)
    col().objects.link(o)
    if parent is not None:
        mw = o.matrix_world.copy(); o.parent = parent; o.matrix_parent_inverse.identity(); o.matrix_world = mw
    return o

def box(name, size, loc, mat, parent=None, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = 2
        bpy.ops.object.modifier_apply(modifier="bevel")
    o.data.materials.append(mat)
    return link(o, parent)

def empty(name, loc, parent=None, size=0.1):
    # 第 1 版の教訓: data.objects.new の直後は matrix_world が未計算。親の逆行列は単位行列にし、位置は親からの差で置く
    o = bpy.data.objects.new(name, None); o.empty_display_size = size
    col().objects.link(o)
    if parent is not None:
        o.parent = parent; o.matrix_parent_inverse.identity()
        o.location = Vector(loc) - parent.location
    else:
        o.location = loc
    return o

def append_objects(blend, keep=None):
    with bpy.data.libraries.load(blend, link=False) as (src, dst):
        dst.objects = [n for n in src.objects if (keep is None or keep(n))]
    obs = [o for o in dst.objects if o is not None]
    for o in obs:
        if not o.users_collection: col().objects.link(o)
    return obs

def model(blend, loc, rot_z=0.0, scale=1.0, keep=None, height=None, rot_x=0.0):
    """モデルを読み、メッシュだけを 1 つにまとめ、底面の中心を loc に置く（向きは rot_z〈度〉）"""
    obs = append_objects(blend, keep)
    bpy.context.view_layer.update()
    meshes = [o for o in obs if o.type == "MESH"]
    for o in obs:
        if o.type != "MESH": bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    for o in meshes:
        for md in list(o.modifiers):
            try:
                bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier=md.name)
            except RuntimeError:
                o.modifiers.remove(md)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1: bpy.ops.object.join()
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bb = [Vector(c) for c in o.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    s = scale * (height / (mx.z - mn.z) if height else 1.0)
    o.data.transform(__import__("mathutils").Matrix.Translation(-Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))))
    o.scale = (s, s, s); o.rotation_euler = (math.radians(rot_x), 0, math.radians(rot_z)); o.location = loc
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return o

def split_screen(o, name, mat):
    """素材の「画面」の面（素材名に screen を含む）を切り出して name にし、光る素材にする。残りを返す"""
    _sel = [x for x in bpy.context.selected_objects]
    bpy.ops.object.select_all(action="DESELECT"); bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="DESELECT")
    idx = [i for i, sl in enumerate(o.material_slots) if sl.material and "screen" in sl.material.name.lower()]
    for i in idx:
        o.active_material_index = i; bpy.ops.object.material_slot_select()
    bpy.ops.mesh.separate(type="SELECTED"); bpy.ops.object.mode_set(mode="OBJECT")
    scr = [x for x in bpy.context.selected_objects if x is not o][0]
    scr.name = name; scr.data.materials.clear(); scr.data.materials.append(mat)
    return o, scr

def ph(slug):
    return os.path.join(PH, slug, slug + ".blend")

def bk(dirpart):
    return glob.glob(os.path.join(BK, dirpart + "*", "*.blend"))[0]

def decimate(o, ratio):
    if ratio >= 1: return o
    bpy.context.view_layer.objects.active = o
    md = o.modifiers.new("dec", "DECIMATE"); md.ratio = ratio
    bpy.ops.object.modifier_apply(modifier="dec")
    return o

def budget(o, max_tris):
    """面の数が max_tris を超えていれば、超えた分だけ減らす（glb の予算。spec §10）"""
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    return decimate(o, max_tris / n) if n > max_tris else o

def join(name, objs, parent=None, max_tris=None):
    objs = [o for o in objs if o is not None]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1: bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name
    if max_tris: budget(o, max_tris)
    return link(o, parent)

def text_mesh(body, size, loc, rot, mat, extrude=0.004):
    bpy.ops.object.text_add(location=loc, rotation=rot)
    t = bpy.context.active_object; t.data.body = body; t.data.size = size; t.data.extrude = extrude
    t.data.align_x = "CENTER"; t.data.align_y = "CENTER"
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.active_object; o.data.materials.clear(); o.data.materials.append(mat)
    return link(o)

def look(cam, target):
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (Vector(target) - cam.location).to_track_quat("-Z", "Y")

# ---------------------------------------------------------------- 置き方（台に載せる・椅子を向ける・棚に収める・板に貼る）
# 数値の座標だけで置くと、台の高さ・大きさ・椅子の前後の違いで、浮く・めり込む・はみ出す・外を向く（2026-10-29 のユーザーの指摘）。
# 置き方を測って決め、置いた結果を PLACEMENT に残す（build の戻り値。破綻があれば errors に出る）。

PLACEMENT = {"items": {}, "errors": []}

def bounds(o):
    bpy.context.view_layer.update()
    vs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return (Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))),
            Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs))))

def _cast(target, origin, direction):
    bpy.context.view_layer.update()
    inv = target.matrix_world.inverted()
    ok, loc, _n, _i = target.ray_cast(inv @ Vector(origin), (inv.to_3x3() @ Vector(direction)).normalized())
    return (target.matrix_world @ loc) if ok else None

def _scale_by(o, k):
    if k < 1: o.scale = (o.scale.x * k, o.scale.y * k, o.scale.z * k)

def fit_on(o, surface, margin=0.04, round_top=False):
    """o を surface の上面に載せる。上面の枠（外形から margin 内側。丸い天板は内接する正方形）に収まらなければ縮め、内側へ寄せる。
    上面の高さは、o の中心の真下へ光線を落として測る"""
    smn, smx = bounds(surface)
    shrink = 0.7 if round_top else 1.0
    cxs, cys = (smn.x + smx.x) / 2, (smn.y + smx.y) / 2
    hx, hy = (smx.x - smn.x) / 2 * shrink - margin, (smx.y - smn.y) / 2 * shrink - margin
    mn, mx = bounds(o)
    k = min(1.0, (2 * hx) / max(1e-6, mx.x - mn.x), (2 * hy) / max(1e-6, mx.y - mn.y))
    _scale_by(o, k)
    mn, mx = bounds(o)
    o.location.x += max(0.0, (cxs - hx) - mn.x) - max(0.0, mx.x - (cxs + hx))
    o.location.y += max(0.0, (cys - hy) - mn.y) - max(0.0, mx.y - (cys + hy))
    mn, mx = bounds(o)
    hit = _cast(surface, ((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, smx.z + 0.5), (0, 0, -1))
    if hit is None:
        PLACEMENT["errors"].append(f"{o.name}: {surface.name} の上面が見つからない"); return o
    o.location.z += hit.z - mn.z
    PLACEMENT["items"][o.name] = {"on": surface.name, "shrink": round(k, 3), "top": round(hit.z, 3)}
    return o

def face_toward(o, target):
    """椅子の前（背もたれの反対側）を target（x, y）へ向ける。背もたれ＝高さの上 2 割の頂点の重心"""
    bpy.context.view_layer.update()
    vs = [o.matrix_world @ v.co for v in o.data.vertices]
    z0 = min(v.z for v in vs); z1 = max(v.z for v in vs)
    top = [v for v in vs if v.z > z0 + 0.8 * (z1 - z0)]
    mn, mx = bounds(o)
    back = Vector((sum(v.x for v in top) / len(top) - (mn.x + mx.x) / 2, sum(v.y for v in top) / len(top) - (mn.y + mx.y) / 2))
    want = Vector((target[0] - o.location.x, target[1] - o.location.y))
    o.rotation_euler.z += math.atan2(want.y, want.x) - math.atan2(-back.y, -back.x)
    _select_only(o); bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    # 確かめる: 向けた後の前と、target への向きの角度の差
    bpy.context.view_layer.update()
    vs = [o.matrix_world @ v.co for v in o.data.vertices]
    top = [v for v in vs if v.z > z0 + 0.8 * (z1 - z0)]
    mn, mx = bounds(o)
    front = -Vector((sum(v.x for v in top) / len(top) - (mn.x + mx.x) / 2, sum(v.y for v in top) / len(top) - (mn.y + mx.y) / 2))
    err = math.degrees(abs(math.atan2(front.x * want.y - front.y * want.x, front.dot(want))))
    PLACEMENT["items"][o.name] = {"faces": [round(target[0], 2), round(target[1], 2)], "deg_off": round(err, 1)}
    if err > 15: PLACEMENT["errors"].append(f"{o.name}: 前が机へ向いていない（{err:.0f} 度）")
    return o

def shelf_levels(shelf):
    """本棚の段の上面の高さ（中心の真下へ光線を落とし、当たるたびに少し下から続ける）"""
    mn, mx = bounds(shelf); c = ((mn.x + mx.x) / 2, (mn.y + mx.y) / 2)
    levels, z = [], mx.z + 0.5
    for _ in range(12):
        hit = _cast(shelf, (c[0], c[1], z), (0, 0, -1))
        if hit is None: break
        levels.append(hit.z); z = hit.z - 0.03
    return sorted(levels)

def fit_in_shelf(o, shelf, near_z, margin=0.06):
    """o を本棚の段（near_z に近い、高さ 0.2m 以上の段）に収める。段の高さの 85%・棚の内側の幅と奥行きに収まるよう縮める"""
    levels = shelf_levels(shelf); smn, smx = bounds(shelf)
    gaps = [(levels[i], levels[i + 1] - levels[i]) for i in range(len(levels) - 1) if levels[i + 1] - levels[i] > 0.2]
    if not gaps:
        PLACEMENT["errors"].append(f"{o.name}: {shelf.name} の段が見つからない（{levels}）"); return o
    level, gap = min(gaps, key=lambda g: abs(g[0] - near_z))
    mn, mx = bounds(o)
    k = min(1.0, gap * 0.85 / max(1e-6, mx.z - mn.z), (smx.x - smn.x - 2 * margin) / max(1e-6, mx.x - mn.x), (smx.y - smn.y - 2 * margin) / max(1e-6, mx.y - mn.y))
    _scale_by(o, k)
    mn, mx = bounds(o)
    o.location += Vector(((smn.x + smx.x) / 2 - (mn.x + mx.x) / 2, (smn.y + smx.y) / 2 - (mn.y + mx.y) / 2, level - mn.z))
    PLACEMENT["items"][o.name] = {"in": shelf.name, "level": round(level, 3), "gap": round(gap, 3), "shrink": round(k, 3), "levels": [round(v, 2) for v in levels]}
    return o

def fit_on_face(o, board, rel_y, rel_z, margin=0.06):
    """o を板（+x の側が表）の表面に貼る。rel_y・rel_z は板の中心からの位置。板の枠（margin 内側）に収め、表面の位置は光線で測る"""
    bmn, bmx = bounds(board)
    cy, cz = (bmn.y + bmx.y) / 2, (bmn.z + bmx.z) / 2
    hy, hz = (bmx.y - bmn.y) / 2 - margin, (bmx.z - bmn.z) / 2 - margin
    mn, mx = bounds(o)
    _scale_by(o, min(1.0, hy * 0.6 / max(1e-6, mx.y - mn.y), hz * 0.6 / max(1e-6, mx.z - mn.z)))
    mn, mx = bounds(o)
    ty = min(max(cy + rel_y, cy - hy + (mx.y - mn.y) / 2), cy + hy - (mx.y - mn.y) / 2)
    tz = min(max(cz + rel_z, cz - hz + (mx.z - mn.z) / 2), cz + hz - (mx.z - mn.z) / 2)
    hit = _cast(board, (bmx.x + 0.5, ty, tz), (-1, 0, 0))
    if hit is None:
        PLACEMENT["errors"].append(f"{o.name}: {board.name} の表面が見つからない"); return o
    o.location += Vector((hit.x + 0.002 - mn.x, ty - (mn.y + mx.y) / 2, tz - (mn.z + mx.z) / 2))
    PLACEMENT["items"][o.name] = {"on_face": board.name, "x": round(hit.x, 3)}
    return o

def check_inside(items, surface, margin=0.0, round_top=False):
    """items が surface の外形（丸い天板は内接する正方形）の中にあるかを確かめ、外れていれば errors に出す"""
    smn, smx = bounds(surface)
    shrink = 0.7 if round_top else 1.0
    cx, cy = (smn.x + smx.x) / 2, (smn.y + smx.y) / 2
    hx, hy = (smx.x - smn.x) / 2 * shrink - margin + 0.005, (smx.y - smn.y) / 2 * shrink - margin + 0.005
    for o in items:
        mn, mx = bounds(o)
        if mn.x < cx - hx or mx.x > cx + hx or mn.y < cy - hy or mx.y > cy + hy:
            PLACEMENT["errors"].append(f"{o.name}: {surface.name} からはみ出している")

# ---------------------------------------------------------------- 配置

# 置き物（spec §5.2・§5.1 の図）。位置は底面の中心。道（x≈0）の左右に置き、正面を道へ向ける
PROP_AT = {
    # 表札はスタートの左前（入口からの視線から約 30 度。真横〈57 度〉では一人称の画角〈片側 39 度〉に一度も入らず、押せなかった。2026-10-29）
    "nameplate": (-2.1, 1.5),
    "consulting": (-3.3, 4.5),
    "partnership": (3.2, 4.7),
    "envSetup": (-3.3, 7.4),
    "development": (3.3, 7.6),
    "pricing": (-3.2, 10.1),
    "blog": (3.7, 10.2),
    "contact": (2.0, 15.6),
}
AVATAR_AT = (0.0, 2.4)
WALL_X = (-3.7, 0.9); WALL_Y = 12.5
# 道のレール（目の高さ）。入口 → アバターの右 → 置き物のあいだ → 実績の壁の前 → 壁の右を回って相談の席の前
RAIL = [(0, -2.0), (0, 0.4), (1.0, 2.4), (0.5, 4.6), (0.0, 7.4), (0.0, 9.9), (1.2, 11.2), (2.2, 12.4), (2.1, 13.6)]

# ページごとのカメラ（位置・注視点・焦点距離 mm）。名前は lib/pages.ts の STILL_VIEWS
CAMS = {
    "cam_top": ((0, -2.0, EYE), (0, 10, 1.45), 22),
    "cam_services": ((0.2, 2.6, 2.4), (0.0, 9.0, 0.9), 22),
    "cam_service_environment-setup": ((-1.1, 6.1, 1.7), (-3.3, 7.4, 0.95), 26),
    "cam_service_development": ((1.1, 6.3, 1.7), (3.3, 7.6, 0.95), 26),
    "cam_service_consulting": ((-1.0, 3.3, 1.7), (-3.3, 4.5, 1.25), 26),
    "cam_service_partnership": ((1.0, 3.4, 1.8), (3.2, 4.7, 0.8), 26),
    "cam_about": ((-0.4, -1.6, 1.5), (-1.0, 2.0, 1.15), 26),
    "cam_pricing": ((-1.2, 9.0, 1.65), (-3.2, 10.1, 0.75), 28),
    "cam_blog": ((1.3, 9.0, 1.7), (3.7, 10.2, 1.1), 26),
    "cam_contact": ((2.1, 12.9, 1.75), (2.0, 15.6, 0.55), 26),
    "cam_contactThanks": ((2.7, 14.1, 1.35), (2.0, 15.6, 0.45), 30),
    "cam_accessibility": ((-1.4, 9.4, 1.65), (-1.4, 12.4, 1.6), 24),
}

def build():
    PLACEMENT["items"].clear(); PLACEMENT["errors"].clear()
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for c in list(bpy.data.collections): bpy.data.collections.remove(c)
    for blk in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.curves, bpy.data.lights):
        for x in list(blk): blk.remove(x)
    for i in list(bpy.data.images):
        if i.users == 0 or i.name.startswith(("bake_", "ao_")): bpy.data.images.remove(i)
    c = bpy.data.collections.new("atelier"); bpy.context.scene.collection.children.link(c)

    # 素材
    WOOD = tiled_mat("floor_wood", os.path.join(ACG, "WoodFloor051", "1K-JPG", "WoodFloor051_1K-JPG_Color.jpg"), 0.55)
    CONC = tiled_mat("concrete", os.path.join(PH, "concrete_wall_008", "textures", "concrete_wall_008_diff_1k.jpg"), 0.85)
    # 天井は壁と同じコンクリート（concrete_floor_02 の 1k は細かすぎて WebP でも 340KB になる）
    CEIL = tiled_mat("concrete_ceiling", os.path.join(PH, "concrete_wall_008", "textures", "concrete_wall_008_diff_1k.jpg"), 0.9, tint=(0.82, 0.82, 0.82, 1))
    STEEL = flat_mat("steel", (0.035, 0.037, 0.04, 1), 0.45, 0.85)
    GLASS = flat_mat("skylight_glass", (0.85, 0.92, 0.97, 1), 0.05, 0.0, alpha=0.12)
    PAPER = bpy.data.materials.new("paper"); _, pb = bsdf_of(PAPER)
    pt = PAPER.node_tree.nodes.new("ShaderNodeTexImage")
    pt.image = bpy.data.images.load(os.path.join(ACG, "Paper004", "1K-JPG", "Paper004_1K-JPG_Color.jpg"), check_existing=True)
    PAPER.node_tree.links.new(pt.outputs["Color"], pb.inputs["Base Color"]); pb.inputs["Roughness"].default_value = 0.9
    OAK = flat_mat("oak", (0.42, 0.27, 0.15, 1), 0.55)
    BRAND = flat_mat("brand_blue", (0.0065, 0.29, 0.81, 1), 0.5)
    INK = flat_mat("ink", (0.03, 0.03, 0.035, 1), 0.6)
    BLUEPRINT = flat_mat("blueprint", (0.05, 0.18, 0.42, 1), 0.8)
    SCREEN = flat_mat("screen", (0.02, 0.03, 0.05, 1), 0.25, 0.0, emit=(0.30, 0.55, 0.95, 1))
    FRAME_BLANK = flat_mat("frame_blank", (0.93, 0.92, 0.89, 1), 0.9)

    # 部屋（床・壁・天井・天窓）
    (x0, x1), (y0, y1), H = ROOM["x"], ROOM["y"], ROOM["h"]
    cx, cy, w, d = (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0
    box("room_floor", (w, d, 0.1), (cx, cy, -0.05), WOOD)
    walls = [
        box("room_wall_l", (0.3, d, H), (x0 - 0.15, cy, H / 2), CONC),
        box("room_wall_r", (0.3, d, H), (x1 + 0.15, cy, H / 2), CONC),
        box("room_wall_b", (w + 0.6, 0.3, H), (cx, y1 + 0.15, H / 2), CONC),
        box("room_wall_f", (w + 0.6, 0.3, H), (cx, y0 - 0.15, H / 2), CONC),
    ]
    join("room_walls", walls)
    (sx0, sx1), (sy0, sy1) = SKY["x"], SKY["y"]
    slabs = [
        box("ceil_l", (sx0 - x0, d, 0.3), ((x0 + sx0) / 2, cy, H + 0.15), CEIL),
        box("ceil_r", (x1 - sx1, d, 0.3), ((sx1 + x1) / 2, cy, H + 0.15), CEIL),
        box("ceil_f", (sx1 - sx0, sy0 - y0, 0.3), (0, (y0 + sy0) / 2, H + 0.15), CEIL),
        box("ceil_b", (sx1 - sx0, y1 - sy1, 0.3), (0, (sy1 + y1) / 2, H + 0.15), CEIL),
    ]
    join("room_ceiling", slabs)
    box("room_partition", (WALL_X[1] - WALL_X[0], 0.2, 3.4), ((WALL_X[0] + WALL_X[1]) / 2, WALL_Y, 1.7), CONC)
    # 天窓のガラスと鉄の枠（枠は飾りとしてまとめて焼く）
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, (sy0 + sy1) / 2, H + 0.25))
    g = bpy.context.active_object; g.name = "skylight_glass"; g.scale = (sx1 - sx0, sy1 - sy0, 1)
    bpy.ops.object.transform_apply(scale=True); g.data.materials.append(GLASS); link(g)
    mull = [box(f"mull_y{i}", (0.08, sy1 - sy0, 0.18), (sx0 + i * (sx1 - sx0) / 3, (sy0 + sy1) / 2, H + 0.2), STEEL) for i in range(4)]
    mull += [box(f"mull_x{i}", (sx1 - sx0, 0.08, 0.18), (0, sy0 + i * 2.0, H + 0.2), STEEL) for i in range(9)]

    # 鉄の枠とランプのコードは焼かず、無地の金属のまま（細長い面が焼き込みの絵の面積を食うため）
    steel = list(mull)
    decor = []
    props = {}
    def prop(pid, loc):
        e = empty(f"prop_{pid}", (loc[0], loc[1], 0)); props[pid] = e; return e

    # 会社の表札（スタートの脇）: 木の板に ComeGin、柱 2 本
    p = prop("nameplate", PROP_AT["nameplate"]); x, y = PROP_AT["nameplate"]
    parts = [box("np_board", (1.1, 0.06, 0.42), (x, y, 1.15), OAK, bevel=0.01),
             box("np_post_l", (0.06, 0.06, 1.0), (x - 0.42, y, 0.5), INK),
             box("np_post_r", (0.06, 0.06, 1.0), (x + 0.42, y, 0.5), INK),
             box("np_mark", (0.12, 0.012, 0.12), (x - 0.38, y - 0.035, 1.15), BRAND),
             text_mesh("ComeGin", 0.17, (x + 0.08, y - 0.04, 1.15), (math.radians(90), 0, 0), INK)]
    pl = decimate(model(ph("potted_plant_02"), (x + 0.95, y + 0.2, 0), 0, height=0.7), 0.12)
    join("prop_nameplate_mesh", parts + [pl], p, max_tris=PROP_TRIS)
    p.rotation_euler = (0, 0, math.radians(-35))  # 入口の方へ向ける

    # コンサルティング: 自立式のホワイトボード（板と付箋は BlenderKit。脚は自作）。付箋は板の表面の枠に収めて貼る
    p = prop("consulting", PROP_AT["consulting"]); x, y = PROP_AT["consulting"]
    wb = model(bk("whiteboard"), (x, y, 1.0), 90, scale=1.45, rot_x=90)  # 素材は寝かせて作られている（メッシュに X −90 度）
    wmn, wmx = bounds(wb)
    legs = [box(f"wb_leg{i}", (0.04, 0.04, wmx.z + 0.03), (wmn.x - 0.02, yy, (wmx.z + 0.03) / 2), INK) for i, yy in enumerate((wmn.y - 0.03, wmx.y + 0.03))]
    feet = [box(f"wb_foot{i}", (0.55, 0.05, 0.04), (wmn.x - 0.02, yy, 0.02), INK) for i, yy in enumerate((wmn.y - 0.03, wmx.y + 0.03))]
    notes = [fit_on_face(model(bk("sticky-notes"), (x, y, 1.4), 90 + rz, rot_x=90), wb, ry, rzz)
             for ry, rzz, rz in ((-0.42, 0.12, 4), (0.02, -0.05, -3), (0.4, 0.1, 2))]
    join("prop_consulting_mesh", [wb] + legs + feet + notes, p, max_tris=PROP_TRIS)

    # 協業: 大きな共同の机・机を向く二脚の椅子・机の上の紙の模型
    p = prop("partnership", PROP_AT["partnership"]); x, y = PROP_AT["partnership"]
    tb = model(ph("round_wooden_table_01"), (x, y, 0), 0, height=0.76)
    tmn, tmx = bounds(tb); r = (tmx.x - tmn.x) / 2 + 0.32
    chairs = []
    for ang in (205, 255):  # 道の側（-x・-y）から机を囲む
        c = decimate(model(ph("WoodenChair_01"), (x + r * math.cos(math.radians(ang)), y + r * math.sin(math.radians(ang)), 0), 0, height=0.95), 0.15)
        chairs.append(face_toward(c, (x, y)))
    mk = [fit_on(box(f"pm_{i}", (sx_, sy_, sz_), (x + ox, y + oy, 1.0), PAPER), tb, margin=0.05, round_top=True)
          for i, (sx_, sy_, sz_, ox, oy) in enumerate([(0.22, 0.16, 0.26, -0.1, 0.05), (0.14, 0.2, 0.16, 0.14, 0.12), (0.3, 0.12, 0.08, 0.05, -0.18)])]
    check_inside(mk, tb, round_top=True)
    join("prop_partnership_mesh", [tb] + chairs + mk, p, max_tris=PROP_TRIS)

    # 環境構築: 鉄の机・3 枚の画面（BlenderKit）・ノート PC。画面の面は切り出して光らせる（夜は画面の明かりが灯る。spec §5.3）
    p = prop("envSetup", PROP_AT["envSetup"]); x, y = PROP_AT["envSetup"]
    dk = model(ph("metal_office_desk"), (x, y, 0), 90, height=0.79)
    mons, screens = [], []
    for i, (oy, rz) in enumerate(((-0.6, 18), (0, 0), (0.6, -18))):
        m_ = fit_on(model(bk("office-monitor-h"), (x - 0.12 + abs(oy) * 0.12, y + oy, 1.0), 90 + rz), dk, margin=0.03)
        m_, sc = split_screen(m_, f"screen_{i:02d}", SCREEN); mons.append(m_); screens.append(sc)
    lp = fit_on(model(ph("classic_laptop"), (x + 0.22, y - 0.55, 1.0), 110, height=0.3), dk, margin=0.05)
    check_inside(mons + [lp], dk)
    join("prop_envSetup_mesh", [dk, lp] + mons, p, max_tris=PROP_TRIS)
    for sc in screens: link(sc, p)

    # 受託開発: 木の作業台・ノート PC（BlenderKit）・設計図・メモ帳（すべて天板の上に載せる）
    p = prop("development", PROP_AT["development"]); x, y = PROP_AT["development"]
    top = box("dv_top", (0.85, 1.7, 0.05), (x, y, 0.75), OAK, bevel=0.008)
    legs = [box(f"dv_leg{i}", (0.05, 0.05, 0.73), (x + sx_ * 0.36, y + sy_ * 0.78, 0.365), INK) for i, (sx_, sy_) in enumerate(((-1, -1), (-1, 1), (1, -1), (1, 1)))]
    lap = fit_on(model(bk("laptop-14-inches"), (x - 0.05, y - 0.35, 1.0), -100), top, margin=0.05)
    lap, lsc = split_screen(lap, "screen_03", SCREEN); link(lsc, p)
    bp = [fit_on(box(f"dv_bp{i}", (0.42, 0.6, 0.002), (x + 0.02 * i, y + 0.35 + 0.03 * i, 1.0), BLUEPRINT, rot=(0, 0, math.radians(8 * i - 6))), top, margin=0.03) for i in range(2)]
    bp[1].location.z += 0.002  # 2 枚目は 1 枚目の上に重ねる
    pads = fit_on(model(ph("office_notepads"), (x + 0.2, y - 0.62, 1.0), -80), top, margin=0.03)
    check_inside([lap, pads] + bp, top)
    join("prop_development_mesh", [top, lap, pads] + legs + bp, p, max_tris=PROP_TRIS)

    # 料金: 机と見積もりの紙（クリップボード・ホッチキス・紙・小さな鉢。すべて天板の上に載せる）
    p = prop("pricing", PROP_AT["pricing"]); x, y = PROP_AT["pricing"]
    t = model(ph("small_wooden_table_01"), (x, y, 0), 90, height=0.74)
    cb = fit_on(model(ph("clipboard"), (x + 0.05, y - 0.15, 1.0), 80), t)
    sp = fit_on(model(ph("vintage_stapler"), (x + 0.05, y + 0.28, 1.0), 30), t)
    est = [fit_on(box(f"pr_sheet{i}", (0.21, 0.297, 0.002), (x + 0.08, y + 0.12 + 0.02 * i, 1.0), PAPER, rot=(0, 0, math.radians(5 + 7 * i))), t, margin=0.03) for i in range(2)]
    est[1].location.z += 0.002
    pt4 = fit_on(model(ph("potted_plant_04"), (x - 0.12, y + 0.45, 1.0)), t)
    check_inside([cb, sp, pt4] + est, t)
    join("prop_pricing_mesh", [t, cb, sp, pt4] + est, p, max_tris=PROP_TRIS)

    # 記事: 本棚と本（本は段の上に、段の高さ・棚の内側に収める）
    p = prop("blog", PROP_AT["blog"]); x, y = PROP_AT["blog"]
    sh = model(ph("wooden_bookshelf_worn"), (x, y, 0), 90, height=2.0)
    books = []
    for near in (1.05, 0.55):
        b = model(ph("book_encyclopedia_set_01"), (x, y, 1.0), 90, keep=lambda n: "stash" not in n.lower())
        books.append(decimate(fit_in_shelf(b, sh, near), 0.15))
    join("prop_blog_mesh", [sh] + books, p, max_tris=PROP_TRIS)

    # 相談の席（行き止まり）: 低い机・机を向いて向かい合う二脚・吊りランプ。thanks_tea は送信完了の静止画だけに見せる
    p = prop("contact", PROP_AT["contact"]); x, y = PROP_AT["contact"]
    ct = model(ph("modern_coffee_table_01"), (x, y, 0), 90, height=0.42)
    a1 = face_toward(decimate(model(ph("modern_arm_chair_01"), (x - 1.0, y, 0)), 0.4), (x, y))
    a2 = face_toward(decimate(model(ph("modern_arm_chair_01"), (x + 1.0, y, 0)), 0.4), (x, y))
    hl = decimate(model(ph("hanging_industrial_lamp"), (x, y, 2.0), 0, height=0.9), 0.5)
    # お茶はセットのうち急須と湯のみ 2 つだけを、1 つずつ机の上に置く（セットの並びのままでは机に収まらず、縮めると湯のみが不自然に小さくなる）。
    # 急須は中央、湯のみは向かい合う二人の前（x の ±）
    pieces = [fit_on(model(ph("tea_set_01"), (x + ox, y + oy, 1.0), rz, keep=lambda n, k=k: n.endswith(k) or n.endswith(k + "_lid")), ct, margin=0.06)
              for k, ox, oy, rz in (("teapot_01", 0.0, 0.05, 20), ("cup_small_01", -0.17, -0.12, 0), ("cup_small_02", 0.17, -0.1, 0))]
    for o in pieces:
        if PLACEMENT["items"].get(o.name, {}).get("shrink", 1) < 0.99:
            PLACEMENT["errors"].append(f"{o.name}: 机に収まらず縮んだ")
    tea = budget(join("thanks_tea_tmp", pieces), 2000)
    check_inside([tea], ct, margin=0.05)
    join("prop_contact_mesh", [ct, a1, a2, hl], p, max_tris=PROP_TRIS)
    tea.name = "thanks_tea"; link(tea, p)

    # 実績の展示の壁: 額の枠（木）と、貼り替える板 frame_00〜06（UV は 0〜1・正面から見て左下が 0,0）
    wx = (WALL_X[0] + WALL_X[1]) / 2
    p = prop("wall", (wx, WALL_Y - 0.1)); borders = []
    for i in range(7):
        fx = wx + (i - 3) * 0.62; fy = WALL_Y - 0.11
        borders.append(box(f"fr_b{i}", (0.56, 0.03, 0.71), (fx, fy + 0.005, 1.65), OAK, bevel=0.004))
        bpy.ops.mesh.primitive_plane_add(size=1, location=(fx, fy - 0.012, 1.65), rotation=(math.radians(90), 0, 0))
        f = bpy.context.active_object; f.name = f"frame_{i:02d}"; f.scale = (0.48, 0.63, 1)
        # 大きさだけを当てる（transform_apply の既定は位置・回転も当て、板の座標が世界の座標になって UV が潰れた。2026-10-29）
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        f.data.materials.append(FRAME_BLANK)
        uvl = f.data.uv_layers.active.data
        for poly in f.data.polygons:
            for li in poly.loop_indices:
                v = f.data.vertices[f.data.loops[li].vertex_index].co
                uvl[li].uv = (v.x / 0.48 + 0.5, v.y / 0.63 + 0.5)  # 板の X → 世界の X（右）、板の Y → 世界の Z（上）
        link(f, p)
    join("prop_wall_mesh", borders, p, max_tris=PROP_TRIS)

    # アバター（置かない。立たせる点と、押すボタンの点だけ）
    pa = prop("avatar", AVATAR_AT)
    empty("avatar_spot", (AVATAR_AT[0], AVATAR_AT[1], 0))

    # 飾り: 植物・通り道の吊りランプ
    # 植物は葉が細かい島に分かれるので、家具と分けて焼く（同じ絵にすると島の余白で家具がつぶれる）
    plants = [decimate(model(ph("potted_plant_01"), (3.4, -1.6, 0), 30, height=1.3), 0.1),
              decimate(model(ph("pachira_aquatica_01"), (3.7, 16.6, 0), 0, height=1.9), 0.12),
              decimate(model(ph("potted_plant_01"), (-3.9, 14.5, 0), -40, height=1.2), 0.1)]
    cab = decimate(model(ph("modern_wooden_cabinet"), (-4.15, 1.6, 0), 90), 0.3)
    decor.append(cab)
    decor.append(model(ph("steel_frame_shelves_01"), (4.15, 1.2, 0), -90))
    decor.append(decimate(fit_on(model(ph("potted_plant_04"), (-4.1, 1.0, 1.0), 0), cab), 0.5))
    plants.append(decimate(model(ph("potted_plant_02"), (-4.0, 6.0, 0), 0, height=0.8), 0.12))
    pend = [(0.0, 4.6), (0.0, 7.4), (0.0, 10.1)]
    for i, (px, py) in enumerate(pend):
        decor.append(decimate(model(ph("hanging_industrial_lamp"), (px, py, 2.9), 0, height=0.8), 0.5))
        steel.append(box(f"cord_{i}", (0.012, 0.012, H - 3.7), (px, py, 3.7 + (H - 3.7) / 2), INK))
    join("decor_mesh", decor, max_tris=7000)
    join("decor_plants", plants, max_tris=8000)
    join("decor_steel", steel)

    # ランプの光の位置（コードが点光源を置く）
    lamps = [(PROP_AT["contact"][0], PROP_AT["contact"][1], 1.95)] + [(px, py, 2.85) for px, py in pend] + \
            [(PROP_AT["envSetup"][0] + 0.4, PROP_AT["envSetup"][1], 1.3), (PROP_AT["development"][0] - 0.4, PROP_AT["development"][1], 1.3)]
    for i, l in enumerate(lamps): empty(f"lamp_{i:02d}", l)

    # 押すボタンの点（置き物の上の少し上）
    anchors = {"nameplate": 1.6, "consulting": 2.1, "partnership": 1.3, "envSetup": 1.45, "development": 1.15,
               "pricing": 1.15, "blog": 2.25, "contact": 1.1, "wall": 2.55, "avatar": 1.95}
    for pid, z in anchors.items():
        e = props[pid]
        empty(f"anchor_{pid}", (e.location.x, e.location.y, z), parent=e)

    # レール
    for i, (rx, ry) in enumerate(RAIL): empty(f"rail_{i:02d}", (rx, ry, EYE))

    # カメラ
    for name, (loc, target, lens) in CAMS.items():
        cd = bpy.data.cameras.new(name); cd.lens = lens; cd.sensor_width = 36; cd.sensor_fit = "HORIZONTAL"
        cd.clip_start = 0.05; cd.clip_end = 60
        cam = bpy.data.objects.new(name, cd); col().objects.link(cam); cam.location = loc; look(cam, target)
    bpy.context.scene.camera = bpy.data.objects["cam_top"]
    bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y = 1600, 900
    bpy.ops.object.select_all(action="DESELECT")
    return {"tris": sum(sum(len(pp.vertices) - 2 for pp in o.data.polygons) for o in col().objects if o.type == "MESH"),
            "placement": PLACEMENT}

# ---------------------------------------------------------------- 焼き込み

PROP_BAKE = {"nameplate": 512, "consulting": 1024, "partnership": 1024, "envSetup": 1024, "development": 1024,
             "pricing": 1024, "blog": 1024, "contact": 1024, "wall": 512}
ROOM_AO = {"room_floor": 1024, "room_walls": 1024, "room_ceiling": 512, "room_partition": 512}

def _select_only(o):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = o; o.select_set(True)

def _new_uv(o, name, keep_first=False, margin=0.012):
    if not keep_first:
        while o.data.uv_layers: o.data.uv_layers.remove(o.data.uv_layers[0])
    uv = o.data.uv_layers.get(name) or o.data.uv_layers.new(name=name)
    o.data.uv_layers.active = uv
    _select_only(o)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=margin)
    # smart_project だけでは隙間が多い（本棚で UV の 20%）。島の大きさをそろえて詰め直す（同 44%）
    bpy.ops.uv.select_all(action="SELECT"); bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, margin_method="FRACTION", margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")
    return uv

def _target(o, im):
    for slot in o.material_slots:
        if not slot.material: continue
        nt = slot.material.node_tree
        n = nt.nodes.get("BAKE") or nt.nodes.new("ShaderNodeTexImage")
        n.name = "BAKE"; n.image = im
        for x in nt.nodes: x.select = False
        n.select = True; nt.nodes.active = n

def _clear_target(o):
    for slot in o.material_slots:
        if slot.material and slot.material.node_tree.nodes.get("BAKE"):
            slot.material.node_tree.nodes.remove(slot.material.node_tree.nodes["BAKE"])

def _img(name, size):
    im = bpy.data.images.get(name)
    if im and tuple(im.size) != (size, size): bpy.data.images.remove(im); im = None
    return im or bpy.data.images.new(name, size, size, alpha=False)

def _multiply(albedo, ao, floor=0.35):
    import numpy as np
    a = np.empty(len(albedo.pixels), dtype=np.float32); albedo.pixels.foreach_get(a)
    b = np.empty(len(ao.pixels), dtype=np.float32); ao.pixels.foreach_get(b)
    k = floor + (1 - floor) * b
    a[0::4] *= k[0::4]; a[1::4] *= k[0::4]; a[2::4] *= k[0::4]
    albedo.pixels.foreach_set(a); albedo.update()

def _unmetal(o):
    """DIFFUSE の色の焼き込みは金属の色を黒にする（金属は拡散の色を持たない）。焼く間だけ Metallic を 0 にし、戻す関数を返す"""
    saved = []
    for slot in o.material_slots:
        m = slot.material
        if not m or not m.node_tree: continue
        for n in m.node_tree.nodes:
            if n.type != "BSDF_PRINCIPLED": continue
            sock = n.inputs["Metallic"]
            links = [(l.from_socket, l.to_socket) for l in sock.links]
            for l in list(sock.links): m.node_tree.links.remove(l)
            saved.append((m, sock, sock.default_value, links)); sock.default_value = 0.0
    def restore():
        for m, sock, v, links in saved:
            sock.default_value = v
            for a, b in links: m.node_tree.links.new(a, b)
    return restore

def bake_prop(name, size):
    o = bpy.data.objects[name]
    _new_uv(o, "UVMap", margin=0.0015 if name == "decor_plants" else 0.012)
    restore_metal = _unmetal(o)
    alb = _img(f"bake_{name}", size); ao = _img(f"aotmp_{name}", size)
    _select_only(o); _target(o, alb)
    bpy.context.scene.cycles.samples = 4
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=8)
    _target(o, ao)
    bpy.context.scene.cycles.samples = 48
    bpy.ops.object.bake(type="AO", margin=8)
    _multiply(alb, ao); bpy.data.images.remove(ao)
    _clear_target(o)
    restore_metal()

def bake_room_ao(name, size):
    o = bpy.data.objects[name]
    if not o.data.uv_layers.get("UVMap"):
        # 色の UV: 世界の大きさに合わせて 2m ごとに繰り返す（箱の投影）
        uv = o.data.uv_layers.new(name="UVMap"); o.data.uv_layers.active = uv
        _select_only(o); bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.cube_project(cube_size=2.0 if "floor" not in name else 2.5, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")
    uv = _new_uv(o, "UV_AO", keep_first=True)
    ao = _img(f"ao_{name}", size)
    _select_only(o); _target(o, ao)
    bpy.context.scene.cycles.samples = 48
    bpy.ops.object.bake(type="AO", margin=8)
    _clear_target(o)
    o.data.uv_layers.active = o.data.uv_layers["UVMap"]
    o.data.uv_layers["UVMap"].active_render = True

def bake(names=None):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"; scene.cycles.samples = 64; scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.refresh_devices()
        gpu = [d for d in prefs.devices if d.type != "CPU"]
        if gpu:
            prefs.compute_device_type = gpu[0].type
            for d in prefs.devices: d.use = True
            scene.cycles.device = "GPU"
        else:
            scene.cycles.device = "CPU"
    except Exception:
        scene.cycles.device = "CPU"
    w = scene.world or bpy.data.worlds.new("World"); scene.world = w; w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == "BACKGROUND"); bg.inputs[0].default_value = (1, 1, 1, 1); bg.inputs[1].default_value = 1.0
    w.light_settings.distance = 0.9
    done = []
    for pid, size in PROP_BAKE.items():
        n = f"prop_{pid}_mesh"
        if names is None or n in names: bake_prop(n, size); done.append(n)
    if names is None or "decor_mesh" in names: bake_prop("decor_mesh", 1024); done.append("decor_mesh")
    for n, size in ROOM_AO.items():
        if names is None or n in names: bake_room_ao(n, size); done.append(n)
    return done

def apply_baked():
    for o in col().objects:
        if o.type != "MESH": continue
        im = bpy.data.images.get(f"bake_{o.name}")
        if im:
            rough = 0.75
            mat = bpy.data.materials.get(f"baked_{o.name}") or bpy.data.materials.new(f"baked_{o.name}")
            nt, b = bsdf_of(mat)
            t = nt.nodes.get("TEX") or nt.nodes.new("ShaderNodeTexImage"); t.name = "TEX"; t.image = im
            nt.links.new(t.outputs["Color"], b.inputs["Base Color"]); b.inputs["Roughness"].default_value = rough
            o.data.materials.clear(); o.data.materials.append(mat)
            while len(o.data.uv_layers) > 1: o.data.uv_layers.remove(o.data.uv_layers[-1])
        ao = bpy.data.images.get(f"ao_{o.name}")
        if ao:
            # 同じ素材（コンクリート）を壁と仕切りが共有するので、面ごとに素材を複製してから AO を付ける
            for slot in o.material_slots:
                if not slot.material.name.endswith(o.name):
                    slot.material = slot.material.copy(); slot.material.name = f"{slot.material.name.split('.')[0]}_{o.name}"
                attach_ao(slot.material, ao)

# ---------------------------------------------------------------- 書き出し

def _export(path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in col().objects: o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_cameras=True, export_lights=False,
        export_image_format="WEBP", export_image_quality=78, export_apply=True, export_yup=True,
        export_draco_mesh_compression_enable=False, export_meshopt_compression_enable=True, export_extras=False,
        export_texcoords=True, export_normals=True, export_materials="EXPORT",
    )
    return os.path.getsize(path)

def _half_images():
    """Mobile 用: 使っている画像を半分の解像度の複製に差し替え、元に戻す関数を返す"""
    swaps = []
    for m in bpy.data.materials:
        if not m.node_tree: continue
        for n in m.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image and n.image.size[0] >= 256:
                src = n.image
                half = bpy.data.images.get(src.name + "_half")
                if not half:
                    half = src.copy(); half.name = src.name + "_half"
                    half.scale(max(1, src.size[0] // 2), max(1, src.size[1] // 2)); half.pack()
                swaps.append((n, src)); n.image = half
    def restore():
        for n, src in swaps: n.image = src
    return restore

def export():
    apply_baked()
    os.makedirs(OUT, exist_ok=True)
    out = {"atelier.glb": _export(os.path.join(OUT, "atelier.glb"))}
    restore = _half_images()
    # Mobile: 焼いた置き物と飾りの面を、書き出しのときだけ減らす（export_apply が modifier を当てる。.blend の形は変えない）
    mods = []
    for o in col().objects:
        if o.type == "MESH" and (o.name.endswith("_mesh") or o.name == "thanks_tea"):
            md = o.modifiers.new("mobile_dec", "DECIMATE"); md.ratio = MOBILE_RATIO; mods.append((o, md))
    try:
        out["atelier-mobile.glb"] = _export(os.path.join(OUT, "atelier-mobile.glb"))
    finally:
        restore()
        for o, md in mods: o.modifiers.remove(md)
    return out

# ---------------------------------------------------------------- 空（朝・昼・夕方。夜は three で描く）

SKIES = {"morning": "qwantani_morning_puresky", "day": "kloofendal_48d_partly_cloudy_puresky", "dusk": "belfast_sunset_puresky"}
# 夕方: 天窓から見えるのは真上の空だけ。qwantani_sunset は真上が白っぽい青で夕方に見えないので、雲が紫に染まる belfast_sunset にした（2026-10-29）

def sky():
    scene = bpy.context.scene
    scene.view_settings.view_transform = "AgX"; scene.view_settings.look = "None"; scene.view_settings.exposure = 0.0
    scene.render.image_settings.file_format = "PNG"; scene.render.image_settings.color_depth = "8"
    out = {}
    import requests
    from polyhavenassets.utils.download_file import download_file
    for phase, slug in SKIES.items():
        # アドオンが取り込むのは 1k（1024×512）だけ。空は 2048×1024 で配るので、同じ Poly Haven の 2k をアドオンの取得関数で取る
        files = requests.get(f"https://api.polyhaven.com/files/{slug}", timeout=30).json()
        f2k = files["hdri"]["2k"]["hdr"]
        hdr = os.path.join(PH, slug, os.path.basename(f2k["url"]))
        if not os.path.exists(hdr): download_file(f2k["url"], __import__("pathlib").Path(hdr), f2k["md5"])
        im = bpy.data.images.load(hdr, check_existing=True)
        path = os.path.join(OUT, f"sky_{phase}.png")
        im.save_render(path, scene=scene)
        out[phase] = {"src": os.path.basename(hdr), "size": list(im.size), "bytes": os.path.getsize(path)}
    return out

def bake_async(names=None):
    """bake() を 1 つずつ bpy.app.timers で進める。進み具合は driver_namespace["atelier_bake"]"""
    bake_setup = globals()["bake"]
    queue = [f"prop_{pid}_mesh" for pid in PROP_BAKE] + ["decor_mesh", "decor_plants", "thanks_tea"] + list(ROOM_AO)
    if names: queue = [n for n in queue if n in names]
    st = bpy.app.driver_namespace["atelier_bake"] = {"queue": list(queue), "done": [], "error": None, "t0": time.time()}
    bake_setup([])  # 設定だけ（空の名前の一覧なので何も焼かない）
    def step():
        if not st["queue"]: st["sec"] = round(time.time() - st["t0"], 1); return None
        n = st["queue"].pop(0)
        try:
            if n in ROOM_AO: bake_room_ao(n, ROOM_AO[n])
            else: bake_prop(n, {"decor_mesh": 1024, "decor_plants": 1024, "thanks_tea": 512}.get(n) or PROP_BAKE[n[5:-5]])
            st["done"].append(n)
        except Exception as e:
            st["error"] = f"{n}: {e!r}"; return None
        return 0.2
    bpy.app.timers.register(step, first_interval=0.5)
    return queue

_t = time.time(); _out = {}
if "build" in STAGES: _out["built"] = build()
if "bake" in STAGES: _out["baked"] = bake(globals().get("BAKE_NAMES"))
if "bake_async" in STAGES: _out["queued"] = bake_async(globals().get("BAKE_NAMES"))
if "export" in STAGES: _out["glb_bytes"] = export()
if "sky" in STAGES: _out["sky"] = sky()
_out["sec"] = round(time.time() - _t, 1)
result = _out
