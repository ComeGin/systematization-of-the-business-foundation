// glb（glTF のバイナリ）の JSON チャンクだけを読む。three を使わずに模型のノード名・画像の形式を確かめる（単体テストと書き出しの道具）。
// 形式: 12 バイトのヘッダー（magic "glTF"・version・length）→ チャンク（長さ 4 バイト・種類 4 バイト "JSON"・中身）。

export interface GlbJson {
  nodes?: { name?: string; camera?: number; children?: number[] }[];
  images?: { mimeType?: string; name?: string }[];
}

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"

export function readGlbJson(bytes: Uint8Array): GlbJson {
  if (bytes.byteLength < 20)
    throw new Error("glb として読めません（短すぎる）");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC)
    throw new Error("glb として読めません（先頭が glTF でない）");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + length > bytes.byteLength)
    throw new Error("glb として読めません（最初のチャンクが JSON でない）");
  return JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + length)),
  ) as GlbJson;
}
