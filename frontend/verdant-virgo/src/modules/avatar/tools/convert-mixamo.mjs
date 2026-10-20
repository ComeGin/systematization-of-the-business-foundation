// Mixamo の FBX（Without Skin、30fps）を、アバターの再生用のクリップの JSON（MotionClipJson）へ変える。
// `pnpm avatar:motions` で動かす（Task 9）。原本: assets-original/avatar/mixamo/*.fbx（追跡しない・配らない）
//   → 出力: src/modules/avatar/assets/motions/*.json
//
// 回転の直し方は three-vrm の公式サンプル loadMixamoAnimation.js（v3.5.5）と同じ式:
//   https://github.com/pixiv/three-vrm/blob/v3.5.5/packages/three-vrm/examples/humanoidAnimation/loadMixamoAnimation.js
//   Copyright (c) 2019-2026 pixiv Inc. MIT License（https://github.com/pixiv/three-vrm/blob/v3.5.5/LICENSE）
//   「親の休止のワールド回転 × トラックの回転 × 自分の休止のワールド回転の逆」で Mixamo の休止姿勢を打ち消し、
//   VRM 1.0 の正規化された骨の空間へ直す。
// こちらの変更（サンプルとの違い）:
//   - VRM を読まずに書き出す。VRM 0.x の x・z の反転と、腰の位置の縮尺（vrmHipsHeight / mixamoHipsHeight）は再生側で行う。
//   - 位置は hips だけ残す（Mixamo の単位のまま）。scale のトラックは落とす。
//   - fps の間隔（既定 24fps）で書き出し直し、数値を小数 4 桁に丸める。指の骨は keepFingers のときだけ残す。
//     24fps は配信量を抑えるため。大きさの基準は gzip 後の合計（R15。TOTAL_GZIP_BUDGET）。
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { MIXAMO_TO_VRM } from "./mixamo-rig-map.mjs";

/** 既定の書き出しの間隔。24fps は配信量を抑えるため。大きさの基準は gzip 後の合計（R15。TOTAL_GZIP_BUDGET） */
export const DEFAULT_FPS = 24;

/** 指の骨（VRM の humanoid の名前） */
const FINGER_BONE = /(Thumb|Index|Middle|Ring|Little)/;

/** 小数 4 桁に丸める。-0 は 0 にする */
function round4(value) {
  return Math.round(value * 1e4) / 1e4 + 0;
}

/**
 * FBX の中の骨の名前を、対応表のキー（`mixamorig:` の接頭辞付き）にそろえる。
 * three の FBXLoader は `:` を落とす（`mixamorigHips`）。Mixamo は `mixamorig1:` のように番号を付けることもある。
 * @param {string} name
 */
export function toMixamoKey(name) {
  const match = /^mixamorig\d*:?(.+)$/.exec(name);
  return match ? `mixamorig:${match[1]}` : name;
}

/** 0 秒から duration 秒まで 1/fps 秒おきの時刻。最後が duration に届かなければ duration を足す */
function sampleTimes(duration, fps) {
  const count = Math.floor(duration * fps + 1e-6);
  const times = [];
  for (let i = 0; i <= count; i += 1) times.push(i / fps);
  if (duration - times[times.length - 1] > 1e-6) times.push(duration);
  return times;
}

/** トラックを times の時刻で読み直す（回転は球面補間、位置は線形補間。three の補間器をそのまま使う） */
function resample(track, times) {
  const interpolant = track.createInterpolant();
  const out = [];
  for (const time of times) out.push(...interpolant.evaluate(time));
  return out;
}

/**
 * Mixamo のクリップを MotionClipJson にする。
 * @param {THREE.Object3D} fbxScene FBXLoader が返した骨格（休止姿勢のまま）
 * @param {THREE.AnimationClip} clip
 * @param {string} name 書き出すクリップの名前（EmoteId か "idle"）
 * @param {{ keepFingers: boolean; fps: number }} opts
 * @returns {import("../lib/types").MotionClipJson}
 */
export function toClipJson(fbxScene, clip, name, opts) {
  if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
    throw new RangeError(
      `toClipJson: fps は 0 より大きい数にする（${opts.fps}）`,
    );
  }
  /** @type {THREE.Object3D | undefined} */
  let hipsNode;
  fbxScene.traverse((node) => {
    if (!hipsNode && MIXAMO_TO_VRM[toMixamoKey(node.name)] === "hips")
      hipsNode = node;
  });
  if (!hipsNode)
    throw new Error("toClipJson: 骨格に腰（mixamorig:Hips）が無い");

  const duration = Math.max(0, clip.duration);
  const times = sampleTimes(duration, opts.fps);
  const restWorldInverse = new THREE.Quaternion();
  const parentRestWorld = new THREE.Quaternion();
  const q = new THREE.Quaternion();

  /** @type {import("../lib/types").MotionClipTrack[]} */
  const tracks = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    const nodeName = track.name.slice(0, dot);
    const property = track.name.slice(dot + 1);
    const bone = MIXAMO_TO_VRM[toMixamoKey(nodeName)];
    if (!bone) continue; // 対応表に無い骨（HeadTop_End などの末端）は落とす
    if (!opts.keepFingers && FINGER_BONE.test(bone)) continue;
    const node = fbxScene.getObjectByName(nodeName);
    if (!node) continue;

    if (property === "quaternion") {
      // サンプルの式: 親の休止のワールド回転 × 回転 × 自分の休止のワールド回転の逆
      node.getWorldQuaternion(restWorldInverse).invert();
      if (node.parent) node.parent.getWorldQuaternion(parentRestWorld);
      else parentRestWorld.identity();
      const raw = resample(track, times);
      const values = [];
      for (let i = 0; i < raw.length; i += 4) {
        q.fromArray(raw, i)
          .premultiply(parentRestWorld)
          .multiply(restWorldInverse);
        values.push(round4(q.x), round4(q.y), round4(q.z), round4(q.w));
      }
      tracks.push({
        bone,
        path: "quaternion",
        times: times.map(round4),
        values,
      });
    } else if (property === "position" && bone === "hips") {
      // 位置は腰だけ。Mixamo の単位のまま（再生側で vrmHipsHeight / mixamoHipsHeight を掛ける）
      tracks.push({
        bone,
        path: "position",
        times: times.map(round4),
        values: resample(track, times).map(round4),
      });
    }
  }

  return {
    version: 1,
    name: /** @type {import("../lib/types").MotionClipJson["name"]} */ (name),
    duration: round4(duration),
    fps: opts.fps,
    mixamoHipsHeight: round4(hipsNode.position.y),
    tracks,
  };
}

/** FBX のファイル名 → 書き出す JSON の名前と、指を残すか（★ 指は point・peace・think だけ） */
export const MIXAMO_SOURCES = [
  { file: "Waving.fbx", name: "greeting", keepFingers: false },
  { file: "HeadNodYes.fbx", name: "nod", keepFingers: false },
  { file: "Pointing.fbx", name: "point", keepFingers: true },
  { file: "Thinking.fbx", name: "think", keepFingers: true },
  { file: "Victory.fbx", name: "peace", keepFingers: true },
  { file: "StandingGreeting.fbx", name: "show-full-body", keepFingers: false },
  { file: "BreathingIdle.fbx", name: "idle", keepFingers: false },
];

/**
 * 合計の目安。配信の圧縮後（CloudFront の Compress: true〈cloud/stacks/cdn.yaml〉で gzip か brotli）の大きさで判断する
 * （R15。2026-10-19。以前は gzip 前で 800KB だった）。gzip -9 の合計で 400KB 以下。10 進で数える。
 */
const TOTAL_GZIP_BUDGET = 400_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const INPUT_DIR = path.join(ROOT, "assets-original/avatar/mixamo");
const OUTPUT_DIR = path.join(ROOT, "src/modules/avatar/assets/motions");

async function main() {
  const fpsIndex = process.argv.indexOf("--fps");
  const fps = fpsIndex >= 0 ? Number(process.argv[fpsIndex + 1]) : DEFAULT_FPS;
  // FBXLoader は Node でもそのまま動く（TextDecoder・fflate だけを使う。Without Skin なので画像は読まない）
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  let total = 0;
  let totalGzip = 0;
  console.log(`書き出しの間隔: ${fps}fps`);
  console.log(
    "| クリップ | 元の FBX | duration（秒） | トラック | 指 | 大きさ（バイト） | gzip -9（バイト） |",
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const source of MIXAMO_SOURCES) {
    const buffer = fs.readFileSync(path.join(INPUT_DIR, source.file));
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    const scene = new FBXLoader().parse(arrayBuffer, "");
    const clip =
      THREE.AnimationClip.findByName(scene.animations, "mixamo.com") ??
      scene.animations[0];
    if (!clip) throw new Error(`${source.file}: アニメーションが無い`);
    const json = toClipJson(scene, clip, source.name, {
      keepFingers: source.keepFingers,
      fps,
    });
    const text = JSON.stringify(json);
    fs.writeFileSync(path.join(OUTPUT_DIR, `${source.name}.json`), text);
    const gzipped = gzipSync(text, { level: 9 }).length;
    total += Buffer.byteLength(text);
    totalGzip += gzipped;
    console.log(
      `| ${source.name} | ${source.file} | ${json.duration} | ${json.tracks.length} | ` +
        `${source.keepFingers ? "残す" : "落とす"} | ${Buffer.byteLength(text)} | ${gzipped} |`,
    );
  }
  console.log(
    `合計: ${total} バイト、gzip -9 で ${totalGzip} バイト（目安は gzip で ${TOTAL_GZIP_BUDGET} バイト以下）`,
  );
  if (totalGzip > TOTAL_GZIP_BUDGET) {
    console.error("圧縮後の合計が目安を超えた。減らし方を決めてから配る");
    process.exit(2);
  }
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
