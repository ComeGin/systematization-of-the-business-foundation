// VRM（GLB）の軽量化。`pnpm avatar:slim` で動かす（Task 9）。
// - 原本: assets-original/avatar/亀谷銀大_VRoid.vrm（追跡しない）→ 出力: src/modules/avatar/assets/avatar.vrm（配信する）
// - 埋め込みの PNG・JPEG を sharp で縮め（長い辺を --max、既定 768）、bufferViews を詰め直す。
//   どこからも参照されていない accessor（Blender の書き出しが残す、targets に載っていないモーフの法線など）は、
//   描画に使われないので詰め直しのときに落とす（頂点・モーフ・骨は減らさない）。
// - モーフ（表情のキー）の POSITION は、動く頂点だけを持つ疎の accessor（sparse）に直す。値はそのまま（ロスレス）。
//   書き出す前に、表情 happy を weight 1 で当てたときのモーフ後の頂点の位置が原本と一致することを確かめる。
// - メタ情報は applyMetaLicense で「作者だけ・再配布不可・非営利」にする。誰でもダウンロードできる場所に置くため、
//   第三者の再利用を許さない旨をファイル自身に記す（ダウンロードを妨げるものではない。U-11）。
// - VRM の拡張（表情・揺れもの・lookAt・springBone・constraints）の JSON は meta 以外を変えない。書き出しの前に
//   突き合わせ、書き出した後に three-vrm で原本と出力を読み直して、骨・表情・揺れものの数が同じことを確かめる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 既定のテクスチャの長い辺。★ は 1024 だが、1024・768 とも 6MB を超えたため、モーフを疎にする（R14 の案 A）のと
 * 組み合わせて 768 にした（表示は最大で高さ 280px なので 768 で足りる。2026-10-19）。
 */
export const DEFAULT_MAX = 768;

/** 大きさの上限（10 進の MB で数える。厳しい側）: 目標 4MB・必須 6MB */
const LIMIT_TARGET = 4_000_000;
const LIMIT_REQUIRED = 6_000_000;

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/**
 * テクスチャの縮小後の大きさを決める。長い辺を max に収め、縦横比を保つ。max 以下のものは変えない。
 * @param {number} width
 * @param {number} height
 * @param {number} max
 * @returns {{ width: number; height: number }}
 */
export function planTextureSize(width, height, max) {
  for (const [label, value] of [
    ["width", width],
    ["height", height],
    ["max", max],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(
        `planTextureSize: ${label} は 0 より大きい数にする（${value}）`,
      );
    }
  }
  const longer = Math.max(width, height);
  if (longer <= max) return { width, height };
  const scale = max / longer;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * VRM のメタ情報を「作者だけ・再配布不可・非営利」にする。1.0（VRMC_vrm）と 0.x（VRM）の両方に対応する。
 * ほかの値はそのまま。入力は書き換えず、新しいオブジェクトを返す。
 * @param {object} json glTF の JSON
 * @returns {object}
 */
export function applyMetaLicense(json) {
  const out = structuredClone(json);
  const ext = /** @type {any} */ (out).extensions;
  const meta1 = ext?.VRMC_vrm?.meta;
  if (meta1) {
    meta1.avatarPermission = "onlyAuthor";
    meta1.allowRedistribution = false;
    meta1.commercialUsage = "personalNonProfit";
  }
  const meta0 = ext?.VRM?.meta;
  if (meta0) {
    meta0.allowedUserName = "OnlyAuthor";
    meta0.commercialUssageName = "Disallow"; // 0.x の仕様の綴り（Ussage）のまま
    meta0.licenseName = "Redistribution_Prohibited";
  }
  return out;
}

/**
 * GLB を JSON と BIN に分ける。
 * @param {Buffer} buffer
 * @returns {{ json: any; bin: Buffer }}
 */
export function parseGlb(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error("parseGlb: GLB ではない（先頭が glTF でない）");
  }
  if (buffer.readUInt32LE(4) !== 2)
    throw new Error("parseGlb: glTF 2.0 だけを扱う");
  const total = buffer.readUInt32LE(8);
  let offset = 12;
  /** @type {any} */
  let json;
  /** @type {Buffer | undefined} */
  let bin;
  while (offset < total) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString("utf8"));
    else if (type === CHUNK_BIN && bin === undefined) bin = body;
    offset += 8 + length;
  }
  if (!json) throw new Error("parseGlb: JSON のチャンクが無い");
  return { json, bin: bin ?? Buffer.alloc(0) };
}

/** 4 バイト境界に揃えるための詰め物の長さ */
function pad4(length) {
  return (4 - (length % 4)) % 4;
}

/**
 * JSON と BIN から GLB を組む。JSON は空白、BIN は 0 で 4 バイト境界に揃える。
 * @param {any} json
 * @param {Buffer} bin
 * @returns {Buffer}
 */
export function writeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonChunk = Buffer.concat([
    jsonBytes,
    Buffer.alloc(pad4(jsonBytes.length), 0x20),
  ]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(pad4(bin.length), 0)]);
  const header = Buffer.alloc(12);
  const total =
    12 + 8 + jsonChunk.length + (binChunk.length > 0 ? 8 + binChunk.length : 0);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.writeUInt32LE(CHUNK_JSON, 4);
  const parts = [header, jsonHead, jsonChunk];
  if (binChunk.length > 0) {
    const binHead = Buffer.alloc(8);
    binHead.writeUInt32LE(binChunk.length, 0);
    binHead.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(binHead, binChunk);
  }
  return Buffer.concat(parts);
}

/** accessor を落としてよい拡張だけを使っているか（ほかの拡張は accessor を参照することがある） */
const PRUNE_SAFE_EXTENSIONS = new Set([
  "VRM",
  "VRMC_vrm",
  "VRMC_springBone",
  "VRMC_springBone_extended_collider",
  "VRMC_node_constraint",
  "VRMC_materials_mtoon",
  "VRMC_materials_hdr_emissiveMultiplier",
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_texture_transform",
]);

/** メッシュ・スキン・アニメーションから参照されている accessor の番号 */
function referencedAccessors(json) {
  const used = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const index of Object.values(prim.attributes ?? {})) used.add(index);
      if (prim.indices !== undefined) used.add(prim.indices);
      for (const target of prim.targets ?? []) {
        for (const index of Object.values(target)) used.add(index);
      }
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined)
      used.add(skin.inverseBindMatrices);
  }
  for (const anim of json.animations ?? []) {
    for (const sampler of anim.samplers ?? []) {
      used.add(sampler.input);
      used.add(sampler.output);
    }
  }
  return used;
}

/** 参照されていない accessor を落とし、番号を付け替える（json を直接書き換える）。落とした数を返す */
function pruneAccessors(json) {
  const extensions = [...(json.extensionsUsed ?? [])];
  if (!extensions.every((name) => PRUNE_SAFE_EXTENSIONS.has(name))) return 0;
  const used = referencedAccessors(json);
  /** @type {Map<number, number>} */
  const remap = new Map();
  const kept = [];
  (json.accessors ?? []).forEach((accessor, index) => {
    if (!used.has(index)) return;
    remap.set(index, kept.length);
    kept.push(accessor);
  });
  const dropped = (json.accessors ?? []).length - kept.length;
  if (dropped === 0) return 0;
  const map = (index) => /** @type {number} */ (remap.get(index));
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const key of Object.keys(prim.attributes ?? {}))
        prim.attributes[key] = map(prim.attributes[key]);
      if (prim.indices !== undefined) prim.indices = map(prim.indices);
      for (const target of prim.targets ?? []) {
        for (const key of Object.keys(target)) target[key] = map(target[key]);
      }
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined)
      skin.inverseBindMatrices = map(skin.inverseBindMatrices);
  }
  for (const anim of json.animations ?? []) {
    for (const sampler of anim.samplers ?? []) {
      sampler.input = map(sampler.input);
      sampler.output = map(sampler.output);
    }
  }
  json.accessors = kept;
  return dropped;
}

/** 画像・accessor（疎の accessor を含む）から参照されている bufferView の番号 */
function referencedBufferViews(json) {
  const used = new Set();
  for (const image of json.images ?? []) {
    if (image.bufferView !== undefined) used.add(image.bufferView);
  }
  for (const accessor of json.accessors ?? []) {
    if (accessor.bufferView !== undefined) used.add(accessor.bufferView);
    if (accessor.sparse) {
      used.add(accessor.sparse.indices.bufferView);
      used.add(accessor.sparse.values.bufferView);
    }
  }
  return used;
}

/**
 * 埋め込み画像を縮める。縮めないものは再圧縮して小さくなったときだけ置き換える。
 * @returns {Promise<Map<number, Buffer>>} bufferView の番号 → 新しい中身
 */
async function shrinkImages(json, bin, max, log) {
  const { default: sharp } = await import("sharp");
  /** @type {Map<number, Buffer>} */
  const replaced = new Map();
  for (const [index, image] of (json.images ?? []).entries()) {
    if (image.bufferView === undefined) continue;
    const mime = image.mimeType;
    if (mime !== "image/png" && mime !== "image/jpeg") continue;
    const view = json.bufferViews[image.bufferView];
    const start = view.byteOffset ?? 0;
    const source = bin.subarray(start, start + view.byteLength);
    const meta = await sharp(source).metadata();
    const size = planTextureSize(meta.width ?? 1, meta.height ?? 1, max);
    const resized = size.width !== meta.width || size.height !== meta.height;
    let pipeline = sharp(source);
    if (resized)
      pipeline = pipeline.resize(size.width, size.height, { fit: "fill" });
    pipeline =
      mime === "image/png"
        ? pipeline.png({
            compressionLevel: 9,
            adaptiveFiltering: true,
            effort: 10,
          })
        : pipeline.jpeg({ quality: 85, mozjpeg: true });
    const encoded = await pipeline.toBuffer();
    const next = resized || encoded.length < source.length ? encoded : source;
    replaced.set(image.bufferView, next);
    log(
      `  画像 ${index} ${image.name ?? ""}: ${meta.width}×${meta.height} → ${size.width}×${size.height}、` +
        `${source.length} → ${next.length} バイト`,
    );
  }
  return replaced;
}

/** 参照されている bufferView だけを、4 バイト境界に揃えて詰め直す（json を直接書き換える） */
function repackBufferViews(json, bin, replaced) {
  const used = referencedBufferViews(json);
  /** @type {Map<number, number>} */
  const remap = new Map();
  const views = [];
  const chunks = [];
  let offset = 0;
  (json.bufferViews ?? []).forEach((view, index) => {
    if (!used.has(index)) return;
    const start = view.byteOffset ?? 0;
    const body =
      replaced.get(index) ?? bin.subarray(start, start + view.byteLength);
    const padding = pad4(offset);
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    offset += padding;
    remap.set(index, views.length);
    views.push({
      ...view,
      buffer: 0,
      byteOffset: offset,
      byteLength: body.length,
    });
    chunks.push(body);
    offset += body.length;
  });
  const map = (index) => /** @type {number} */ (remap.get(index));
  for (const image of json.images ?? []) {
    if (image.bufferView !== undefined)
      image.bufferView = map(image.bufferView);
  }
  for (const accessor of json.accessors ?? []) {
    if (accessor.bufferView !== undefined)
      accessor.bufferView = map(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = map(
        accessor.sparse.indices.bufferView,
      );
      accessor.sparse.values.bufferView = map(
        accessor.sparse.values.bufferView,
      );
    }
  }
  json.bufferViews = views;
  const nextBin = Buffer.concat(chunks);
  json.buffers = [{ ...json.buffers[0], byteLength: nextBin.length }];
  return nextBin;
}

/** VRM の拡張から meta を除いたもの（変えていないことの突き合わせに使う） */
function vrmExtensionsWithoutMeta(json) {
  const out = {};
  for (const [name, value] of Object.entries(json.extensions ?? {})) {
    if (!name.startsWith("VRM")) continue;
    const { meta: _meta, ...rest } = /** @type {any} */ (value);
    out[name] = rest;
  }
  return JSON.stringify(out);
}

/** 出力の大きさの内訳（画像・頂点の属性ごと・モーフ・逆バインド行列） */
export function breakdown(json) {
  /** @type {Record<string, number>} */
  const bytes = {};
  const add = (key, viewIndex) => {
    if (viewIndex === undefined) return;
    bytes[key] = (bytes[key] ?? 0) + json.bufferViews[viewIndex].byteLength;
  };
  const counted = new Set();
  const addAccessor = (key, accessorIndex) => {
    if (accessorIndex === undefined || counted.has(accessorIndex)) return;
    counted.add(accessorIndex);
    const accessor = json.accessors[accessorIndex];
    add(key, accessor.bufferView);
    if (accessor.sparse) {
      add(key, accessor.sparse.indices.bufferView);
      add(key, accessor.sparse.values.bufferView);
    }
  };
  for (const image of json.images ?? []) add("画像", image.bufferView);
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const [name, index] of Object.entries(prim.attributes ?? {}))
        addAccessor(`頂点 ${name}`, index);
      addAccessor("頂点の番号（indices）", prim.indices);
      for (const target of prim.targets ?? []) {
        for (const [name, index] of Object.entries(target))
          addAccessor(`モーフ ${name}`, index);
      }
    }
  }
  for (const skin of json.skins ?? [])
    addAccessor("逆バインド行列", skin.inverseBindMatrices);
  return bytes;
}

/**
 * 密な配列から、0 でない要素（itemSize 個の組のどれかが 0 でないもの）の番号と値を取り出す（疎の accessor の中身）。
 * @param {ArrayLike<number>} dense
 * @param {number} itemSize
 * @returns {{ indices: number[]; values: number[] }}
 */
export function sparseFromDense(dense, itemSize) {
  if (!Number.isInteger(itemSize) || itemSize <= 0 || dense.length % itemSize !== 0) {
    throw new RangeError(`sparseFromDense: 長さ ${dense.length} が itemSize ${itemSize} の倍数でない`);
  }
  /** @type {number[]} */
  const indices = [];
  /** @type {number[]} */
  const values = [];
  for (let item = 0; item < dense.length / itemSize; item += 1) {
    const start = item * itemSize;
    let nonZero = false;
    for (let k = 0; k < itemSize; k += 1) if (dense[start + k] !== 0) nonZero = true;
    if (!nonZero) continue;
    indices.push(item);
    for (let k = 0; k < itemSize; k += 1) values.push(dense[start + k]);
  }
  return { indices, values };
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

/**
 * モーフの POSITION の accessor を疎の accessor に直す（json を直接書き換える）。小さくなるものだけを直す。
 * 新しい bufferView は json.bufferViews の末尾に足し、中身を replaced に入れる（repackBufferViews が詰め直す）。
 * @returns {number} 直した accessor の数
 */
function sparsifyMorphTargets(json, bin, replaced) {
  const targets = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const target of prim.targets ?? []) {
        if (target.POSITION !== undefined) targets.add(target.POSITION);
      }
    }
  }
  let converted = 0;
  for (const index of targets) {
    const accessor = json.accessors[index];
    if (accessor.sparse || accessor.bufferView === undefined) continue;
    if (accessor.componentType !== FLOAT || accessor.type !== "VEC3") continue;
    const view = json.bufferViews[accessor.bufferView];
    if (view.byteStride !== undefined && view.byteStride !== 12) continue;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const bytes = Buffer.from(bin.subarray(start, start + accessor.count * 12)); // 複製して 4 バイト境界にそろえる
    const dense = new Float32Array(bytes.buffer, bytes.byteOffset, accessor.count * 3);
    let { indices, values } = sparseFromDense(dense, 3);
    // 疎の accessor の count は 1 以上（glTF の仕様）。動く頂点が無いキーは 0 番を 0 のまま 1 つ持つ
    if (indices.length === 0) {
      indices = [0];
      values = [0, 0, 0];
    }
    const wide = accessor.count > 65535;
    const indexBytes = Buffer.from(
      wide ? new Uint32Array(indices).buffer : new Uint16Array(indices).buffer,
    );
    const valueBytes = Buffer.from(new Float32Array(values).buffer);
    if (indexBytes.length + valueBytes.length >= accessor.count * 12) continue;
    const indicesView = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: indexBytes.length });
    replaced.set(indicesView, indexBytes);
    const valuesView = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: valueBytes.length });
    replaced.set(valuesView, valueBytes);
    // min・max（POSITION に要る）と count はそのまま。bufferView を外すと、読み手は 0 の配列に疎の値を書き込む
    delete accessor.bufferView;
    delete accessor.byteOffset;
    accessor.sparse = {
      count: indices.length,
      indices: { bufferView: indicesView, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT },
      values: { bufferView: valuesView },
    };
    converted += 1;
  }
  return converted;
}

/**
 * GLB を軽量化する。
 * @param {Buffer} input
 * @param {{ max?: number; log?: (line: string) => void }} [options]
 * @returns {Promise<{ output: Buffer; droppedAccessors: number; sparseTargets: number; breakdown: Record<string, number> }>}
 */
export async function slimGlb(input, options = {}) {
  const max = options.max ?? DEFAULT_MAX;
  const log = options.log ?? (() => {});
  const { json: original, bin } = parseGlb(input);
  if (
    (original.buffers ?? []).length !== 1 ||
    original.buffers[0].uri !== undefined
  ) {
    throw new Error(
      "slimGlb: GLB の BIN チャンク 1 つだけを持つファイルを扱う",
    );
  }
  const json = applyMetaLicense(original);
  const replaced = await shrinkImages(json, bin, max, log);
  const droppedAccessors = pruneAccessors(json);
  const sparseTargets = sparsifyMorphTargets(json, bin, replaced);
  const nextBin = repackBufferViews(json, bin, replaced);
  if (vrmExtensionsWithoutMeta(json) !== vrmExtensionsWithoutMeta(original)) {
    throw new Error("slimGlb: VRM の拡張（meta 以外）が変わった。書き出さない");
  }
  return {
    output: writeGlb(json, nextBin),
    droppedAccessors,
    sparseTargets,
    breakdown: breakdown(json),
  };
}

/**
 * three-vrm で読む（Node では画像の画素は読まない。node-shims.mjs）。
 * @param {Buffer} buffer
 */
async function loadVrm(buffer) {
  const { installGltfNodeShims } = await import("./node-shims.mjs");
  installGltfNodeShims();
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const { VRMLoaderPlugin } = await import("@pixiv/three-vrm");
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const gltf = await loader.parseAsync(arrayBuffer, "");
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error("loadVrm: VRM として読めない");
  return vrm;
}

/** 骨・表情・揺れものの数と名前（原本と出力の突き合わせに使う） */
export function summarizeVrm(vrm) {
  return {
    metaVersion: vrm.meta?.metaVersion,
    humanBones: Object.keys(vrm.humanoid?.humanBones ?? {}).sort(),
    expressions: (vrm.expressionManager?.expressions ?? []).map((e) => e.expressionName).sort(),
    springJoints: vrm.springBoneManager?.joints.size ?? 0,
    springColliders: vrm.springBoneManager?.colliders.size ?? 0,
    lookAt: vrm.lookAt != null,
    firstPerson: vrm.firstPerson != null,
  };
}

/**
 * 表情を weight で当てたときの、モーフ後の頂点の位置（メッシュの名前 → xyz の並び）。
 * three の morphAttributes を手で足し合わせる（glTF のモーフは相対値: 位置 + Σ 重み × モーフ）。
 * @param {any} vrm
 * @param {string} expressionName
 * @param {number} weight
 * @returns {Map<string, Float32Array>}
 */
export function morphedPositions(vrm, expressionName, weight) {
  const expression = vrm.expressionManager?.getExpression(expressionName);
  if (!expression) throw new Error(`morphedPositions: 表情 ${expressionName} が無い`);
  /** @type {Map<string, Float32Array>} */
  const out = new Map();
  for (const bind of expression.binds) {
    if (!bind.primitives) continue; // モーフ以外の bind（マテリアルの色など）は見ない
    for (const [order, mesh] of bind.primitives.entries()) {
      const key = `${mesh.name}#${order}`;
      const geometry = mesh.geometry;
      const morph = geometry.morphAttributes.position?.[bind.index];
      if (!morph) throw new Error(`morphedPositions: ${key} にモーフ ${bind.index} が無い`);
      let positions = out.get(key);
      if (!positions) {
        positions = Float32Array.from(geometry.attributes.position.array);
        out.set(key, positions);
      }
      const w = bind.weight * weight;
      for (let i = 0; i < positions.length; i += 1) positions[i] += w * morph.array[i];
    }
  }
  return out;
}

/** 2 つの morphedPositions の差の最大値と、動いた頂点の数（原本の側で、元の位置から動いたもの） */
function compareMorphed(before, after, rest) {
  let maxDiff = 0;
  let moved = 0;
  let vertices = 0;
  for (const [key, a] of before) {
    const b = after.get(key);
    const r = rest.get(key);
    if (!b || !r || b.length !== a.length) return { maxDiff: Infinity, moved, vertices };
    for (let i = 0; i < a.length; i += 3) {
      vertices += 1;
      let movedHere = false;
      for (let k = 0; k < 3; k += 1) {
        maxDiff = Math.max(maxDiff, Math.abs(a[i + k] - b[i + k]));
        if (a[i + k] !== r[i + k]) movedHere = true;
      }
      if (movedHere) moved += 1;
    }
  }
  if (after.size !== before.size) maxDiff = Infinity;
  return { maxDiff, moved, vertices };
}

/** モーフの確かめに当てる表情（VRM 0.x の joy は three-vrm で happy になる） */
const MORPH_CHECK_EXPRESSION = "happy";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const DEFAULT_INPUT = path.join(
  ROOT,
  "assets-original/avatar/亀谷銀大_VRoid.vrm",
);
const DEFAULT_OUTPUT = path.join(ROOT, "src/modules/avatar/assets/avatar.vrm");

/** `--max 768` のような引数を読む */
function readArgs(argv) {
  const args = {
    max: DEFAULT_MAX,
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--max") args.max = Number(value);
    else if (key === "--in") args.input = path.resolve(value);
    else if (key === "--out") args.output = path.resolve(value);
    else continue;
    i += 1;
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const log = (line) => console.log(line);
  const input = fs.readFileSync(args.input);
  log(
    `原本: ${path.relative(ROOT, args.input)}（${input.length} バイト）、テクスチャの長い辺 ${args.max}`,
  );
  const {
    output,
    droppedAccessors,
    sparseTargets,
    breakdown: parts,
  } = await slimGlb(input, { max: args.max, log });
  log(`参照されていない accessor を ${droppedAccessors} 個落とした`);
  log(`モーフの POSITION を ${sparseTargets} 個、疎の accessor にした`);
  log("内訳（バイト）:");
  for (const [key, value] of Object.entries(parts).sort((a, b) => b[1] - a[1]))
    log(`  ${key}: ${value}`);

  // 書き出す前に、原本と出力を three-vrm で読み直して突き合わせる
  const [vrmBefore, vrmAfter] = await Promise.all([loadVrm(input), loadVrm(output)]);
  const before = summarizeVrm(vrmBefore);
  const after = summarizeVrm(vrmAfter);
  const same = JSON.stringify(before) === JSON.stringify(after);
  log(
    `読み直し: metaVersion ${after.metaVersion}、humanoid の骨 ${before.humanBones.length} → ${after.humanBones.length}、` +
      `表情 ${before.expressions.length} → ${after.expressions.length}、` +
      `springBone の joint ${before.springJoints} → ${after.springJoints}、` +
      `collider ${before.springColliders} → ${after.springColliders}、lookAt ${after.lookAt}、firstPerson ${after.firstPerson}`,
  );
  if (!same) {
    console.error("原本と出力で骨・表情・揺れものが一致しない。書き出さない");
    console.error(JSON.stringify({ before, after }, null, 2));
    process.exit(1);
  }
  // 表情を 1 つ当てたときのモーフ後の頂点の位置が、原本と一致するか（疎にしたのがロスレスであることの確かめ）
  const morph = compareMorphed(
    morphedPositions(vrmBefore, MORPH_CHECK_EXPRESSION, 1),
    morphedPositions(vrmAfter, MORPH_CHECK_EXPRESSION, 1),
    morphedPositions(vrmBefore, MORPH_CHECK_EXPRESSION, 0),
  );
  log(
    `モーフの確かめ: 表情 ${MORPH_CHECK_EXPRESSION} を weight 1 で当てた ${morph.vertices} 頂点（うち動いたもの ${morph.moved}）で、` +
      `原本との差の最大 ${morph.maxDiff}`,
  );
  if (morph.maxDiff !== 0 || morph.moved === 0) {
    console.error("モーフ後の頂点の位置が原本と一致しない（または表情で何も動かない）。書き出さない");
    process.exit(1);
  }
  const mb = (output.length / 1_000_000).toFixed(2);
  if (output.length > LIMIT_REQUIRED) {
    // 必須の上限を超えたものは配信の場所に置かない（brief の Step 5: 768 でも超えたら止めて報告する）
    console.error(
      `${output.length} バイト（${mb} MB）で 6MB を超えた（必須の上限）。書き出さない。` +
        "--max 768 で再実行し、それでも超えたら止めて報告する",
    );
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, output);
  log(
    `出力: ${path.relative(ROOT, args.output)}（${output.length} バイト = ${mb} MB）`,
  );
  if (output.length > LIMIT_TARGET)
    log("4MB を超えた（目標の上限）。6MB 以下なので必須は満たす");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
