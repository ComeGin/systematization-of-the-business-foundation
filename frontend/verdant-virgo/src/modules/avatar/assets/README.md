# アバターの素材（src/modules/avatar/assets）

代表のアバター（トップのアトリエの中に立つ人形。`src/modules/avatar/lib/figure.ts`。設計は `docs/superpowers/specs/2026-10-28-hero-atelier-design.md` §6.4）が配信する素材。
**画面の端のアバター（AvatarDock）は 2026-10-28 にやめた（A-13）**。端のアバターの静止画（`still.webp`・`icon.webp`）と書き出しの道具（`pnpm avatar:stills`）は 2026-10-29 に消した。
ここにあるものは、訪問者のブラウザへ送られる（誰でもダウンロードできる状態になる。U-10 で了承済み）。

## ファイルと出所

| ファイル                  | 中身                                                              | 出所                                                                                                                                                                         | 作り方                               |
| ------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `avatar.vrm`              | 自社のアバターのモデル（VRM 0.x。`extensions.VRM`）               | 自社で VRoid Studio で作り、Blender（VRM Add-on、`saturday06_blender_vrm_exporter_experimental_4.10.2`）で書き出した原本 `亀谷銀大_VRoid.vrm`（2026-10-19 にユーザーが配置） | `pnpm avatar:slim`                   |
| `motions/*.json`          | 身ぶりのクリップ 7 本（`MotionClipJson`。型は `../lib/types.ts`） | [Mixamo](https://www.mixamo.com/)（Adobe）の FBX 7 本（Without Skin、30fps。2026-10-19 にユーザーが配置）                                                                    | `pnpm avatar:motions`                |

`avatar.vrm` のメタ情報は「作者だけ・商用不可・再配布禁止」（`allowedUserName: OnlyAuthor`・`commercialUssageName: Disallow`・`licenseName: Redistribution_Prohibited`）にしてある。
ダウンロードを妨げるものではなく、第三者の再利用を許さない旨をファイル自身に記すためのもの。

## 原本の置き場所

原本は `frontend/verdant-virgo/assets-original/avatar/` に置く。`frontend/verdant-virgo/.gitignore` が `assets-original/` を丸ごと除外していて、**追跡しない**（数十 MB の原本をリポジトリに入れないため）。

| 原本                                        | 中身                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `assets-original/avatar/亀谷銀大_VRoid.vrm` | モデルの原本（11,152,080 バイト）                                      |
| `assets-original/avatar/mixamo/*.fbx`       | Mixamo のモーション 7 本                                               |
| `assets-original/avatar/vrma/`              | VRoid 公式の「VRMアニメーション 7 種セット」。**使わない**（下を参照） |

## Mixamo のモーションの扱い

Adobe の Mixamo の FAQ（<https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html>）によると、Mixamo のキャラクターとアニメーションは、個人・商用・非営利のプロジェクトにロイヤリティなしで使える。
FAQ にはクレジットを表示せよという求めも無い。
一方で Adobe は、キャラクターやアニメーションを次の形で扱うことを認めていない。

- それ単独で配る
- 編集できる形で配る
- 素材として売る

そのため、**FBX は配らず、リポジトリにも入れない**。
2026-10-19 に見た FAQ のページ（2021-09-14 更新）には、この制限の文言が見当たらない。制限は Adobe の利用条件の側で確かめる。

配るのは、VRM の骨格へ当て直して数値に変えた JSON のクリップだけ。
ただし、これでもブラウザから取り出せる動きのデータを配ることになる。この点は、U-14（2026-10-19）でユーザーが Mixamo を選んだ判断に基づく。
公開前に、Adobe の規約の最新版を確かめる。

| FBX                    | クリップ                      | 身ぶり       | 指の骨 |
| ---------------------- | ----------------------------- | ------------ | ------ |
| `Waving.fbx`           | `motions/greeting.json`       | 手を振る     | 落とす |
| `HeadNodYes.fbx`       | `motions/nod.json`            | うなずく     | 落とす |
| `Pointing.fbx`         | `motions/point.json`          | 指さす       | 残す   |
| `Thinking.fbx`         | `motions/think.json`          | 考える       | 残す   |
| `Victory.fbx`          | `motions/peace.json`          | 喜ぶ         | 残す   |
| `StandingGreeting.fbx` | `motions/show-full-body.json` | 全身を見せる | 落とす |
| `BreathingIdle.fbx`    | `motions/idle.json`           | 待機         | 落とす |

当て直しの式は three-vrm の公式サンプル（`packages/three-vrm/examples/humanoidAnimation/`、MIT）と同じ。出典は `../tools/convert-mixamo.mjs`・`../tools/mixamo-rig-map.mjs` の冒頭にある。

## 7 種セット（vrma/）を使わない理由

7 種セットの Readme の禁止事項「許可なく取り出せる状態で二次配布すること」に当たる恐れがある（U-13）。
Web サイトで再生するには、ファイルを訪問者のブラウザへ送る（取り出せる状態にする）ことになるため、7 種セットは使わず、Mixamo のモーションに切り替えた（U-14。2026-10-19）。

## 作り直し方

`frontend/verdant-virgo` で動かす。原本が `assets-original/avatar/` にあることが前提。

```bash
pnpm avatar:slim      # モデルを軽くする（既定はテクスチャの長い辺 768。--max 1024 などで変える）
pnpm avatar:motions   # Mixamo の FBX を JSON のクリップに変える（既定 24fps。--fps 30 などで変える）
pnpm avatar:stills    # 静止画（still.webp・icon.webp）を撮る（先に astro dev --background。既定の宛先は http://localhost:4321）
```

- `avatar:slim` は、画像を縮めて再圧縮し、どこからも参照されていない accessor を落とし、モーフの POSITION を疎の accessor にする（どれもロスレスか、画像の縮小だけ）。書き出す前に、原本と出力を three-vrm で読み直して骨・表情・springBone・lookAt・firstPerson が一致すること、表情 happy を当てたモーフ後の頂点の位置が原本と一致することを確かめ、一致しなければ、または 6MB を超えれば書き出さない。
- `avatar:motions` の合計は、配信の圧縮後（CloudFront の `Compress: true`。gzip か brotli）の大きさで判断する。
