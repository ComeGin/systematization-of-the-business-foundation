// 派生イメージ（cloud/images/<製品>）の上流の版の読み取り。
// 上流のタグとダイジェストは cloud/images/<製品>/upstream.json が正本。cloud/setup/index.mjs の IMAGES と
// cloud/images/build-push.mjs の両方がここから読む（版を上げるときに変える場所を 1 つにするため。cloud/README.md の 4.7）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 派生イメージを作る製品 */
export const PRODUCTS = ["chatwoot", "mautic"];

const DEFAULT_IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../images");
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * 製品の上流のタグとダイジェスト。`{ tag, digest }`。
 * imagesDir は テスト用に差し替える（既定は cloud/images）。読めない・形が違うときは、ファイル名と理由だけの例外
 */
export function readUpstream(product, imagesDir = DEFAULT_IMAGES_DIR) {
  if (!PRODUCTS.includes(product)) throw new Error(`知らない製品: ${product}（${PRODUCTS.join("・")} のどちらか）`);
  const file = join(imagesDir, product, "upstream.json");
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${product} の upstream.json を読めない（${e.code ?? "JSON として読めない"}）: cloud/images/${product}/upstream.json`);
  }
  if (typeof data?.tag !== "string" || data.tag === "") throw new Error(`cloud/images/${product}/upstream.json の tag が空`);
  if (typeof data?.digest !== "string" || !DIGEST.test(data.digest)) throw new Error(`cloud/images/${product}/upstream.json の digest が sha256:<64 桁の16進> の形でない`);
  return { tag: data.tag, digest: data.digest };
}
