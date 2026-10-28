# 模型の素材（src/modules/diorama/assets）

ヒーローの「基盤の模型」（トップ・サービス 5 ページ・B の 5 ページ）が配信する素材。設計は `docs/superpowers/specs/2026-10-28-hero-diorama-design.md`。
ここにあるものは訪問者のブラウザへ送られる。

## ファイルと出所

| ファイル      | 中身                                                                                                                        | 出所                                                                                                                                                                                                             | 作り方                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `diorama.glb` | 模型（部品 14・ランプ・アバターの立ち位置・接地影の板・ページごとのカメラ 11 台）。形は meshopt で圧縮、色は焼き込んだ WebP | 自社で Blender（5.2）で作ったもの。テクスチャは ambientCG の [Wood092](https://ambientcg.com/view?id=Wood092)（台）と [Paper001](https://ambientcg.com/view?id=Paper001)（部品）。どちらも CC0（クレジット不要） | `../tools/blender/build_diorama.py` をホストの Blender で実行（下記） |

ノード名の約束（`part_<id>`・`anchor_<id>`・`shadow_<id>`・`lamp`・`avatar_spot`・`cam_<PageKey>`・`site_screen_marker`）は `../lib/parts.ts`・`../lib/pages.ts` と `tests/modules/diorama/asset.test.ts` が固定している。

## 作り方

1. ホストの Windows で Blender（5.2）を起動し、MCP のアドオンを有効にする。
2. ambientCG から `Wood092_1K-JPG.zip`・`Paper001_1K-JPG.zip` を `C:\Users\kamegin\ComeGin-diorama\textures\<ID>\` に展開する（スクリプトの `TEX`）。
3. `build_diorama.py` の中身を MCP の `execute_blender_code` に渡して実行する。段（`STAGES`）は `build`（組み立て）・`bake`（焼き込み。Cycles で 2 分ほど。`BAKE_PIDS` で分けて実行できる）・`export`（`C:\Users\kamegin\ComeGin-diorama\diorama.glb` に書き出し）。
4. 書き出した glb を VM に取り込む。Blender の中で一時的な HTTP の配信（`bpy.app.timers` で受け付ける `socketserver.TCPServer`。ポート 8766）を立て、VM から `curl http://10.0.2.2:8766/diorama.glb` で取る。終わったら配信を閉じる。
5. `pnpm test tests/modules/diorama` で、ノード名・画像の形式・容量（1.5MB 以内）を確かめる。

焼き込みは「均一な白い光の下の色」（紙・木の色 × 陰影）で、光の向きは three のランプが受け持つ。台には部品の影を焼かない（部品を持ち上げたときに影が残らないように）。部品の接地影は `shadow_<id>` の板を three が放射状の影に置き換える。

## 原本の置き場所

`frontend/verdant-virgo/assets-original/diorama/`（`.gitignore` で除外。追跡しない）。

| 原本                                    | 中身                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `assets-original/diorama/diorama.blend` | `build_diorama.py` で作った作業ファイル（焼いた画像を同梱）。スクリプトから作り直せる |
