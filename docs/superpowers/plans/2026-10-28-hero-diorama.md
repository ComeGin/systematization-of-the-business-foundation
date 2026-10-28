# ヒーローの作り直し（基盤の模型）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `HERO` 分類（トップの 1-3・サービス 5 ページ・B の 5 ページの導入ヒーロー・告知バナー）を、ランプに照らされた「木と紙の基盤の模型」（Three.js）で作り直す。

**Architecture:** 新しい `src/modules/diorama/` に、模型の論理（部品・データの流れ・ページごとの見せ方）を純粋な TypeScript で置き、three の描画（`lib/scene.ts`）と React の島（`islands/DioramaIsland.tsx`）がそれを読む。模型の形・質感・カメラは Blender で作った 1 本の `diorama.glb` が正本で、ポスター（読み込み前の絵）と B のページの静止画は、同じシーンを Playwright で撮って書き出す。文字・押せる部品・パネルはすべて HTML で、canvas は飾り（`aria-hidden`）。

**Tech Stack:** Astro 6・React 19・three 0.186.1（`@react-three/fiber` は使わず素の three。既存の `loadThree()` を通す）・Tailwind v4・vitest・Playwright・Blender（ホストの Windows。MCP `10.0.2.2:9876`）・ambientCG のテクスチャ（CC0）。

**Spec:** `docs/superpowers/specs/2026-10-28-hero-diorama-design.md`（承認済み 2026-10-28）

## Global Constraints

- 作業ディレクトリは `frontend/verdant-virgo`。パッケージは pnpm。**新しい npm の依存は足さない**（three の `examples/jsm` の GLTFLoader で足りる。足す必要が出たら止めてユーザーに聞く）。
- **git の状態を変える操作（commit・add・checkout -b など）はしない。デプロイはしない**（リポジトリの規則・H-14）。各タスクの最後は「差分の確認」で終える。
- ビルド（`pnpm build`・`pnpm lh`）・テストの実行（`pnpm test`・`pnpm a11y`・`pnpm e2e`）・テストコードの追加と更新は許可済み（H-14）。
- 文字（タグライン・h1・本文・CTA）は最初の HTML に入り、立体を待たずに読める。h1 の文言と改行位置（BreakableHeading）は変えない。
- 文言は `src/modules/site-content/` に置く。部品は文言の既定値を持たない（H-16）。**新しく書いた文言は、ユーザーの確認を通すまで「案」**（タスク 6 の確認の手順）。
- 架空の社名・人名・数値を出さない。実績は `permission: 'granted'` のものだけ出す。稼働の数字（何周目・最後の反映など）は出さない。
- 光の粒は実際のデータの流れどおりに動き、**承認台を通らずに作用先（小さなサイト・名簿・窓口）へ届く粒は無い**。小さなサイトへは必ず「承認台 → 配信の口」を通る。
- 粒の色: 流れ込み＝白 `#FFFFFF`、提案＝ブランドの青 `--color-brand-sky`（`#1298E8`）、承認済み＝金 `#FFD27A`。
- 区分は変えない: A（vivid）＝`/`・`/services/`・サービス詳細 4 本は動く立体、B（calm）＝会社概要・料金・ブログ一覧・お問い合わせ・送信完了は静止画、C（none）＝規約・ポリシーは触らない。
- 動きの規則（`05-motion-spec.md` §2・`frontend/verdant-virgo/CLAUDE.md`）: reduced-motion・JS なし・WebGL なし・一時停止は同じポスターで静止。5 秒を超えて動くものに `MotionPause`。hover で起きることは focus-visible でも起こす。時間と緩急は `--motion-duration-*`・`--motion-ease-*`（`motion/lib/tokens.ts` の `DURATION`・`EASE`）。
- three は `loadThree()`（`@/modules/motion/client`）からだけ読む。`rg -l "isWebGLRenderer" dist/_astro` が 1 のまま。
- 模型の glb は 1.5MB（1,572,864 バイト）以内。テクスチャは WebP。影・AO は焼き込み、実行時のシャドウマップは使わない。
- 描画解像度の上限: Desktop 2、Mobile（768px 未満）1.5。画面外・タブ非表示・一時停止では rAF を止める（`runWhenVisible`）。
- 代表のアバターは同じ画面に 2 人いない（H-13）。
- Lighthouse: accessibility 1.0・SEO 1.0 を保つ。performance は warn（ADR-29）。`pnpm a11y` の違反 0。
- 単体テストは `tests/modules/<module>/` に置き、`describe("正常系")`／`describe("異常系")` に分け、空入力は `空入力: `、異常系は `入力: `／`サーバ: ` で始める。外部（three・DOM の API）はモックする。

## Review Focus

1. **遅い端末・GPU の無い環境**: 最初の 3 秒のフレーム時間が長ければ解像度を下げ、それでも遅ければポスターのまま止まる（カクついたまま動き続けない）。→ タスク 3 の `decideQuality` のテスト、タスク 5 の e2e「遅い端末はポスターのまま」。
2. **パネルを開いたまま別の部品へ Tab で移る・Esc・画面外を押す**: パネルが 1 つだけ開き、閉じるとフォーカスが押したボタンへ戻り、カメラが元の位置へ戻る。→ タスク 6 の e2e。
3. **一時停止して別のページへ移る**: 次のページの模型も最初の描画から止まっている（`sessionStorage` の `motion:diorama`）。three を読まない。→ タスク 5 の e2e。
4. **画面の幅を Desktop ⇔ Mobile にまたいで変える**: ボタンの重ね位置が部品から外れない（ResizeObserver で投影し直す）。→ タスク 6 の e2e「幅を変えてもボタンが部品の上にある」。
5. **ヒーローを素早く上下にスクロールする**: 端のアバターが出入りを繰り返して点滅しない（出入りの判定に遅延を置く）。→ タスク 9 の単体テスト「しきい値の前後を素早く行き来しても 1 回しか通知しない」。

---

## ファイルの地図

| ファイル | 役割 | タスク |
|---|---|---|
| `src/modules/diorama/index.ts` | 公開口（Astro 部品と型） | 1・5 |
| `src/modules/diorama/client.ts` | ブラウザ用の公開口（.astro を含まない） | 1 |
| `src/modules/diorama/lib/types.ts` | `PartId`・`PartDef`・`FlowId`・`FlowStep`・`Stage`・`PageKey`・`PageView` | 1 |
| `src/modules/diorama/lib/parts.ts` | 部品の対応表（spec §5.1） | 1 |
| `src/modules/diorama/lib/flows.ts` | 粒の経路（spec §5.2）と `assertFlowsLogical` | 1 |
| `src/modules/diorama/lib/pages.ts` | ページごとの見せ方（spec §5.1 の右の列・§6.7） | 1 |
| `src/modules/site-content/cases.ts` | 実績のデータと `publishedCases` | 2 |
| `assets-original/diorama/`（追跡しない） | `diorama.blend`・ambientCG の原本・`README.md` | 4 |
| `src/modules/diorama/assets/diorama.glb` | 模型（配信する） | 4 |
| `src/modules/diorama/assets/README.md` | 素材の出所（ambientCG の ID） | 4 |
| `src/modules/diorama/lib/particles.ts` | 粒の状態機械（three に依存しない） | 3 |
| `src/modules/diorama/lib/quality.ts` | 遅い端末の判定 | 3 |
| `src/modules/diorama/lib/scene.ts` | three のシーン（glb・光・粒・持ち上げ・投影） | 5 |
| `src/modules/diorama/islands/DioramaIsland.tsx` | 島（読み込み・ポスターとの入れ替え・一時停止・ボタンの重ね合わせ） | 5・6 |
| `src/modules/diorama/components/DioramaHero.astro` | トップのヒーロー | 6 |
| `src/modules/diorama/components/DioramaIntro.astro` | サービスの導入ヒーローの模型（眺めるだけ） | 7 |
| `src/modules/diorama/components/DioramaStill.astro` | B の静止画 | 8 |
| `src/modules/diorama/components/DioramaPanel.astro` | 部品のパネル（HTML） | 6 |
| `src/modules/diorama/tools/capture-stills.mjs` | ポスター・静止画の書き出し（`pnpm diorama:stills`） | 5 |
| `src/modules/diorama/assets/stills/<PageKey>.webp` | ポスター・静止画 | 5・8 |
| `src/modules/site-content/diorama.ts` | 部品の名前・パネル・案内の文言 | 6 |
| `src/modules/avatar/lib/yield.ts` | 模型が見えている間、端のアバターを引っ込める判定 | 9 |
| `src/modules/page-transition/lib/names.ts` | `VT.diorama` を足す | 10 |
| `src/modules/layout/components/AnnouncementBanner.astro` | 告知バナーの磨き込み | 11 |

---

### Task 1: 模型の論理（部品・流れ・ページ）

**Files:**
- Create: `src/modules/diorama/lib/types.ts`, `src/modules/diorama/lib/parts.ts`, `src/modules/diorama/lib/flows.ts`, `src/modules/diorama/lib/pages.ts`, `src/modules/diorama/client.ts`, `src/modules/diorama/index.ts`
- Test: `tests/modules/diorama/parts.test.ts`, `tests/modules/diorama/flows.test.ts`, `tests/modules/diorama/pages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PartId = 'base'|'shelf'|'desk'|'roster'|'pipe'|'gauge'|'agents'|'approval'|'shipping'|'site'|'workshop'|'drafting'|'bridge'|'priceTag';
  export interface PartDef { id: PartId; kind: 'system'|'work'|'prop'; products: readonly string[]; touchable: boolean; node: `part_${PartId}`; anchor: `anchor_${PartId}`; shadow: `shadow_${PartId}` | null; }
  export const PARTS: Readonly<Record<PartId, PartDef>>;
  export type Stage = 'inflow'|'proposal'|'approved';
  export type FlowId = 'inquiryForm'|'inquiryChat'|'article'|'improveSite'|'improveCrm';
  export interface FlowStep { part: PartId; stage: Stage; }
  export const FLOWS: Readonly<Record<FlowId, readonly FlowStep[]>>;
  export function assertFlowsLogical(flows: Readonly<Record<string, readonly FlowStep[]>>): void; // 破綻があれば Error（メッセージに flow の名前と理由）
  export type PageKey = 'top'|'services'|'service:environment-setup'|'service:development'|'service:consulting'|'service:partnership'|'about'|'pricing'|'blog'|'contact'|'contactThanks';
  export interface PageView { mode: 'live-touch'|'live-view'|'still'; focus: PartId | null; camera: `cam_${string}`; showsAvatar: boolean; }
  export const PAGE_VIEWS: Readonly<Record<PageKey, PageView>>;
  ```
  `client.ts` は上をすべて re-export する。`index.ts` はこのタスクでは `export * from './client'` だけ。

- [ ] **Step 1: 文書と照合して経路を確定する**

  `docs/DetailedDesign/02-public-path-flows.md` §4・§5、`03-operation-path-flows.md` §4.1、`04-server-to-server-flows.md`（I-11）、`05-build-and-delivery-flows.md` §3、`06-proposal-loop-flows.md` §1・§1.5 を読み、spec §5.2 の表と食い違いが無いか確かめる。食い違いがあれば文書を正とし、`flows.ts` の各経路の上のコメントに根拠（文書と節）を書く。spec の表から変えた点は、差分の確認のときに報告する。

- [ ] **Step 2: 失敗するテストを書く**

  `parts.test.ts`（正常系）:
  - `PARTS のキーと各 id が一致する`
  - `touchable なのは system の部品と work の 3 つ（workshop・drafting・bridge）だけ`（`base`・`priceTag` は false）
  - `desk の products は ['Chatwoot'] だけ`（フォームは窓口を通り抜けるだけ。データの持ち主は Chatwoot。spec §5.1）／`roster は ['Mautic']`／`approval は 4 つの承認を持つ`（`products` に `'GitHub の PR'`・`'Strapi（公開の判断）'`・`'配信の承認'`・`'n8n（有効化）'`）
  - `node・anchor の名前は part_<id>・anchor_<id>`

  `flows.test.ts`:
  - 正常系 `FLOWS は assertFlowsLogical を通る`
  - 正常系 `site に届く流れは、直前が shipping、その前のどこかに approval がある`
  - 正常系 `improveCrm は approval の後に roster か desk で終わる`
  - 正常系 `inquiryForm は desk → roster → pipe の順`（Step 1 で文書と食い違えば、文書に合わせてこのテストを直す）
  - 異常系 `入力: approval を通らず approved になる流れは拒む`（`[{part:'agents',stage:'proposal'},{part:'site',stage:'approved'}]` → `/approval/`）
  - 異常系 `入力: stage が戻る流れは拒む`（approved の後に proposal）
  - 異常系 `入力: shipping を通らず site に届く流れは拒む`
  - 異常系 `入力: 存在しない部品を含む流れは拒む`
  - `空入力: 空の流れは拒む`（`{ x: [] }` → Error）

  `pages.test.ts`:
  - 正常系 `11 のページすべてに見せ方がある`
  - 正常系 `top だけが live-touch、services とサービス詳細 4 本は live-view、B の 5 本は still`
  - 正常系 `focus は spec の表どおり`（`service:environment-setup`→`base`、`service:development`→`workshop`、`service:consulting`→`drafting`、`service:partnership`→`bridge`、`about`→`approval`、`blog`→`shelf`、`contact`→`desk`、`contactThanks`→`desk`、`pricing`→`priceTag`、`top`・`services`→`null`）
  - 正常系 `about と top は showsAvatar が true`（サービスの 5 本はタスク 4 のカメラで承認台が写るかで決め、写らなければ false。テストは「showsAvatar が true のページのカメラ名は cam_<key>」だけを固定する）

- [ ] **Step 2b: テストが失敗することを確かめる**

  Run: `pnpm test tests/modules/diorama`
  Expected: FAIL（モジュールが無い）

- [ ] **Step 3: `types.ts`・`parts.ts`・`flows.ts`・`pages.ts` を書く**

  部品の値は spec §5.1 の表から、経路は Step 1 で確定したもの。カメラ名は `cam_` ＋ PageKey の `:` を `_` に変えたもの（`cam_service_development`）。`assertFlowsLogical` の判定は Step 2 の異常系の 4 つ（approval を経ない approved・stage の後戻り・shipping を経ない site・未知の部品）と空。

- [ ] **Step 4: テストが通ることを確かめる**

  Run: `pnpm test tests/modules/diorama`
  Expected: PASS

- [ ] **Step 5: 差分の確認（コミットしない）**

  Run: `git status --short src/modules/diorama tests/modules/diorama`

---

### Task 2: 実績のデータ

**Files:**
- Create: `src/modules/site-content/cases.ts`
- Modify: `src/pages/index.astro`（1-8 導入事例）
- Test: `tests/modules/site-content/cases.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CaseStudy { id: 'keizu'|'egnity'|'sho-rise'; company: string; summary: string; url: string | null; permission: 'granted'|'pending'; }
  export const CASES: readonly CaseStudy[];
  export function publishedCases(cases?: readonly CaseStudy[]): readonly CaseStudy[]; // granted だけ、元の順のまま
  ```

- [ ] **Step 1: 失敗するテストを書く**
  - 正常系 `granted だけを返す`／`元の順を保つ`／`CASES の 3 件はいまはすべて pending`（社名・内容・URL は spec H-7 の表と一字一句同じ: 「合同会社ケイズ」「就労継続支援B型事業所内で使用する、出品支援アプリの開発」`https://keizub.com/`、「株式会社エグニティー」「物販事業で使用する、リサーチ支援アプリの開発」`null`、「SHO-RISE Drift Simulator Studio」「ドリフトシミュレータ内で使用する、オリジナルコースMODの作成」`null`）
  - `空入力: 空の配列なら空を返す`
  - 異常系 `入力: permission が不明な値の件は返さない`（`as unknown as CaseStudy` で `'yes'` を渡す）

- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm test tests/modules/site-content` / Expected: FAIL

- [ ] **Step 3: `cases.ts` を書く。** 内容の文言はユーザーの入力どおり（H-7）。冒頭のコメントに「掲載許可が取れたら permission を granted にする。許可の範囲（ロゴ・声・数値）が分かるまで、項目は会社名・内容・URL だけ」と書く。

- [ ] **Step 4: 1-8 を `publishedCases()` につなぐ。** 1 件以上あるときは、その件のカード（会社名・内容・URL があれば外部リンク〈`NewTabNotice`〉）を、ロゴ枠・お客さまの声の「準備中」の前に並べる。0 件のときの見た目はいまと同じ（差分が出ないこと）。

- [ ] **Step 5: 通ることを確かめる** — Run: `pnpm test tests/modules/site-content && pnpm build` / Expected: PASS、ビルド成功

- [ ] **Step 6: 差分の確認（コミットしない）**

---

### Task 3: 粒の状態機械と遅い端末の判定

**Files:**
- Create: `src/modules/diorama/lib/particles.ts`, `src/modules/diorama/lib/quality.ts`
- Test: `tests/modules/diorama/particles.test.ts`, `tests/modules/diorama/quality.test.ts`

**Interfaces:**
- Consumes: `FLOWS`・`FlowId`・`Stage`・`PartId`（Task 1）
- Produces:
  ```ts
  export interface Particle { id: number; flow: FlowId; step: number; t: number; stage: Stage; }
  export interface ParticleSystem { step(dtMs: number): readonly Particle[]; spawn(flow: FlowId): void; arrivals(): readonly { flow: FlowId; part: PartId; stage: Stage }[]; }
  export interface ParticleOptions { flows?: typeof FLOWS; legMs: number; spawnEveryMs: Partial<Record<FlowId, number>>; random?: () => number; }
  export function createParticleSystem(opts: ParticleOptions): ParticleSystem;
  export const STAGE_COLOR: Readonly<Record<Stage, string>>; // inflow '#FFFFFF'・proposal は cssColor('--color-brand-sky') を呼ぶ側が渡すので '#1298E8'・approved '#FFD27A'
  export type Quality = { dpr: number; live: boolean };
  export function decideQuality(frameTimesMs: readonly number[], opts: { mobile: boolean; deviceDpr: number }): Quality;
  ```
  `arrivals()` は直前の `step` で各区間の終点に着いた粒（scene がうなずき・小さなサイトの書き換えの合図に使う）。

- [ ] **Step 1: 失敗するテストを書く**

  `particles.test.ts`:
  - 正常系 `粒の stage は、いまいる区間の始点の stage`（`legMs` ずつ進めて、`FLOWS.improveSite` の各区間で `stage` を確かめる）
  - 正常系 `approved になるのは approval に着いた後だけ`（全 flow を 100 回分進め、approval より前の区間で approved の粒が 0）
  - 正常系 `site への到着は approved だけ`（`arrivals()` を集め、`part==='site'` はすべて `stage==='approved'`）
  - 正常系 `最後の区間を終えた粒は消える`
  - 正常系 `spawnEveryMs の間隔で自動で生まれる`（`random` を固定）
  - `空入力: dt が 0 なら何も進まない`
  - 異常系 `入力: 負の dt は 0 として扱う`／`入力: 巨大な dt（タブ復帰の 60 秒）でも 1 回の step で進むのは 1 区間まで`（復帰の瞬間に粒がワープしない）

  `quality.test.ts`:
  - 正常系 `平均 20ms 以下なら Desktop は dpr=min(2, deviceDpr)・live`／`Mobile は min(1.5, deviceDpr)`
  - 正常系 `平均が 20ms を超え 40ms 以下なら dpr=1・live`
  - 正常系 `平均が 40ms を超えたら live=false（ポスターのまま）`
  - `空入力: フレームが 0 本なら初期値（Desktop 2・Mobile 1.5 の上限内）で live`
  - 異常系 `入力: NaN・負の値は捨てて平均する`

- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm test tests/modules/diorama` / Expected: FAIL

- [ ] **Step 3: 実装する。** 区間の補間は呼ぶ側（scene）が `t`（0〜1）で行う。状態機械は位置を持たない。

- [ ] **Step 4: 通ることを確かめる** — Run: `pnpm test tests/modules/diorama` / Expected: PASS

- [ ] **Step 5: 差分の確認（コミットしない）**

---

### Task 4: 模型を Blender で作る（ホスト）

**前提:** ユーザーがホストの Windows で Blender を起動し、MCP のアドオンを有効にしている（H-15）。`mcp__blender__get_objects_summary` が応答しなければ、ユーザーに起動を頼んで待つ。

**Files:**
- Create（ホスト）: `diorama.blend`、書き出しの `diorama.glb`
- Create（VM）: `assets-original/diorama/diorama.blend`・`assets-original/diorama/README.md`（追跡しない）、`src/modules/diorama/assets/diorama.glb`、`src/modules/diorama/assets/README.md`
- Test: `tests/modules/diorama/asset.test.ts`

**Interfaces:**
- Consumes: `PARTS`・`PAGE_VIEWS`（Task 1）
- Produces: glb のノード名の約束 — 各部品 `part_<id>`（持ち上げる単位。原点は底面の中心）、`anchor_<id>`（ボタンと名前の札を重ねる点。部品の上面の少し上）、`shadow_<id>`（部品の下の接地影の板。焼いた透過テクスチャ。`base` と `priceTag` には無い）、`lamp`（ランプの笠。光源はコードで置く）、`avatar_spot`（承認台のアバターを立たせる点）、カメラ `cam_<PageKey の : を _ に>`（11 台）。

- [ ] **Step 1: 失敗するテストを書く（`asset.test.ts`）**

  glb の JSON チャンクを `node:fs` で読み（先頭 12 バイトのヘッダーの後、チャンク長 → JSON。three は使わない）:
  - 正常系 `PARTS の node・anchor・shadow（null 以外）がすべてノードにある`
  - 正常系 `PAGE_VIEWS の camera がすべてカメラ付きのノードにある`
  - 正常系 `lamp・avatar_spot がある`
  - 正常系 `画像はすべて image/webp`
  - 正常系 `ファイルは 1,572,864 バイト以内`
  - 異常系 `入力: glb でないファイル（先頭が glTF でない）は読めないと分かる`（テスト用の小さな Buffer で、読み取り関数が Error を投げる）

  Run: `pnpm test tests/modules/diorama/asset.test.ts` / Expected: FAIL（ファイルが無い）

- [ ] **Step 2: ambientCG からテクスチャを取る。** 木（台）と紙（部品）の 2 種、1K の JPG。Blender の Python（`execute_blender_code`）でホストへダウンロードする。選んだ素材の ID とページの URL を控える（CC0。クレジットは不要だが README に残す）。

- [ ] **Step 3: 模型を組む。** spec §5.1 の 14 部品を、試作 `material.html` の 1 の配置を出発点に、Interaction Library の温度感で作る（紙の部品は少し折り目・厚み、木は面取り）。仕事の 3 つ（工房・設計の机・渡り廊下）は土台の縁に置く。値札は土台の手前の角に立てる。部屋の床・壁は置かない（背景はコードで navy.900 の地にする）。

- [ ] **Step 4: 焼き込み。** 各部品と台に AO と柔らかい直接光（ランプの位置）を焼き、色のテクスチャに合成して 1 枚の WebP にする（部品ごと 512px、台 1024px を上限）。台の焼き込みには**部品の影を入れない**（持ち上げたときに影が残るのを避ける）。部品の接地影は `shadow_<id>` の板に別に焼く。

- [ ] **Step 5: カメラを置く。** `PAGE_VIEWS` の 11 台。`cam_top` は模型の全景を右寄りに（左に文字の余白）、`cam_services` は少し引いた全景、サービス詳細と B は `focus` の部品に寄る。B の静止画とサービスのカメラで、承認台（アバター）が画面に入るかを記録し、Task 1 の `showsAvatar` を合わせる。

- [ ] **Step 6: 書き出して VM に移す。** glTF Binary・画像は WebP・カメラを含める・Draco なし。ホストから VM への転送は、Blender の Python でホストの書き出し先を `http.server` で一時的に配り、VM から `curl -o src/modules/diorama/assets/diorama.glb http://10.0.2.2:<port>/diorama.glb` で取る（終わったらサーバーを止める）。届かなければ、ユーザーに `assets-original/diorama/` へ置いてもらう。`.blend` も同じ経路で `assets-original/diorama/` へ。

- [ ] **Step 7: README を書く。** `src/modules/diorama/assets/README.md` に、ファイル・出所（Blender・ambientCG の ID と URL）・作り方・原本の置き場所（`assets-original/diorama/`、追跡しない）を、`avatar/assets/README.md` と同じ形で。

- [ ] **Step 8: 通ることを確かめる** — Run: `pnpm test tests/modules/diorama` / Expected: PASS

- [ ] **Step 9: ユーザーの確認（見た目）。** Blender のビューポートの画像（`render_viewport_to_path` → VM へ転送）を `cam_top` と 2〜3 台のカメラで、ビジュアルコンパニオン（`.superpowers/brainstorm/`）に並べて見せ、素材感・配置の直しを聞く。直しがあれば Step 3〜8 をやり直す。**承認が出るまで Task 5 に進まない。**

- [ ] **Step 10: 差分の確認（コミットしない）**

---

### Task 5: 描画と島（眺める模型）とポスター

**Files:**
- Create: `src/modules/diorama/lib/scene.ts`, `src/modules/diorama/islands/DioramaIsland.tsx`, `src/modules/diorama/tools/capture-stills.mjs`, `src/modules/diorama/assets/stills/*.webp`
- Modify: `package.json`（scripts に `"diorama:stills": "node src/modules/diorama/tools/capture-stills.mjs"`）、`src/modules/site-content/a11y.ts`（`MOTION_PAUSE_TARGETS.diorama: "（模型）"`）
- Test: `e2e/a11y/diorama.spec.ts`（このタスクでは眺める模型の分）

**Interfaces:**
- Consumes: `loadThree`・`canUseWebGL`・`runWhenVisible`・`DURATION`・`EASE`・`cssColor`（`@/modules/motion/client`）、`MotionPause`・`useReducedMotion`（`@/modules/a11y/client`）、`createParticleSystem`・`decideQuality`（Task 3）、`PAGE_VIEWS`（Task 1）
- Produces:
  ```ts
  // lib/scene.ts（three はここと tools だけが触る）
  export interface DioramaScene {
    render(dtMs: number): void;
    resize(width: number, height: number, dpr: number): void;
    setHover(part: PartId | null): void;
    focusPart(part: PartId | null): void;          // カメラを寄せる・戻す（DURATION.large・EASE.emphasized）
    setPointer(x: number, y: number): void;         // -0.5〜0.5（視差とランプの傾き）
    projectAnchors(): ReadonlyMap<PartId, { x: number; y: number; visible: boolean }>; // canvas の CSS px
    dispose(): void;
  }
  export function createDioramaScene(three: typeof import('three'), canvas: HTMLCanvasElement, opts: { glbUrl: string; camera: string; colors: { proposal: string; room: string }; frozen?: boolean }): Promise<DioramaScene>;
  ```
  ```tsx
  // islands/DioramaIsland.tsx
  interface Props { page: PageKey; glbUrl: string; pauseLabel: string; resumeLabel: string; pauseTarget: string; touch?: { labels: Record<PartId, string> }; } // touch は Task 6
  ```
  島は根（`[data-motion="diorama"]`）に `data-diorama-live`（canvas に替わった）・`data-motion-paused` を付け外しする。一時停止の `storageKey` は `motion:diorama`。

- [ ] **Step 1: 失敗する e2e を書く（`diorama.spec.ts`、ルート `/services/`）**
  - `ポスターが最初の HTML にあり、h1 は 3D を待たずに読める`（JS を止めたページで `[data-motion="diorama"] img` と h1 が見える）
  - `WebGL があれば canvas に替わり、ポスターと入れ替わる間に CLS が 0`（`e2e/support/motion.ts` の `cls`）
  - `reduced-motion では three を読まず、ポスターのまま`（`isWebGLRenderer` を含むチャンクの要求が 0）
  - `一時停止で rAF が止まり、次のページでも最初から止まっている`（Review Focus 3）
  - `WebGL が無いとポスターのまま`（`motion-no-webgl.spec.ts` と同じ差し替え）
  - `遅い端末はポスターのまま`（`page.clock` か CPU スロットリングで 1 フレーム 50ms 以上にして、`data-diorama-live` が付かない。Review Focus 1）
  - `canvas は aria-hidden、axe の違反 0`

  Run: `pnpm build && pnpm a11y e2e/a11y/diorama.spec.ts` / Expected: FAIL

- [ ] **Step 2: `scene.ts` を書く。** GLTFLoader（`three/examples/jsm/loaders/GLTFLoader.js`）で glb を読む。素材は glb のまま（焼き込みの色）、光は HemisphereLight と、`lamp` の下の SpotLight（影なし。暖色 `#ffd49a`）。背景は `colors.room`（navy.900）。粒は 1 つの InstancedMesh（発光の球、`STAGE_COLOR`）。区間の経路は `anchor_<from>` → `anchor_<to>` の放物線（高さは区間の長さの 0.35 倍）。持ち上げはばね（`part_<id>` を 0.12 上げ、`shadow_<id>` を 0.85 倍・半透明に）。ランプは 8 秒周期でわずかに揺らぎ、`setPointer` の方へ最大 4 度傾く。`approval` に approved の粒が着いたら、`avatar_spot` に置いたアバター（このタスクでは置かない。Task 9）へ合図できるよう、`onArrival` のフックを残す。`site` に approved の粒が着いたら、小さなサイトの画面（`part_site` の画面の面）の一部の帯を `DURATION.medium` で明るくしてから元に戻す（spec §5.2。何が改善されたかは描かない）。`frozen` のときは粒を出さず、1 枚だけ描く（ポスター用）。

- [ ] **Step 3: `DioramaIsland.tsx` を書く。** `GlobeIsland.tsx` と同じ流れ（WebGL の確認 → `sessionStorage` の一時停止 → 画面に入り手が空いてから `loadThree()` と glb を読む → 最初の 1 枚を描いてから 2 フレーム待って `data-diorama-live` → ポスターを `DURATION.medium` で消す）。最初の 3 秒のフレーム時間を `decideQuality` に渡し、`live=false` ならポスターに戻して rAF を止める。`runWhenVisible` で画面外・非表示では止める。`MotionPause` は根の右下（ヒーローの一時停止と重ならない位置）。

- [ ] **Step 4: ポスターの書き出し（`capture-stills.mjs`）。** `avatar/tools/capture-stills.mjs` と同じ方法（開発サーバーのオリジンに空のページを route で出し、`scene.ts` を Vite から読んで `frozen: true` で 1 枚描く）。PageKey ごとに、Desktop 用 1440×900（CSS 720×450 の 2 倍）と Mobile 用 780×585 を WebP で `assets/stills/<key>.webp`・`<key>-mobile.webp` に出す（`sharp` は既存の依存）。同時に、その構図での `projectAnchors()` の結果を `<key>.anchors.json`・`<key>-mobile.anchors.json`（`{ [PartId]: { x: %, y: % } }`、枠に対する割合）に出す（Task 6 で、静止のときにボタンを置く位置）。

  Run: `astro dev --background && pnpm diorama:stills`
  Expected: `assets/stills/` に画像 22 枚と JSON 22 本。`services.webp` を開いて、模型が `cam_services` の構図で写っている

- [ ] **Step 5: 動作の確認用に `/services/` の導入ヒーローへ仮に置く**（Task 7 で正式に置く。ここでは e2e を通すための最小の置き方。`DioramaIntro.astro` を作り、`PageIntro` の `slot="backdrop"` に入れる）

- [ ] **Step 6: 通ることを確かめる** — Run: `pnpm build && pnpm a11y e2e/a11y/diorama.spec.ts && pnpm test` / Expected: PASS。`rg -l "isWebGLRenderer" dist/_astro | wc -l` が 1

- [ ] **Step 7: 差分の確認（コミットしない）**

---

### Task 6: トップのヒーロー（触れる模型・パネル）

**Files:**
- Create: `src/modules/diorama/components/DioramaHero.astro`, `src/modules/diorama/components/DioramaPanel.astro`, `src/modules/site-content/diorama.ts`
- Modify: `src/modules/diorama/islands/DioramaIsland.tsx`（`touch`）、`src/modules/diorama/index.ts`、`src/pages/index.astro`（1-3）、`src/modules/site-content/top.ts`（`hero.photo` を外す）、`e2e/a11y/motion-vivid.spec.ts`（`/` からヒーローの背景の検査を外す）
- Test: `e2e/a11y/diorama.spec.ts`（トップの分を足す）

**Interfaces:**
- Consumes: Task 5 の `DioramaIsland`・`DioramaScene.projectAnchors/setHover/focusPart`、`publishedCases`（Task 2）、`PARTS`（Task 1）
- Produces:
  ```ts
  // site-content/diorama.ts
  export const DIORAMA: {
    hint: string;                                   // 「部品を押すと、中の仕事が開きます」
    close: string;                                  // パネルの閉じるボタン
    parts: Record<PartId, { name: string; body: string; productNote: string | null; link: { label: string; href: string } | null }>;
    cases: { heading: string; empty: string; selfNote: string; caseNote: string }; // 窓口のパネルの「この窓口から始まった仕事」
  };
  ```

- [ ] **Step 1: 文言の案を書き、ユーザーの確認を取る。** `site-content/diorama.ts` に 14 部品の `name`・`body`（1〜2 文）・`productNote`（実際の製品名）・`link`、窓口の `cases` を書く。読者は IT 人材のいない中小企業の経営者（GL v1.3 §2.8）。3 件の実績が「受託開発」だと分かる言い方（`caseNote`）、許可 0 件のときの `empty`（「掲載準備中です」）と `selfNote`（「ComeGin はこの基盤で、自社のサイトを回しています。」）。案を表にしてユーザーに見せ、直しを入れる。**承認が出るまで Step 2 以降に進まない。**

- [ ] **Step 2: 失敗する e2e を書く（ルート `/`）**
  - `タグライン・h1・本文・CTA が最初の HTML にあり、写真（hero.photo）はヒーローに無い`
  - `部品のボタンを Tab で巡れ、フォーカスで部品が持ち上がる（data-hover）`
  - `ボタンを押すとパネルが 1 つだけ開き、パネルにフォーカスが移る。Esc で閉じてボタンへ戻る`（Review Focus 2。開いたまま別の部品を押すと、前のパネルが閉じる）
  - `窓口のパネルは、granted の実績が 0 件なら empty と selfNote を出し、架空の社名を出さない`（`CASES` の社名がどれも見えない）
  - `幅を 1280 → 390 → 1280 と変えても、各ボタンの中心が anchor の投影から 8px 以内`（Review Focus 4）
  - `reduced-motion・WebGL なしでも、ポスターの上に同じボタンがあり、パネルが開く`
  - `axe の違反 0（パネルを開いた状態も）`

  Run: `pnpm build && pnpm a11y e2e/a11y/diorama.spec.ts` / Expected: FAIL

- [ ] **Step 3: `DioramaHero.astro` を書く。** 左にタグライン・`HeroHeading`・本文・CTA（いまの 1-3 と同じ部品・同じ文言）、右から中央に模型（Desktop はヒーローの区画の全面に canvas、Mobile は文字の下に 4:3）。ポスターは `<picture>`（`<key>-mobile.webp` を 767px 以下）で `fetchpriority="high"`。地は `tone="brand-strong"`（`data-surface="dark"`）。`MotionSymbol`・`HeroBackdrop` は置かない。

- [ ] **Step 4: 押せる部品とパネル。** 島の `touch` で、`PARTS` の `touchable` の部品ごとに `<button>`（名前は `DIORAMA.parts[id].name`）を canvas の上に重ね、毎フレーム `projectAnchors()` の位置へ `transform` で動かす（React の再描画をしない。ref で書く）。ポスターのとき（静止）は、Task 5 で書き出した `stills/<key>.anchors.json`（Mobile は `-mobile`）の割合で置く。hover・focus-visible で `setHover`、押すと `focusPart` と `DioramaPanel` を開く（非モーダルの `role="dialog"`・`aria-labelledby`、閉じるボタン、Esc・外側のクリックで閉じ、`focusPart(null)` と元のボタンへフォーカス）。窓口のパネルは `publishedCases()` を並べ、0 件なら `empty`＋`selfNote`。画面の隅に `DIORAMA.hint`。

- [ ] **Step 5: トップを差し替える。** `index.astro` の 1-3 を `DioramaHero` に。`top.ts` から `hero.photo` を外し、写真はタスク 12 の確認まで `index.astro` のヒーローの直下に `Section` で仮に置く（消さない。H-12）。`motion-vivid.spec.ts` の `HERO_ROUTES` から `/` を外し、トップの背景の検査は `diorama.spec.ts` に移ったとコメントで残す。

- [ ] **Step 6: 通ることを確かめる** — Run: `pnpm build && pnpm a11y && pnpm test` / Expected: PASS、axe の違反 0

- [ ] **Step 7: 差分の確認（コミットしない）**

---

### Task 7: サービス 5 ページ（眺める模型）

**Files:**
- Modify: `src/modules/diorama/components/DioramaIntro.astro`（Task 5 の仮を正式に）、`src/pages/services/index.astro`、`src/pages/services/[slug].astro`、`src/modules/layout/components/PageIntro.astro`（`tone="dark"` のときの媒体の枠を模型に合わせる）、`e2e/a11y/motion-vivid.spec.ts`、`e2e/a11y/diorama.spec.ts`

**Interfaces:**
- Consumes: `DioramaIsland`（Task 5、`touch` なし）、`PAGE_VIEWS`

- [ ] **Step 1: 失敗する e2e を足す**（`/services/` と 4 本の詳細）: `ヒーローに模型（data-motion="diorama"）があり、HeroBackdrop（#hero-backdrop）と GlobeOsaka が無い`／`部品のボタンが無い（眺めるだけ）`／`一時停止のボタンがある`／`h1 の view-transition-name はそのまま`。Run: `pnpm build && pnpm a11y e2e/a11y/diorama.spec.ts` / Expected: FAIL

- [ ] **Step 2: 差し替える。** `PageIntro` の `slot="backdrop"` に `DioramaIntro page={…}`、`slot="media"` は空に（Desktop は文字の右の空いた所に模型の焦点が来るよう、`cam_*` が構図を持つ）。詳細ページの `hero.photo` と一覧の `GlobeOsaka` は、ヒーローの直下に仮に置く（タスク 12 で確認）。`motion-vivid.spec.ts` の `HERO_ROUTES` を空にし、残る検査（Tilt3d・マーキー等）はそのまま。

- [ ] **Step 3: 通ることを確かめる** — Run: `pnpm build && pnpm a11y && pnpm test` / Expected: PASS

- [ ] **Step 4: 差分の確認（コミットしない）**

---

### Task 8: B の 5 ページ（静止画）

**Files:**
- Create: `src/modules/diorama/components/DioramaStill.astro`
- Modify: `src/pages/about.astro`, `src/pages/pricing.astro`, `src/pages/blog/_BlogListing.astro`, `src/pages/contact/index.astro`, `src/pages/contact/thanks.astro`, `src/modules/site-content/about.ts`（`hero.photo` を外す）、`e2e/a11y/motion-calm.spec.ts`

- [ ] **Step 1: 失敗する e2e を足す**（5 ルート）: `導入ヒーローの媒体の枠に、そのページの静止画（stills/<key>.webp）がある`／`canvas が無く、three を読まない`／`静止画は装飾（alt=""・aria-hidden）`／`B のページに光り物・動く立体が無い（motion-calm の既存の検査が通る）`。Run: 上と同じ / Expected: FAIL

- [ ] **Step 2: `DioramaStill.astro` を書く**（`<picture>` で Desktop・Mobile、`loading="eager"`、枠は 480×360〈`PageIntro` の媒体の枠の大きさ〉。`object-fit: cover` で `focus` の部品が中央に来るよう、Task 5 の書き出しの大きさを 4:3 にしておく〈書き出しの `SHOTS` に B 用の 960×720 を足す〉）。各ページの `PageIntro` の `slot="media"` に置く。会社概要の写真は直下へ仮に移す（タスク 12）。

- [ ] **Step 3: 通ることを確かめる** — Run: `pnpm diorama:stills && pnpm build && pnpm a11y` / Expected: PASS

- [ ] **Step 4: 差分の確認（コミットしない）**

---

### Task 9: アバター（模型の中の 1 人と、端のアバターの出入り）

**Files:**
- Create: `src/modules/avatar/lib/yield.ts`
- Modify: `src/modules/avatar/client.ts`、`src/modules/avatar/islands/AvatarStage.tsx`、`src/modules/avatar/components/AvatarDock.astro`（`data-avatar-yield` の CSS）、`src/modules/diorama/lib/scene.ts`（`avatar_spot` に縮小した VRM を置く）、`src/modules/diorama/islands/DioramaIsland.tsx`、`src/modules/diorama/components/*.astro`（根に `data-avatar-yield-source` を、`PAGE_VIEWS[page].showsAvatar` が true のときだけ）、`e2e/a11y/avatar.spec.ts`
- Test: `tests/modules/avatar/yield.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const YIELD_SETTLE_MS: number; // DURATION.medium
  export function watchYield(source: Element, onChange: (yielded: boolean) => void, opts?: { settleMs?: number }): () => void;
  ```
  `source` が画面に 1px でも入っている間は `true`。変化は `settleMs` 続いたときだけ通知する。

- [ ] **Step 1: 失敗する単体テストを書く**（IntersectionObserver をモックし、`vi.useFakeTimers()`）: 正常系 `見えたら settleMs の後に true`／`外れたら settleMs の後に false`／`しきい値の前後を素早く行き来しても 1 回しか通知しない`（Review Focus 5）／`戻り値で監視をやめる`。異常系 `入力: IntersectionObserver が無い環境では常に false（端のアバターを隠さない）`。`空入力: settleMs を省くと YIELD_SETTLE_MS`。Run: `pnpm test tests/modules/avatar/yield.test.ts` / Expected: FAIL

- [ ] **Step 2: `yield.ts` を書き、`AvatarStage` で `document.querySelector('[data-avatar-yield-source]')` を `watchYield` し、`true` の間は根に `data-avatar-yield="true"`**（CSS で左の画面の外へ逃がす。`data-avatar-away` と同じ transform とトランジション。描画も止める）。フォーカスがアバターのボタンにある間は逃がさない（`scroll-away.ts` と同じ扱い）。Run: `pnpm test` / Expected: PASS

- [ ] **Step 3: 模型の中のアバター。** `scene.ts` で `avatar_spot` に同じ `.vrm`（`avatar/assets/avatar.vrm?url`。`@pixiv/three-vrm` は既存の依存）を縮小して置き、待機の呼吸（`motions/idle.json`）と、`approval` に approved の粒が着いたときのうなずき（`motions/nod.json`）だけを再生する。B の会社概要の静止画は、書き出し時にアバターを待機の 0 秒目で写す。`pnpm diorama:stills` をやり直す。

- [ ] **Step 4: e2e を更新する**（`avatar.spec.ts`）: `/` と `/about/` で、ヒーローが見えている間は端のアバターが画面の外（`data-avatar-yield="true"`）、ヒーローを過ぎると戻る。既存の古い挙動のテスト（R20 の未更新分）はこのタスクで直さない（範囲外。差分の確認で報告する）。Run: `pnpm build && pnpm a11y e2e/a11y/avatar.spec.ts e2e/a11y/diorama.spec.ts` / Expected: 追加した検査が PASS

- [ ] **Step 5: 差分の確認（コミットしない）**

---

### Task 10: ページの移動を「カメラの移動」に見せる

**Files:**
- Modify: `src/modules/page-transition/lib/names.ts`（`VT.diorama: "vt-diorama"`）、`src/modules/page-transition/lib/morph.ts`、`src/modules/page-transition/components/PageTransitionHead.astro`（`::view-transition-old(vt-diorama)` の動き）、`src/modules/diorama/components/*.astro`（模型の枠に `vtStyle(VT.diorama)`）
- Test: `tests/modules/page-transition/morph.test.ts`（足す）、`e2e/a11y/page-transition.spec.ts`（足す）

**Interfaces:**
- Produces: `export function dioramaZoomOrigin(fromPage: PageKey, toPage: PageKey, anchors: ReadonlyMap<PartId, {x:number;y:number}>, size: {width:number;height:number}): { x: string; y: string } | null;` — 行き先の `focus` の部品の、移動元の画面での位置（`%`）。`focus` が null か、どちらかが模型の無いページなら null。

- [ ] **Step 1: 失敗するテストを書く**: 正常系 `top → service:development は workshop の投影位置の %`／`services → top は null（寄らない）`。`空入力: anchors が空なら null`。異常系 `入力: 範囲外の座標は 0〜100% に丸める`。e2e `/ から /services/development/ へ移ると vt-diorama の遷移が起き、reduced-motion では起きない`。Run: `pnpm test tests/modules/page-transition && pnpm build && pnpm a11y e2e/a11y/page-transition.spec.ts` / Expected: FAIL

- [ ] **Step 2: 実装する。** pageswap で、島が持つ最新の `projectAnchors()`（根の `data-diorama-anchors` に JSON で置く）から `dioramaZoomOrigin` を求め、`document.documentElement.style` に `--vt-diorama-x/y` を書く。古い側は `transform-origin: var(--vt-diorama-x) var(--vt-diorama-y)` で 1.6 倍へ拡大しながら消え、新しい側（行き先のポスター）は現れる。時間は `--motion-duration-large`、緩急は `--motion-ease-emphasized`。行き先がトップ（戻る）なら拡大の逆（0.6 倍から）。

- [ ] **Step 3: 通ることを確かめる** — Run: Step 1 と同じ / Expected: PASS

- [ ] **Step 4: 差分の確認（コミットしない）**

---

### Task 11: 告知バナー（1-1）の磨き込み

**Files:**
- Modify: `src/modules/layout/components/AnnouncementBanner.astro`
- Test: `e2e/a11y/motion-vivid.spec.ts`（足す）

- [ ] **Step 1: 失敗する e2e を書く**: `「受け取る」のリンクに hover・focus-visible で矢印が右へ 4px 動く`（`getComputedStyle` の transform）／`reduced-motion では動かない`／`文言と順序はいまのまま`。Run: `pnpm build && pnpm a11y e2e/a11y/motion-vivid.spec.ts` / Expected: FAIL

- [ ] **Step 2: 実装する。** 矢印の移動（`--motion-duration-micro`・`--motion-ease-standard`）と、Badge「無料公開中」に読み込み時 1 回だけの小さな光の流れ（CSS。1 回なので一時停止は不要）。文言・配置・閉じるボタンなしは変えない。

- [ ] **Step 3: 通ることを確かめる**、**Step 4: 差分の確認（コミットしない）**

---

### Task 12: 写真の移し先の確定・仕様書の改訂・全体の確認

**Files:**
- Modify: `src/pages/index.astro`・`src/pages/services/index.astro`・`src/pages/services/[slug].astro`・`src/pages/about.astro`（仮に置いた写真・地球儀の最終位置）、`docs/BasicDesign/DesignSpec/website/01-content-spec.md`（§4.1 の 1-3、2-3、サービス詳細と B の導入ヒーロー、1-8）、`docs/BasicDesign/DesignSpec/website/05-motion-spec.md`（§4 の予算の表に模型、§8.2 の置き場所、§10 のアバターの出入り）、`docs/BasicDesign/DesignSpec/website/02-component-map.md`（diorama モジュール）

- [ ] **Step 1: 写真と地球儀の移し先をユーザーに確認する。** 仮の位置（ヒーローの直下）と、spec の例（1-4a の業務理念の近くなど）の候補を、ページの画面写真（Playwright）でビジュアルコンパニオンに並べ、選んでもらう（H-12・spec §13）。

- [ ] **Step 2: 選ばれた位置へ移す。** 移した写真・地球儀は、既存の部品（`Photo`・`GlobeOsaka`）のまま。

- [ ] **Step 3: 仕様書を改訂する。** 各節に「2026-10-28 に改訂した（ヒーローの模型。spec `2026-10-28-hero-diorama-design.md`）」と、旧版の記述を残す（既存の書き方）。

- [ ] **Step 4: 全体を確かめる**
  Run: `pnpm test && pnpm build && pnpm a11y && pnpm lh`
  Expected: 単体・a11y が PASS、axe の違反 0、Lighthouse の accessibility・SEO が 1.0（performance は warn。値を報告する。計測の前に `benchmarkIndex` を見る）。`rg -l "isWebGLRenderer" dist/_astro | wc -l` が 1。

- [ ] **Step 5: ユーザーの最終確認。** トップ → サービス詳細 → 会社概要の流れを Playwright で録画（`.a11y/videos/` と同じ置き方）し、Desktop・Mobile・reduced-motion の 3 つを見せる。「論理の破綻」「つなぎ目」の 2 つの観点で直しを聞く。

- [ ] **Step 6: 差分の確認（コミットしない）。** `git status --short` の一覧と、未解決のもの（アバターの R20 の古いテスト、Mixamo の利用条件など範囲外のもの）を報告する。
