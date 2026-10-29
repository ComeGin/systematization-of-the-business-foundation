# アトリエの素材（src/modules/atelier/assets）

トップのヒーロー（一人称で歩く「デザイナーのアトリエ」）と、下層ページの冒頭の静止画が配る素材。
設計は `docs/superpowers/specs/2026-10-28-hero-atelier-design.md`（§5.4 素材の出どころ・§10 予算）。
ここにあるものは、訪問者のブラウザへ送られる（誰でもダウンロードできる状態になる）。

## ファイル

| ファイル                                               | 中身                                                                                                                                                 | 作り方                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `atelier.glb`                                          | 空間（部屋・置き物・額の板・レール・カメラ・ランプの位置）。meshopt 圧縮、テクスチャは WebP。焼き込みは素材の色と AO だけ（光は three の実時間の光） | `tools/blender/build_atelier.py`（段 `build`・`bake`・`export`） |
| `atelier-mobile.glb`                                   | 上と同じで、テクスチャの解像度を半分にしたもの（768px 未満の画面）                                                                                   | 同上                                                             |
| `sky/{morning,day,dusk}.webp`                          | 天窓から見える空（2048×1024 の equirect）。夜の空は three で描く（星を点で描くため。spec §5.3）                                                      | 同上の段 `sky` → VM で `sharp` が WebP にする                    |
| `stills/<page>-<phase>[-mobile].webp`・`.anchors.json` | ポスターと下層ページの冒頭の静止画（同じシーンを three で撮ったもの。spec §9 の 1）                                                                  | `pnpm atelier:stills`（開発サーバーを起動してから）              |

## 使った素材とライセンス

取り込みは 2026-10-29。Poly Haven・ambientCG は CC0（クレジット不要・再配布可）。BlenderKit は無料の素材だけを使い、ライセンスは素材ごとに下の表のとおり（spec §5.4・A-20）。

**BlenderKit の Royalty Free の素材**は、素材そのものの再配布・販売が認められていない。そのため、glb には置き物ごとに 1 つにまとめ、色を焼き込んだ形だけで入れ、素材単体のファイル（元の .blend・テクスチャ）は配らない。公開の glb から形を取り出されうる危険は、ユーザーが受け入れた（A-20）。

### Poly Haven（Poly Haven Assets のアドオンで取り込み。CC0）

| 使い道 | 素材 | ID（URL） | 作者 |
| --- | --- | --- | --- |
| HDRI（朝の空） | Qwantani Morning (Pure Sky) | [`qwantani_morning_puresky`](https://polyhaven.com/a/qwantani_morning_puresky) | Jarod Guest |
| HDRI（昼の空） | Kloofendal 48d Partly Cloudy (Pure Sky) | [`kloofendal_48d_partly_cloudy_puresky`](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | Greg Zaal, Jarod Guest |
| HDRI（夕方の空） | Belfast Sunset (Pure Sky) | [`belfast_sunset_puresky`](https://polyhaven.com/a/belfast_sunset_puresky) | Greg Zaal, Dimitrios Savva, Jarod Guest |
| テクスチャ（壁・天井・仕切り） | Concrete Wall 008 | [`concrete_wall_008`](https://polyhaven.com/a/concrete_wall_008) | Dario Barresi, Charlotte Baglioni |
| モデル（環境構築の机） | Metal Office Desk | [`metal_office_desk`](https://polyhaven.com/a/metal_office_desk) | Ulan Cabanilla |
| モデル（環境構築のノート PC） | Classic Laptop | [`classic_laptop`](https://polyhaven.com/a/classic_laptop) | Arrangemonk |
| モデル（受託開発のメモ帳） | Office Notepads | [`office_notepads`](https://polyhaven.com/a/office_notepads) | Ulan Cabanilla |
| モデル（コンサルティングの文房具） | Stationery Supplies | [`stationery_supplies`](https://polyhaven.com/a/stationery_supplies) | Mateusz Sadek |
| モデル（協業の机） | Round Wooden Table 01 | [`round_wooden_table_01`](https://polyhaven.com/a/round_wooden_table_01) | Ulan Cabanilla |
| モデル（協業の椅子） | Wooden Chair 01 | [`WoodenChair_01`](https://polyhaven.com/a/WoodenChair_01) | Jake Mobley |
| モデル（料金の机） | Small Wooden Table 01 | [`small_wooden_table_01`](https://polyhaven.com/a/small_wooden_table_01) | Ulan Cabanilla |
| モデル（料金のクリップボード） | Clipboard | [`clipboard`](https://polyhaven.com/a/clipboard) | ProgrammerOnCoffee |
| モデル（料金のホッチキス） | Vintage Stapler | [`vintage_stapler`](https://polyhaven.com/a/vintage_stapler) | Mateusz Sadek |
| モデル（記事の本棚） | Wooden Bookshelf Worn | [`wooden_bookshelf_worn`](https://polyhaven.com/a/wooden_bookshelf_worn) | Ulan Cabanilla |
| モデル（記事の本） | Book Encyclopedia Set 01 | [`book_encyclopedia_set_01`](https://polyhaven.com/a/book_encyclopedia_set_01) | John Malcolm |
| モデル（相談の席の机） | Modern Coffee Table 01 | [`modern_coffee_table_01`](https://polyhaven.com/a/modern_coffee_table_01) | Amin |
| モデル（相談の席の椅子） | Modern Arm Chair 01 | [`modern_arm_chair_01`](https://polyhaven.com/a/modern_arm_chair_01) | Vibrant Nordic |
| モデル（送信完了のお茶） | Tea Set 01 | [`tea_set_01`](https://polyhaven.com/a/tea_set_01) | James Ray Cock, Rico Cilliers, Jurita Burger |
| モデル（吊りランプ） | Hanging Industrial Lamp | [`hanging_industrial_lamp`](https://polyhaven.com/a/hanging_industrial_lamp) | Kuutti Siitonen |
| モデル（植物） | Potted Plant 01 | [`potted_plant_01`](https://polyhaven.com/a/potted_plant_01) | Rico Cilliers |
| モデル（植物） | Potted Plant 02 | [`potted_plant_02`](https://polyhaven.com/a/potted_plant_02) | Rico Cilliers |
| モデル（植物） | Potted Plant 04 | [`potted_plant_04`](https://polyhaven.com/a/potted_plant_04) | James Ray Cock |
| モデル（植物） | Pachira Aquatica 01 | [`pachira_aquatica_01`](https://polyhaven.com/a/pachira_aquatica_01) | Rob Tuytel, Rico Cilliers |
| モデル（壁ぎわの棚） | Modern Wooden Cabinet | [`modern_wooden_cabinet`](https://polyhaven.com/a/modern_wooden_cabinet) | Patrik Pangerl |
| モデル（壁ぎわの鉄の棚） | Steel Frame Shelves 01 | [`steel_frame_shelves_01`](https://polyhaven.com/a/steel_frame_shelves_01) | James Ray Cock |

### ambientCG（Lily Surface Scraper で取り込み。CC0）

| 使い道 | 素材 | URL |
| --- | --- | --- |
| テクスチャ（床） | WoodFloor051 | <https://ambientcg.com/view?id=WoodFloor051> |
| テクスチャ（協業の紙の模型・料金の見積もりの紙） | Paper004 | <https://ambientcg.com/view?id=Paper004> |

### BlenderKit（BlenderKit のアドオンで取り込み。無料の素材だけ）

| 使い道 | 素材 | asset base ID | 作者 | ライセンス |
| --- | --- | --- | --- | --- |
| モデル（環境構築の画面 3 枚） | Office monitor hp 27 inch black | `69e5d155-db39-4fbd-bd26-addfe8922c7b` | Demycs | Royalty Free |
| モデル（受託開発のノート PC） | Laptop 14 inches Aluminium | `e68dc9f3-b6cb-4088-9960-6ec8182c1871` | Demycs | Royalty Free |
| モデル（コンサルティングのホワイトボード） | Whiteboard | `a1996f29-d7fe-44a6-8949-3d34ca15a089` | Rex Hans | Royalty Free |
| モデル（コンサルティングの付箋） | Sticky Notes | `c8b24498-de7d-4bfe-ae5e-93ed1a0d4636` | FriskyTater | CC0 |

会社の表札（ComeGin の文字・ブランドの青の印）・作業台・設計図・紙の模型・ホワイトボードの脚・額の枠・部屋の形は、`build_atelier.py` で作ったもの。


## 原本の置き場所

原本は `frontend/verdant-virgo/assets-original/atelier/` に置く（`.gitignore` が `assets-original/` を除外していて、**追跡しない**）。中身は `assets-original/atelier/README.md`。
