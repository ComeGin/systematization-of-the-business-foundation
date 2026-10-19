// Node で three の GLTFLoader（埋め込み画像のある GLB・VRM）を読むための最小の代用。tools の中だけで使う。
// - GLTFLoader は createImageBitmap があると ImageBitmapLoader を使い、埋め込み画像を Blob URL から fetch して
//   createImageBitmap に渡す。Node には fetch・Blob・URL.createObjectURL はあるが createImageBitmap が無い。
// - 検証に要るのは骨・表情・揺れものの構造だけで、画素は要らない。大きさだけを持つ偽物を返す。
// - 実際の画素の確かめは sharp（slim-vrm.mjs）で行う。

/** 画像の中身を読まずに 1×1 の ImageBitmap に見えるものを返す */
async function fakeCreateImageBitmap() {
  return { width: 1, height: 1, close() {} };
}

/** GLTFLoader を使う前に 1 回呼ぶ。すでに本物がある環境（ブラウザ）では何もしない */
export function installGltfNodeShims() {
  // GLTFLoader は Blob URL を `self.URL` から作る。Node には self が無いので globalThis を指させる
  if (typeof globalThis.self === "undefined") {
    globalThis.self = globalThis;
  }
  if (typeof globalThis.createImageBitmap === "undefined") {
    globalThis.createImageBitmap = fakeCreateImageBitmap;
  }
}
