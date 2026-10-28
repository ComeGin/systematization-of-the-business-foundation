# ヒーローの作り直し 第 2 版（デザイナーのアトリエ）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** トップの 1-3 ヒーローを、一人称で歩く「デザイナーのアトリエ」（Three.js）にし、下層ページの冒頭を同じアトリエの静止画でつなぎ、画面の端のアバターをサイトから外す。

**Architecture:** 新しい `src/modules/atelier/` に、アトリエの論理（置き物と移り先・道のレール・歩く加減速・時間帯・身ぶりの選び方）を three に依存しない TypeScript で置き、three の描画（`lib/scene.ts`）と React の島（`islands/AtelierIsland.tsx`・`AtelierTouch.tsx`）がそれを読む。空間の形・質感・カメラ・レールは Blender（Poly Haven Assets・BlenderKit・Lily Surface Scraper）で作った glb が正本で、ポスターと下層ページの静止画は、同じシーンを Playwright で時間帯ごとに撮って書き出す。文字・押せるもの・Tips はすべて HTML で、canvas は飾り（`aria-hidden`）。第 1 版の `diorama` から使い回せる部分（遅い端末の判定・点の配置・glb の読み取り・書き出しの道具・遷移の受け渡し）を移し、最後に `diorama` と端のアバターを消す。

**Tech Stack:** Astro 7・React 19・three 0.186（素の three。既存の `loadThree()` を通す）・@pixiv/three-vrm（既存）・Tailwind v4・vitest・Playwright・Blender 5.2（ホストの Windows。MCP `10.0.2.2:9876`）。

**Spec:** `docs/superpowers/specs/2026-10-28-hero-atelier-design.md`（承認済み 2026-10-28）

## Global Constraints

- 作業ディレクトリは `frontend/verdant-virgo`。パッケージは pnpm。**新しい npm の依存は足さない**（three の `examples/jsm` と既存の `sharp`・`@pixiv/three-vrm` で足りる。足す必要が出たら止めてユーザーに聞く）。
- **git の状態を変える操作（commit・add・checkout -b など）はしない。デプロイはしない**（リポジトリの規則）。各タスクの最後は「差分の確認」で終える。
- ビルド（`pnpm build`・`pnpm lh`）・開発サーバー（`astro dev --background`）・静止画の書き出し・Blender の操作・テストの実行（`pnpm test`・`pnpm a11y`・`pnpm e2e`）・テストコードの追加と更新は許可済み（A-19）。ビルドは開発の Strapi が要る（`STRAPI_URL=http://localhost:1337 pnpm build`。Strapi は `backend/strapi-system` で `pnpm dev`）。
- 文字（タグライン・h1・本文・CTA）は最初の HTML に入り、立体を待たずに読める。h1 の文言と改行位置（BreakableHeading）は変えない。
- 文言は `src/modules/site-content/` に置く。部品は文言の既定値を持たない（H-16）。**新しく書く文言（Tips・額・ボタン・アバターの名札）は、Task 4 の Step 0 でユーザーの確認を通すまでファイルに書かない**。Tips は見出し 20 字・説明 60 字まで。
- 架空の社名・人名・数値を出さない（GL §8.4）。他社の実績は `publishedCases()`（`permission: 'granted'`）だけ。数値（Lighthouse など）は、確認の時点で実際に計った値だけを書く。
- 置き物と Tips と移り先のページは 1 対 1。Tips の画像＝移り先の冒頭の静止画＝移る直前のカメラの位置（spec §5.2・§9）。
- 時間帯: 朝 5:00〜10:00・昼 10:00〜16:00・夕方 16:00〜19:00・夜 19:00〜5:00（端末の現地時刻。境目は「以上・未満」）。1 回の訪問の中では `sessionStorage` の `atelier:phase` で固定する。JS なしは昼。
- 区分は変えない: トップ・サービス（A）、ほかの下層ページ（B）、規約・ポリシー（C）。下層ページの冒頭は静止画（A のサービスも静止画）。C は触らない。`/accessibility/` だけ、h1 の上に 720px 幅・16:9 の静止画を足す（spec §7）。
- 動きの規則（`05-motion-spec.md` §2・`frontend/verdant-virgo/CLAUDE.md`）: reduced-motion・JS なし・WebGL なし・遅い端末は同じポスター＋一覧。5 秒を超えて動くものに `MotionPause`（`storageKey` は `motion:atelier`）。hover で起きることは focus-visible でも起こす。点滅は 1 秒に 3 回まで。時間と緩急は `DURATION`・`EASE`（`@/modules/motion/lib/tokens`）。ホイールと縦のスワイプはページのスクロールのまま。
- three は `loadThree()` からだけ読む。`rg -l "isWebGLRenderer" dist/_astro | wc -l` が 1 のまま。
- 予算: `atelier.glb` 3,145,728 バイト以内、`atelier-mobile.glb` 1,572,864 バイト以内、テクスチャは WebP、焼き込みは AO と素材の色だけ（光は実時間）。空は時間帯ごとに 1 本（WebP、307,200 バイト以内）。ポスターは Desktop 204,800・Mobile 122,880 バイト以内。描画解像度の上限は Desktop 2・Mobile（768px 未満）1.5。画面外・タブ非表示・一時停止では rAF を止める。
- 代表のアバターは同じ画面に 2 人いない（端のアバターは Task 9 で消す。それまでは第 1 版の `data-avatar-yield-source` で引っ込める）。
- Lighthouse: accessibility 1.0・SEO 1.0 を保つ。performance は warn（ADR-29）。`pnpm a11y` の違反 0。
- 素材: Poly Haven（CC0）・ambientCG（CC0）・BlenderKit の無料素材（Royalty Free か CC0）。有料・有料プラン限定は使わない。使った素材の名前・ID・URL・ライセンスを README の 2 か所に残す（spec §5.4）。
- 単体テストは `tests/modules/<module>/` に置き、`describe("正常系")`／`describe("異常系")` に分け、空入力は `空入力: `、異常系は `入力: `／`サーバ: ` で始める。外部（three・DOM の API）はモックする。e2e は `e2e/a11y/`（`pnpm a11y`。preview 4323）。GPU の無い VM では判定済みの `atelier:quality` を先に置いて動く側を検査する（第 1 版の `presetLive` と同じ）。
- `sessionStorage` のキー: `atelier:quality`（遅い端末の判定）・`motion:atelier`（一時停止）・`atelier:phase`（時間帯）・`atelier:pos`（道の上の位置）・`atelier:vt`（遷移の受け渡し）。

## Review Focus

1. **文字や Tips に向かってカーソルを動かす**: カーソルが文字・CTA・ボタン・Tips の上にある間、また Tips を開いている間は歩かない（読もうとしただけで景色が動かない）。→ Task 5 の e2e「文字の上・Tips を開いている間は進まない」。
2. **スマートフォンで置き物を長押し・空いた所を短くタップ**: 置き物の長押しは歩かず Tips、空いた所の短いタップは何もしない。長押しでブラウザーのメニュー・文字の選択が出ない。→ Task 5 の e2e（`hasTouch`）。
3. **時間帯の境目をまたぐ訪問**（18:59 に開いて 19:01 に下層ページへ移る）: トップと下層ページで同じ時間帯の絵。→ Task 3 の単体「訪問の間は最初の時間帯を返す」、Task 8 の e2e（`page.clock`）。
4. **下層ページからブラウザーの「戻る」**（bfcache を含む）: 同じ位置から描かれ、Tips は閉じ、遷移の名前が残っていない（重なり順が崩れて押せなくなる第 1 版の不具合を繰り返さない）。→ Task 8 の e2e。
5. **一時停止のまま・遅い端末で Tips から移る**: カメラは飛ばずにそのまま移り、移り先の冒頭はその時間帯の静止画。→ Task 8 の e2e。

---

## ファイルの地図

| ファイル | 役割 | タスク |
|---|---|---|
| `src/modules/atelier/lib/types.ts` | `PropId`・`PropDef`・`FrameDef`・`PageKey`・`Phase`・`MotionName` | 1 |
| `src/modules/atelier/lib/props.ts` | 置き物と移り先の表（spec §5.2）と `assertPropsOneToOne` | 1 |
| `src/modules/atelier/lib/frames.ts` | 展示の壁の額（spec §8）と `wallFrames` | 1 |
| `src/modules/atelier/lib/pages.ts` | ページごとの静止画のカメラ（`STILL_VIEWS`）と `pageKeyForPath` | 1 |
| `src/modules/atelier/lib/route.ts` | 道のレール（点列 → 位置・向き・止まる所） | 1 |
| `src/modules/atelier/lib/walk.ts` | 進む・止まるの加減速 | 1 |
| `src/modules/atelier/lib/sky.ts` | 時間帯の判定・訪問の固定・時間帯ごとの光の表 | 1 |
| `src/modules/atelier/lib/motions.ts` | 身ぶりのランダムな選び方 | 1 |
| `src/modules/atelier/lib/{quality,markers,glb}.ts` | 第 1 版から移す | 1 |
| `assets-original/atelier/`（追跡しない） | `atelier.blend`・ダウンロードした素材・`README.md` | 2 |
| `src/modules/atelier/assets/atelier.glb`・`atelier-mobile.glb` | 空間（配信する） | 2 |
| `src/modules/atelier/assets/sky/<phase>.webp` | 朝・昼・夕方の空（夜は three で描く） | 2 |
| `src/modules/atelier/assets/README.md` | 素材の出どころとライセンス | 2 |
| `src/modules/atelier/tools/blender/build_atelier.py` | Blender のスクリプト（正本） | 2 |
| `src/modules/atelier/lib/scene.ts` | three のシーン（glb・空・星・光・アバター・投影・カメラの移動） | 3・4・7 |
| `src/modules/atelier/islands/AtelierIsland.tsx` | 島（読み込み・ポスターとの入れ替え・判定・一時停止・歩く） | 3・4 |
| `src/modules/atelier/islands/AtelierTouch.tsx` | 重ねたボタン・Tips・長押し | 6 |
| `src/modules/atelier/components/AtelierHero.astro` | トップのヒーロー | 3 |
| `src/modules/atelier/components/AtelierTips.tsx` | Tips の札 | 6 |
| `src/modules/atelier/components/AtelierList.astro` | 動かないときの一覧 | 6 |
| `src/modules/atelier/components/AtelierStill.astro` | 下層ページの冒頭の静止画 | 7 |
| `src/modules/atelier/components/atelier.css` | 枠・ポスター・遷移・時間帯の覆い | 3・8 |
| `src/modules/atelier/tools/capture-stills.mjs` | ポスター・静止画の書き出し（`pnpm atelier:stills`） | 3 |
| `src/modules/atelier/assets/stills/<key>-<phase>[-mobile].webp` | ポスター・静止画 | 3・7 |
| `src/modules/layout/components/BaseLayout.astro` | head の時間帯の inline script（Task 3）、`AvatarDock` を外す（Task 9） | 3・9 |
| `src/styles/theme.css` | 時間帯のトークン | 3 |
| `src/modules/avatar/lib/figure.ts`・`figure-assets.ts` | 身ぶりを名前で再生 | 5 |
| `src/modules/site-content/atelier.ts` | Tips・額・ボタン・名札の文言 | 6 |
| `src/modules/page-transition/lib/names.ts` | `VT.atelier` | 8 |

---

### Task 1: アトリエの論理

**Files:**
- Create: `src/modules/atelier/lib/{types,props,frames,pages,route,walk,sky,motions}.ts`, `src/modules/atelier/client.ts`, `src/modules/atelier/index.ts`
- Move（`git mv` は使わず、ファイルを複製してから第 1 版の側は Task 10 で消す）: `src/modules/diorama/lib/{quality,markers,glb}.ts` → `src/modules/atelier/lib/`、`tests/modules/diorama/{quality,markers}.test.ts` → `tests/modules/atelier/`
- Test: `tests/modules/atelier/{props,frames,pages,route,walk,sky,motions,quality,markers}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PageKey = 'top'|'services'|'service:environment-setup'|'service:development'|'service:consulting'|'service:partnership'|'about'|'pricing'|'blog'|'contact'|'contactThanks'|'accessibility';
  export type PropId = 'nameplate'|'avatar'|'envSetup'|'development'|'consulting'|'partnership'|'pricing'|'blog'|'wall'|'contact';
  export interface PropDef { id: PropId; node: `prop_${PropId}`; anchor: `anchor_${PropId}`; href: string | null; still: PageKey | null; }
  export const PROPS: Readonly<Record<PropId, PropDef>>;
  export function assertPropsOneToOne(props: Readonly<Record<string, PropDef>>): void; // 破綻があれば Error（メッセージに id と理由）
  export type FrameId = 'experience'|'jis'|'lighthouse'|'agents'|`case:${'keizu'|'egnity'|'sho-rise'}`;
  export interface FrameDef { id: FrameId; kind: 'self'|'case'; href: string | null; still: PageKey | null; }
  export const SELF_FRAMES: readonly FrameDef[]; export const FRAME_SLOTS = 7;
  export function wallFrames(cases: readonly CaseStudy[]): readonly (FrameDef | null)[]; // 長さは常に FRAME_SLOTS。空きは null（無地の額）
  export interface StillView { camera: `cam_${string}`; showsAvatar: boolean; mobile: boolean; }
  export const STILL_VIEWS: Readonly<Record<PageKey, StillView>>;
  export function pageKeyForPath(path: string): PageKey | null;
  export interface Rail { length: number; at(t: number): { position: [number,number,number]; forward: [number,number,number] }; stops: readonly { id: PropId; t: number }[]; nextStop(t: number): number; prevStop(t: number): number; }
  export function createRail(points: readonly [number,number,number][], stops: readonly { id: PropId; point: [number,number,number] }[]): Rail;
  export interface Walker { t: number; speed: number; step(dtSec: number, intent: -1|0|1): number; jumpTo(t: number): void; }
  export function createWalker(opts: { maxSpeed: number; accelSec: number; decelSec: number; start?: number }): Walker;
  export type Phase = 'morning'|'day'|'dusk'|'night';
  export const PHASE_BOUNDS: readonly { phase: Phase; from: number }[]; // 時（0〜24）。[{morning,5},{day,10},{dusk,16},{night,19}]
  export function phaseAt(date: Date): Phase;
  export function visitPhase(storage: Pick<Storage,'getItem'|'setItem'> | null, now: Date): Phase;
  export interface PhaseLight { exposure: number; hemi: { sky: string; ground: string; intensity: number }; sun: { color: string; intensity: number; dir: [number,number,number] } | null; lamps: number; starfield: boolean; skyUrlKey: Phase | null; }
  export const PHASE_LIGHTS: Readonly<Record<Phase, PhaseLight>>;
  export type MotionName = 'greeting'|'nod'|'peace'|'point'|'show-full-body'|'think';
  export const MOTIONS: readonly MotionName[];
  export function pickMotion(last: MotionName | null, random: () => number): MotionName;
  ```
  `quality.ts`（`decideQuality`）・`markers.ts`（`layoutMarkers`）・`glb.ts`（`readGlbJson`）は第 1 版のまま。`client.ts` は上をすべて re-export する。`index.ts` はこのタスクでは `export * from './client'` だけ。

- [ ] **Step 1: 失敗するテストを書く**

  `props.test.ts`:
  - 正常系 `PROPS のキーと各 id が一致し、node・anchor は prop_<id>・anchor_<id>`
  - 正常系 `移り先は spec §5.2 のとおり`（`nameplate`→`/about/`・`envSetup`→`/services/environment-setup/`・`development`→`/services/development/`・`consulting`→`/services/consulting/`・`partnership`→`/services/partnership/`・`pricing`→`/pricing/`・`blog`→`/blog/`・`contact`→`/contact/`、`avatar` と `wall` は `href: null`）
  - 正常系 `href のある置き物の still は pageKeyForPath(href) と同じ`
  - 正常系 `PROPS は assertPropsOneToOne を通る`
  - 異常系 `入力: 2 つの置き物が同じ href を持つと拒む`
  - 異常系 `入力: still が href のページと違うと拒む`（`{ href: '/pricing/', still: 'blog' }`）
  - 異常系 `入力: href が null なのに still があると拒む`
  - `空入力: 空の表は拒む`

  `frames.test.ts`:
  - 正常系 `許可の無い 3 社では、自社の額 4 つと null 3 つ（長さ 7）`
  - 正常系 `移り先を持つ自社の額は jis（/accessibility/・still accessibility）だけ。experience・lighthouse・agents は href も still も null`
  - 正常系 `granted の会社が 1 件あると、その額（kind case・href '/#cases'・still null）が自社の額の後に入り、null が 1 つ減る`
  - 正常系 `額の href は、置き物の href と重ならない`（1 対 1）
  - 異常系 `入力: 許可済みが枠を超えたら、超えた分は入れず元の順を保つ`
  - `空入力: cases が空でも長さ 7`

  `pages.test.ts`:
  - 正常系 `12 のページすべてに STILL_VIEWS がある。camera は cam_ ＋ PageKey の : を _ に変えたもの`
  - 正常系 `mobile が true なのは top・services とサービス詳細 4 本`（A の背景は Mobile 用の縦長の構図を別に撮る）
  - 正常系 `showsAvatar が true なのは top と about`
  - 正常系 `pageKeyForPath は末尾の / の有無を問わず 12 のページを返し、/accessibility も返す`
  - 異常系 `入力: 知らないサービスの slug・規約のページは null`
  - `空入力: 空の文字列は null`

  `route.test.ts`:
  - 正常系 `at(0) は最初の点、at(1) は最後の点`
  - 正常系 `at は長さに比例して進む`（直線の 3 点 [0,0,0]→[0,0,-2]→[0,0,-4] で `at(0.25)` が z=-1）
  - 正常系 `forward は進む向きの単位ベクトル`
  - 正常系 `stops は t の昇順で、各置き物の点にいちばん近いレールの位置`
  - 正常系 `nextStop・prevStop は今の t の次・前の止まる所。端では 1・0`
  - 異常系 `入力: t が範囲外・NaN なら 0〜1 に収める`
  - 異常系 `入力: 点が 2 つ未満なら Error`
  - `空入力: stops が空なら nextStop は 1、prevStop は 0`

  `walk.test.ts`（`maxSpeed: 0.1, accelSec: 0.5, decelSec: 0.5`）:
  - 正常系 `intent 1 で速さは accelSec かけて maxSpeed に達する`（0.25 秒後の `speed` が 0.05±0.005、0.5 秒後に 0.1）
  - 正常系 `intent 0 にすると decelSec かけて 0 になり、t は戻らない`
  - 正常系 `t は 1 を超えず、1 に着いたら速さ 0`（行き止まり）
  - 正常系 `intent -1 で戻り、0 を下回らない`
  - 正常系 `jumpTo で t を置き、速さは 0`
  - 異常系 `入力: dt が負・NaN・1 秒を超える値は 0〜0.1 秒に収める`（タブの復帰で飛ばない）
  - `空入力: start を省くと t=0`

  `sky.test.ts`:
  - 正常系 `phaseAt は境目で切り替わる`（4:59 night・5:00 morning・9:59 morning・10:00 day・15:59 day・16:00 dusk・18:59 dusk・19:00 night・0:00 night）
  - 正常系 `visitPhase は最初の呼び出しで atelier:phase に書き、2 回目以降は時刻が変わっても同じ値を返す`（18:59 → 19:01）
  - 正常系 `PHASE_LIGHTS は 4 つの時間帯すべてにあり、夜だけ starfield が true・skyUrlKey が null、夜と夕方は lamps > 0、昼は sun がある`
  - 異常系 `入力: 保存された値が知らない文字列なら、今の時刻で書き直す`
  - 異常系 `入力: storage が null（使えない）なら今の時刻の時間帯を返し、投げない`
  - 異常系 `入力: storage.setItem が投げても今の時刻の時間帯を返す`

  `motions.test.ts`:
  - 正常系 `MOTIONS は 6 つ（idle を含まない）`
  - 正常系 `直前と同じものは選ばない`（`random` を 0 固定にしても、last が MOTIONS[0] なら別のもの）
  - 正常系 `random の値に応じて 6 つすべてが選ばれうる`（last が null）
  - `空入力: last が null なら random だけで決まる`

  `quality.test.ts`・`markers.test.ts` は第 1 版のものを移し、import 先だけ `@/modules/atelier/...` に変える。

  Run: `pnpm test tests/modules/atelier` / Expected: FAIL（モジュールが無い）

- [ ] **Step 2: 各ファイルを書く。** 置き物の表は spec §5.2。`assertPropsOneToOne` の判定は Step 1 の異常系の 3 つと空。`createRail` は点列の折れ線（弧長で t を割る）。`createWalker` は速さを線形に加減速し、`t` を `speed × dt` だけ進める（`dt` は 0〜0.1 秒に収める）。`PHASE_LIGHTS` の値は Task 3 の見た目の確認で直してよい（テストは構造だけを固定）。`pickMotion` は last を除いた配列から `Math.floor(random() * n)`。
- [ ] **Step 3: 通ることを確かめる** — Run: `pnpm test tests/modules/atelier && pnpm test tests/modules/diorama` / Expected: PASS（第 1 版のテストも通ったまま）
- [ ] **Step 4: 差分の確認（コミットしない）** — Run: `git status --short src/modules/atelier tests/modules/atelier`

---

### Task 2: アトリエを Blender で作る（ホスト）

**前提:** ユーザーがホストの Windows で Blender を起動し、MCP のアドオンを有効にしている。`mcp__blender__get_objects_summary` が応答しなければ、ユーザーに起動を頼んで待つ。

**Files:**
- Create（VM）: `src/modules/atelier/tools/blender/build_atelier.py`、`src/modules/atelier/assets/{atelier.glb,atelier-mobile.glb,sky/morning.webp,sky/day.webp,sky/dusk.webp,README.md}`、`assets-original/atelier/{atelier.blend,README.md}`（追跡しない）
- Test: `tests/modules/atelier/asset.test.ts`

**Interfaces:**
- Consumes: `PROPS`・`STILL_VIEWS`・`FRAME_SLOTS`（Task 1）、`readGlbJson`（Task 1）
- Produces: glb のノード名の約束 — 置き物 `prop_<id>`（原点は底面の中心）と `anchor_<id>`（ボタンを重ねる点。置き物の上の少し上。`avatar` は頭の上）、レール `rail_00`〜`rail_NN`（目の高さ 1.6m。番号の順に入口 → 相談の席の前）、静止画のカメラ `cam_<PageKey の : を _ に>`（12 台。`cam_top` はレールの始点に立った一人称）、`avatar_spot`（アバターを立たせる点と向き）、額の面 `frame_00`〜`frame_06`（テクスチャを貼り替える板。UV は 0〜1 で正しい向き）、天窓のガラス `skylight_glass`、ランプの光の位置 `lamp_00`〜（コードが点光源を置く）。

- [ ] **Step 1: 失敗するテストを書く（`asset.test.ts`）**
  - 正常系 `PROPS の node・anchor がすべてノードにある`（両方の glb）
  - 正常系 `STILL_VIEWS の camera がすべてカメラ付きのノードにある`
  - 正常系 `rail_ が 2 本以上、番号が 00 から欠けずに続く`
  - 正常系 `frame_00〜frame_06・avatar_spot・skylight_glass・lamp_00 がある`
  - 正常系 `画像はすべて image/webp`
  - 正常系 `atelier.glb は 3,145,728 バイト以内、atelier-mobile.glb は 1,572,864 バイト以内`
  - 正常系 `sky の 3 枚はそれぞれ 307,200 バイト以内`
  - 異常系 `入力: glb でないファイルは readGlbJson が Error を投げる`

  Run: `pnpm test tests/modules/atelier/asset.test.ts` / Expected: FAIL（ファイルが無い）

- [ ] **Step 2: BlenderKit のログインを確かめる。** `execute_blender_code` で `bpy.context.preferences.addons['bl_ext.user_default.blenderkit'].preferences.api_key` が空でないかだけを見る（値は読まない・出さない）。空なら、ユーザーにホストの Blender で BlenderKit にログインしてもらうよう頼み、ログインできるまで BlenderKit を使う手順（Step 5 のモデル）に進まない（Step 3・4 は先に進めてよい）。
- [ ] **Step 3: Environment。** Poly Haven Assets のアドオンで、朝・昼・夕方に合う HDRI を 1 本ずつ選んで取る（1k）。各 HDRI を World に当て、パノラマ（equirectangular）のカメラで 2048×1024 に描いて PNG にし、VM で `sharp` を使って WebP（品質を下げて 307,200 バイト以内）にして `assets/sky/<phase>.webp` に置く。夜の空は作らない（three で描く。spec §5.3）。
- [ ] **Step 4: Scene と Texture。** 部屋（幅 約 8m・奥行き 約 18m・天井 約 6m。コンクリートの壁・木の床・ガラスの天窓と鉄の枠）を組む。質感は Poly Haven Assets のテクスチャと、Lily Surface Scraper（Poly Haven・ambientCG の URL からだけ）で取る。道筋は spec §5.1 の図（入口 → アバター → 左右に置き物 → 実績の壁 → 相談の席）。レールの点 `rail_NN` を目の高さに、置き物の横を通り抜けない幅で置く。
- [ ] **Step 5: Model。** 置き物（spec §5.2 の表の 10 個。それぞれが表す仕事が一目で分かる形）と小物・植物を、BlenderKit（無料・Royalty Free か CC0）と Poly Haven Assets のモデルで揃える。面を減らす（Decimate など）。実績の壁に額を 7 枚（`frame_00`〜`frame_06`）、相談の席の上にランプ。アバターは置かない（`avatar_spot` の空の点だけ）。
- [ ] **Step 6: 焼き込みと書き出し。** UV を作り直し（第 1 版の教訓: プリミティブの UV は重なっている）、Cycles の DIFFUSE（色＋AO。一様な白い世界）で焼き、置き物ごと・部屋の面ごとにまとめた WebP にする。glTF Binary・WebP・meshopt 圧縮・カメラを含めて `atelier.glb` を書き出す。テクスチャの解像度を半分にした組で `atelier-mobile.glb` も書き出す。`empty()` で作る点は親の逆行列を単位行列にする（第 1 版の教訓: 点がすべて原点に来た）。
- [ ] **Step 7: VM に移す。** 第 1 版と同じ方法（Blender の中の TCPServer を `bpy.app.timers` で受け付け、ポート 8766。VM から `curl -o … http://10.0.2.2:8766/<name>`）。`.blend` とダウンロードした素材は `assets-original/atelier/` へ。Blender のスクリプトは `tools/blender/build_atelier.py` に保存する（第 1 版の `build_diorama.py` と同じく、段階 `build`・`bake`・`export` で再実行できる形）。
- [ ] **Step 8: README を書く。** `assets/README.md` と `assets-original/atelier/README.md` に、ファイル・使った素材の名前・ID・URL・ライセンス（Poly Haven／ambientCG は CC0、BlenderKit は素材ごとの Royalty Free／CC0）・作り方・原本の置き場所（追跡しない）を、`avatar/assets/README.md` と同じ形で。BlenderKit の Royalty Free の素材は、glb に焼き込み・まとめた形だけで配り、素材単体のファイルを配らないことを書く。
- [ ] **Step 9: 通ることを確かめる** — Run: `pnpm test tests/modules/atelier` / Expected: PASS
- [ ] **Step 10: ユーザーの確認（見た目）。** glb を three で読む確認ページ（第 1 版の `diorama-review-v2.html` と同じ作り。ビジュアルコンパニオン `.superpowers/brainstorm/117930-1793149198/content/` に置く）で、`cam_top`・道の中ほど・実績の壁・相談の席を、昼と夜（夜は仮の星）で見せる。直しがあれば Step 3〜9 をやり直す。**承認が出るまで Task 3 に進まない。**
- [ ] **Step 11: 差分の確認（コミットしない）**

---

### Task 3: 描画・島・時間帯・ポスター（歩かない状態）

**Files:**
- Create: `src/modules/atelier/lib/scene.ts`, `src/modules/atelier/islands/AtelierIsland.tsx`, `src/modules/atelier/components/{AtelierHero.astro,atelier.css}`, `src/modules/atelier/tools/capture-stills.mjs`, `src/modules/atelier/lib/stills.ts`
- Modify: `src/modules/layout/components/BaseLayout.astro`（head に時間帯の inline script）、`src/styles/theme.css`（時間帯のトークン）、`src/pages/index.astro`（1-3 を `AtelierHero` に替える）、`src/modules/site-content/a11y.ts`（`MOTION_PAUSE_TARGETS.atelier: "（アトリエ）"`）、`package.json`（`"atelier:stills": "node src/modules/atelier/tools/capture-stills.mjs"`）、`astro.config.mjs`（新しい import があれば `optimizeDeps.include`）
- Test: `e2e/a11y/atelier.spec.ts`（新規。このタスクの分）

**Interfaces:**
- Consumes: `loadThree`・`canUseWebGL`・`runWhenVisible`（`@/modules/motion/client`）、`DURATION`・`EASE`・`cssColor`（`@/modules/motion/lib/tokens`）、`MotionPause`・`useReducedMotion`（`@/modules/a11y/client`）、Task 1 のすべて
- Produces:
  ```ts
  // lib/scene.ts（three はここと tools だけが触る）
  export interface AtelierScene {
    render(dtMs: number): void;
    resize(width: number, height: number, dpr: number): void;
    setWalk(t: number, look: number): void;          // レールの位置（0〜1）と視線の左右（-1〜1）
    setHover(id: PropId | null): void;                // 縁の光
    projectAnchors(): ReadonlyMap<PropId | `frame:${number}`, { x: number; y: number; visible: boolean }>; // canvas の CSS px
    pick(x: number, y: number): PropId | `frame:${number}` | null;
    flyTo(camera: `cam_${string}`, ms: number): Promise<void>; // Task 8
    avatar: { play(name: MotionName): Promise<void>; playing: boolean } | null; // Task 5
    dispose(): void;
  }
  export function createAtelierScene(three: typeof import('three'), canvas: HTMLCanvasElement, opts: { glbUrl: string; skyUrls: Partial<Record<Phase, string>>; phase: Phase; camera: `cam_${string}` | 'walk'; frozen?: boolean; frameTextures?: readonly (HTMLCanvasElement | null)[]; avatar?: AvatarFigureOptions }): Promise<AtelierScene>;
  // lib/stills.ts
  export interface Still { desktop: string; mobile: string | null; anchors: Record<string, { x: number; y: number }> | null; }
  export function stillOf(page: PageKey, phase: Phase): Still;
  export function stillSet(page: PageKey): Record<Phase, Still>; // inline script に渡す 4 つ分
  ```
  島の props: `{ page: 'top'; glbUrl: string; mobileGlbUrl: string; skyUrls: Partial<Record<Phase,string>>; pauseLabel: string; resumeLabel: string; pauseTarget: string; touch?: AtelierTouchCopy /* Task 6 */; avatar?: AvatarFigureOptions /* Task 5 */ }`。根（`[data-motion="atelier"]`）に `data-atelier-live`・`data-motion-paused` を付け外しし、canvas に `data-frame`（描いた枚数）を書く。

- [ ] **Step 1: 失敗する e2e を書く（`atelier.spec.ts`、ルート `/`）**
  - `ポスターが最初の HTML にあり、h1 は 3D を待たずに読める`（JS を止めたページで、昼のポスターと h1 が見える）
  - `時間帯の属性が最初の描画の前に <html data-atelier-phase> に付き、ポスターはその時間帯の画像`（`page.clock.setFixedTime` で 21:00 → `night`、ポスターの src が `top-night`）
  - `ポスターは 1 枚だけ要求される`（ほかの時間帯の画像の要求が 0）
  - `WebGL があれば canvas に替わり、入れ替わる間の CLS が 0`（`presetLive`）
  - `reduced-motion では three を読まず、ポスターのまま`
  - `一時停止で data-frame が止まり、次に開いても最初から止まっている`
  - `WebGL が無いとポスターのまま`
  - `遅い端末はポスターのまま`（rAF を 60ms 遅らせる。第 1 版と同じ作り）
  - `canvas は aria-hidden、axe の違反 0`
  - `時間帯の覆いの上の文字のコントラストが 4.5 以上`（朝・昼・夕方・夜の 4 つ。`page.clock`）

  Run: `STRAPI_URL=http://localhost:1337 pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts` / Expected: FAIL

- [ ] **Step 2: 時間帯の inline script と トークン。** `BaseLayout.astro` の head の先頭に、`<script is:inline define:vars={{ bounds: PHASE_BOUNDS }}>` で `visitPhase` と同じ規則（`atelier:phase` を読み、無ければ今の時刻で決めて書く。`sessionStorage` が使えなければ今の時刻）を書き、`document.documentElement.dataset.atelierPhase` を付ける。規則は `sky.ts` と 2 か所になるので、e2e の「境目」の検査（Task 8）で両方を見る。`theme.css` に `--atelier-veil`（文字の後ろの覆い）・`--atelier-tip-bg`・`--atelier-tip-text` を時間帯ごとに定義する（`:root[data-atelier-phase="night"]` など。既定は昼）。
- [ ] **Step 3: `scene.ts` を書く。** glb を GLTFLoader ＋ MeshoptDecoder で読む（第 1 版と同じ）。素材は glb のまま。光は `PHASE_LIGHTS[phase]`（HemisphereLight・DirectionalLight〈天窓から〉・`lamp_NN` に PointLight〈影なし〉）と `toneMappingExposure`。空は、朝・昼・夕方は `skyUrls[phase]` の equirect を `scene.background` と PMREM の環境に、夜は暗い紺の背景に、決まった種で並べた星（Points。大きさと明るさにばらつき、ゆっくりまたたく。またたきの周期は 2 秒以上）と淡い天の川（星の帯を密に、加算の板）を描く。額の面には `frameTextures` を貼る（Task 6 まで無地）。`camera: 'walk'` のときは `setWalk` のレールの位置に一人称のカメラを置き、`look` で最大 12 度だけ左右を向く。`cam_*` のときはそのカメラの位置・向きで、設計の画角（16:9）を枠に収める（第 1 版と同じ「contain」）。`frozen` のときは 1 枚だけ描く（ポスター用）。
- [ ] **Step 4: `AtelierIsland.tsx` を書く。** 第 1 版の `DioramaIsland.tsx` の流れ（WebGL の確認 → `motion:atelier` → 手が空いてから `loadThree()` と glb〈768px 未満は `mobileGlbUrl`〉を読む → 最初の 1 枚を描いてから 2 フレーム待って `data-atelier-live` → ポスターを `DURATION.medium` で消す → 最初の 3 秒を `decideQuality` に渡し、結果を `atelier:quality` に残す）を移す。時間帯は `document.documentElement.dataset.atelierPhase` を読む。`runWhenVisible` で画面外・非表示では止める。一時停止のボタンの表示は、水和の後 2 フレームだけ `visibility: hidden`（第 1 版の CLS の教訓）。
- [ ] **Step 5: `AtelierHero.astro` を書き、トップの 1-3 を替える。** 高さ `100svh`（最小 560px）、canvas は背面、文字（slot `copy`・`actions`）は左下、文字の後ろに `--atelier-veil` の覆い。ポスターは `<picture>` に、4 つの時間帯の URL を `data-src-<phase>`・`data-srcset-mobile-<phase>` で持たせ、`src` は付けない。直後の `<script is:inline>` が `data-atelier-phase` の分だけ `src`・`srcset` を入れる（ほかの時間帯を読ませない）。`<noscript>` に昼のポスター。`index.astro` の `DioramaHero` を `AtelierHero` に替える（`dioramaTouch` は使わなくなる。消すのは Task 10）。Task 9 で端のアバターを消すまでの間は、アトリエの根に `data-avatar-yield-source` を付け、端のアバターを引っ込める（第 1 版の仕組み。同じ画面に 2 人いない）。
- [ ] **Step 6: 書き出しの道具（`capture-stills.mjs`）。** 第 1 版の `diorama/tools/capture-stills.mjs` を移し、PageKey × 時間帯で `frozen: true` の 1 枚を描く。Desktop は 1600×900（`top`・A の背景）または 960×720（B の 4:3）または 1440×810（`accessibility` の 16:9）、`STILL_VIEWS[key].mobile` のものは Mobile 用 780×1040 も。WebP で `assets/stills/<key>-<phase>[-mobile].webp`、ボタンの位置を `<key>-<phase>[-mobile].anchors.json` に出す。`--use-angle=swiftshader` を渡す。ポスター（`top`）は予算（Desktop 204,800・Mobile 122,880 バイト）を超えたら品質を下げて書き直す。

  Run: `astro dev --background && pnpm atelier:stills` / Expected: `assets/stills/` に 12 × 4 ＋ 6 × 4 ＝ 72 枚の画像と同じ数の JSON。`top-night.webp` に星、`top-day.webp` に青空が写る
- [ ] **Step 7: 通ることを確かめる** — Run: `STRAPI_URL=http://localhost:1337 pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts && pnpm test` / Expected: PASS（単体の失敗は作業前からの 24 件のまま）。`rg -l "isWebGLRenderer" dist/_astro | wc -l` が 1
- [ ] **Step 8: 差分の確認（コミットしない）**

---

### Task 4: 歩く（マウス・長押し・キーボード）

**Files:**
- Modify: `src/modules/atelier/islands/AtelierIsland.tsx`, `src/modules/atelier/lib/scene.ts`, `src/modules/atelier/components/{AtelierHero.astro,atelier.css}`
- Test: `e2e/a11y/atelier.spec.ts`（歩く分）

**Interfaces:**
- Consumes: `createRail`・`createWalker`（Task 1）、`AtelierScene.setWalk`（Task 3）
- Produces: 島の根に `data-atelier-t`（0〜1。小数 3 桁）と `data-atelier-walking`（進んでいる間）。ボタン「前へ進む」「入口に戻る」（文言は `ATELIER.forward`・`ATELIER.back`）。

- [ ] **Step 0: 文言の確認（ユーザー）。** このタスクから新しい文言が要るので、**Task 6 で使う分も含めて、新しい文言をすべてここでまとめて**確認を取る: 「前へ進む」「入口に戻る」「閉じる」・操作の案内（hint）・アバターの名札・置き物 8 つの Tips（見出し 20 字・説明 60 字まで・「見る」の文字）・自社の額 4 枚（題・説明。`lighthouse` は今の build で `pnpm lh` を走らせて測った値だけを書く。測れなければその額は題だけ）・他社の額の「見る」・動かないときの一覧の見出し。言い回しは既存の `site-content`（`services.ts`・`top.ts`）の口調に合わせ、架空の数値・社名を入れない。**承認が出るまで Step 1 以降に進まない。** 承認の日時を作業台帳に残し、承認された文言で `src/modules/site-content/atelier.ts`（型は Task 6 の Interfaces）を書く。

- [ ] **Step 1: 失敗する e2e を書く**
  - `canvas の空いた所にカーソルを置くと進み、外すとゆっくり止まる`（`data-atelier-t` が増え、外した後も少し増えてから止まる）
  - `文字・CTA の上にカーソルがある間は進まない`（Review Focus 1）
  - `ホイールはページをスクロールし、進まない`
  - `相談の席の前（t=1）で止まり、それ以上進まない`
  - `少しでも進むと「入口に戻る」が出て、押すと t が 0 へ戻る`
  - `キーボード: 「前へ進む」を押すと次の止まる所まで進む。↑ を押している間は進み、↓ で戻る`（フォーカスがヒーローの中にあるときだけ）
  - `Mobile（hasTouch）: 空いた所を 300ms 以上押している間だけ進む。短いタップでは進まない。長押しで文字の選択・メニューが出ない`（Review Focus 2。`getSelection().toString()` が空、`contextmenu` が既定で止まる）
  - `Mobile: 縦のスワイプはページをスクロールする`
  - `進んだ位置は atelier:pos に残り、開き直すと同じ位置から描く`
  - `一時停止の間も進める`（spec §6.5）
  - `axe の違反 0。「前へ進む」「入口に戻る」は 24px 以上`

  Run: `pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts` / Expected: FAIL
- [ ] **Step 2: レールと歩く仕組みをつなぐ。** glb の `rail_NN` から `createRail`、各 `anchor_<id>` の位置から止まる所を作る。毎フレーム `walker.step(dt, intent)` → `scene.setWalk(t, look)`。`intent` は、ポインター（マウス）が canvas の空いた所にある間 1、長押し中 1、↑ 1・↓ -1、それ以外 0。`look` はカーソルの左右の位置（-1〜1）。置き物の上（`scene.pick` が値を返す）では 0。速さは `maxSpeed` 0.07（端から端まで約 15 秒）、`accelSec` 0.6、`decelSec` 0.8（作り手が見た目で直してよい）。
- [ ] **Step 3: ボタンと入力。** 「前へ進む」は `rail.nextStop(t)` まで、「入口に戻る」は 0 まで、`walker` で動かす（瞬間移動しない）。長押しは `pointerdown`（`pointerType: 'touch'`）から 300ms、動きが 10px 未満のときに始め、`pointerup`・`pointercancel` で終える。根に `touch-action: pan-y`・`-webkit-touch-callout: none`・`user-select: none`（文字の層には付けない）。`t` を 0.5 秒ごとと `pagehide` で `atelier:pos` に書き、起動時に読む。
- [ ] **Step 4: 通ることを確かめる** — Run: `pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts` / Expected: PASS
- [ ] **Step 5: 差分の確認（コミットしない）**

---

### Task 5: 代表のアバター（押すとランダムに身ぶり）

**Files:**
- Modify: `src/modules/avatar/lib/figure.ts`, `src/modules/avatar/lib/figure-assets.ts`, `src/modules/atelier/lib/scene.ts`, `src/modules/atelier/islands/AtelierIsland.tsx`
- Test: `tests/modules/avatar/figure.test.ts`（新規）、`e2e/a11y/atelier.spec.ts`（アバターの分）

**Interfaces:**
- Consumes: `MOTIONS`・`pickMotion`（Task 1）
- Produces:
  ```ts
  export interface AvatarFigureOptions { modelUrl: string; idleUrl: string; clipUrls: Partial<Record<MotionName, string>>; /** 第 1 版の互換。Task 10 で消す */ nodUrl?: string; }
  export interface AvatarFigure { object: THREE.Object3D; update(dtSec: number): void; play(name: MotionName): Promise<void>; readonly playing: boolean; nod(): void; dispose(): void; }
  export const AVATAR_FIGURE_ASSETS: { modelUrl: string; idleUrl: string; nodUrl: string; clipUrls: Record<MotionName, string> };
  ```
  `play` は、再生中に呼ばれたら今のクリップの終わりを待ってから次を再生する（spec §6.4）。`nod()` は `play('nod')` と同じ。

- [ ] **Step 1: 失敗するテストを書く**
  - `figure.test.ts`（three・three-vrm・GLTFLoader・fetch はモック）: 正常系 `play で指定のクリップを 1 回だけ再生し、終わると待機に戻って Promise が解決する`／正常系 `再生中に play を呼ぶと、今のクリップが終わってから次を再生する`／正常系 `clipUrls のクリップは最初の play の前に読み込みを始める`（読み込み済みなら待たない）／異常系 `サーバ: クリップの取得が 404 なら play は reject し、待機のまま`／異常系 `入力: clipUrls に無い名前の play は reject`／`空入力: clipUrls が空でも作れて、待機だけ`
  - `atelier.spec.ts`: `アバターのボタン（名札の名前）を押すと身ぶりが始まる`（根の `data-atelier-avatar-motion` に MOTIONS のどれか）／`続けて押しても同じ身ぶりが 2 回続かない`（10 回押して隣り合う値が違う）／`Enter でも同じ`／`カーソルを乗せると名札が出て、ページは移らない`
  - Run: `pnpm test tests/modules/avatar/figure.test.ts && pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts` / Expected: FAIL
- [ ] **Step 2: `figure.ts`・`figure-assets.ts` を書き換える。** 身ぶりのクリップを名前ごとに `AnimationAction`（`LoopOnce`）にし、`finished` で待機へ `fadeIn(0.3)`。`figure-assets.ts` に 6 つの `?url` を足す（`idle` は待機）。第 1 版の `diorama/lib/scene.ts` が `nod()` を呼ぶので残す。
- [ ] **Step 3: アトリエに立たせる。** `scene.ts` が `avatar` を受けたら、アトリエの描画が始まった後に `@/modules/avatar/lib/figure` を動的 import して `avatar_spot` に置く（第 1 版と同じ置き方。大きさは人の背丈）。島はアバターのボタン（canvas の上の本物の `<button>`。`anchor_avatar` の位置）を押されたら `pickMotion(last, Math.random)` → `scene.avatar.play(name)`。根の `data-atelier-avatar-motion` に今の名前を書く。アバターは Mobile でも出す（spec §6.4 の「中央の前方に立たせる」は端末を問わない。第 1 版の M-5〈Mobile で人形を出すか〉の問いは、A-4 でアバターを空間の主役にしたことで「出す」に決着したと読む。作業台帳に Ruling として残す）。
- [ ] **Step 4: 通ることを確かめる** — Run: Step 1 と同じ / Expected: PASS
- [ ] **Step 5: 差分の確認（コミットしない）**

---

### Task 6: 置き物と Tips・展示の壁・動かないときの一覧

**Files:**
- Create: `src/modules/atelier/islands/AtelierTouch.tsx`, `src/modules/atelier/components/{AtelierTips.tsx,AtelierList.astro}`, `tests/modules/site-content/atelier.test.ts`（`site-content/atelier.ts` は Task 4 の Step 0 で作る）
- Modify: `src/modules/atelier/lib/scene.ts`（額のテクスチャ）、`src/modules/atelier/islands/AtelierIsland.tsx`、`src/modules/atelier/components/AtelierHero.astro`、`src/pages/index.astro`（1-8 の節に `id="cases"` が無ければ足す）
- Test: `e2e/a11y/atelier.spec.ts`（Tips の分）、`e2e/a11y/keyboard.spec.ts`（必要なら）

**Interfaces:**
- Consumes: `PROPS`・`wallFrames`・`layoutMarkers`・`stillOf`（Task 1・3）、`publishedCases`（`site-content/cases.ts`）、`scene.pick`・`projectAnchors`・`setHover`（Task 3）
- Produces:
  ```ts
  // site-content/atelier.ts
  export interface AtelierTipCopy { heading: string; body: string; cta: string; }
  export const ATELIER: { hint: string; forward: string; back: string; close: string; avatarName: string; listHeading: string; props: Record<Exclude<PropId,'avatar'|'wall'>, AtelierTipCopy>; frames: Record<'experience'|'jis'|'lighthouse'|'agents', { title: string; body: string; cta?: string }>; caseCta: string; };
  // islands/AtelierTouch.tsx
  export interface AtelierTouchCopy { /* ATELIER をそのまま渡す ＋ 各 Tips の画像 URL（stillOf(prop.still, phase).desktop） */ }
  ```

- [ ] **Step 1: 文言を確かめる。** Task 4 の Step 0 で承認された文言が `site-content/atelier.ts` にすべてあることを確かめる。足りない文言が見つかったら、その分だけユーザーの確認を取ってから足す（承認の前に書かない）。
- [ ] **Step 2: 失敗するテストを書く**
  - `site-content/atelier.test.ts`: 正常系 `置き物 8 つ・自社の額 4 枚の文言がある`／正常系 `Tips の見出しは 20 字・説明は 60 字以内`／正常系 `【要記入】などの仮の印を含まない`／`空入力: 空の文字列が無い`
  - `atelier.spec.ts`:
    - `置き物にカーソルを乗せると縁が光り、Tips（画像・見出し・説明・見る）が出る。画像は移り先の静止画（その時間帯）`
    - `Tips を開いている間はカーソルを動かしても進まない`（Review Focus 1）
    - `Tips の「見る」を押すと移り先のページへ移る`（全 8 つ。移り先の URL を照合）
    - `Tab で置き物のボタンを順にたどれ、Enter で Tips、もう一度 Enter（「見る」）で移る`
    - `Escape・外側を押す・ヒーローが画面から出る、で閉じる。外側を押したときはフォーカスを戻さない`（第 1 版の I-1）
    - `Mobile: 1 回目のタップで Tips、Tips のタップで移る。置き物の長押しは歩かず Tips`（Review Focus 2）
    - `ボタンどうしは 24px 以上離れ、枠の外の置き物のボタンも隠れない`
    - `展示の壁: 額は 7 枚、許可の無い会社の名前はページのどこにも無い。jis の額だけが Tips に「見る」を持ち /accessibility/ へ移る`
    - `cases.ts を granted にした場合の額`（`page.route` で差し替えられないので、単体の `wallFrames` のテストで見る。ここでは書かない）
    - `reduced-motion・WebGL なし・遅い端末では、ポスターと一覧（置き物 8 つの画像・見出し・説明・リンク）が出て、リンクは 8 つの移り先へ行く`
    - `axe の違反 0（Tips を開いた状態・一覧の状態）`
  - Run: `pnpm test tests/modules/site-content && pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts` / Expected: FAIL
- [ ] **Step 3: 書く。** `AtelierTouch.tsx` は第 1 版の `DioramaTouch.tsx`（点の配置・ResizeObserver・`close(restoreFocus)`・ヒーローの IntersectionObserver）を土台に、パネルを Tips の札に替える。Tips は非モーダル（`role="dialog"`・`aria-labelledby`）。Mobile（767px 以下）は第 1 版と同じく、点を重ねず枠の上端に名前の列（横スクロール）にする。額のテクスチャは、`ATELIER.frames` の題と説明を `<canvas>`（2D）に描いて `frameTextures` として渡す（文字は site-content が正本。画像の書き出し〈Task 3 の道具〉でも同じ関数を使う）。`AtelierList.astro` は、島が動かない状態（`data-atelier-live` が無い）のときに見える一覧（本物の `<a>`）。JS が無くても見える。
- [ ] **Step 4: 静止画を書き出し直す**（額に文字が入ったため）— Run: `pnpm atelier:stills`
- [ ] **Step 5: 通ることを確かめる** — Run: Step 2 と同じ / Expected: PASS
- [ ] **Step 6: 差分の確認（コミットしない）**

---

### Task 7: 下層ページの冒頭（静止画）

**Files:**
- Create: `src/modules/atelier/components/AtelierStill.astro`
- Modify: `src/pages/{about,pricing,accessibility}.astro`, `src/pages/blog/_BlogListing.astro`, `src/pages/contact/{index,thanks}.astro`, `src/pages/services/{index,[slug]}.astro`, `src/modules/layout/components/PageIntro.astro`（Mobile でも media を出す）
- Test: `e2e/a11y/atelier.spec.ts`（下層ページの分）

**Interfaces:**
- Consumes: `stillSet`（Task 3）、`STILL_VIEWS`（Task 1）
- Produces: `<AtelierStill page={PageKey} variant="media"|"backdrop"|"banner" />`。`media`＝B の 4:3（PageIntro の `slot="media"`）、`backdrop`＝サービスの紺の地の背景（Desktop は全面・Mobile は 4:3 の塊。第 1 版の `DioramaIntro` と同じ置き方）、`banner`＝`/accessibility/` の h1 の上の 16:9。根に `data-atelier-still={page}`。ポスターと同じく、時間帯の分だけを inline script で入れる。

- [ ] **Step 1: 失敗する e2e を書く**
  - `12 − 1（top）＝ 11 のページの冒頭に、その時間帯の静止画が 1 枚だけある`（`page.clock` で 4 つの時間帯）
  - `Mobile でも静止画が出る`（第 1 版は Desktop だけ。spec §7）
  - `/accessibility/ は パンくず → 静止画（16:9・720px 幅）→ h1 の順`
  - `静止画は alt=""。JS なしは昼の絵`
  - `会社概要の静止画にはアバターが写る`（`STILL_VIEWS.about.showsAvatar`。書き出しの側の検査: `about-*.anchors.json` に `avatar` の位置がある）
  - `axe の違反 0、CLS 0（Lighthouse の CLS でなく e2e の cls）`
  - Run: `pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts` / Expected: FAIL
- [ ] **Step 2: 書いて、各ページの `DioramaStill`・`DioramaIntro` を `AtelierStill` に替える。** サービスの紺の地は、静止画の上に第 1 版と同じ覆い（`--atelier-veil`）を重ねて文字のコントラストを保つ。`PageIntro.astro` の `md:` だけで出していた media を、Mobile では文字の下に出す。`/accessibility/` は `01-content-spec.md` §4.11 の型に静止画を 1 枚足すだけ（規約・ポリシーの型は触らない）。
- [ ] **Step 3: 通ることを確かめる** — Run: `pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts e2e/a11y/pages.spec.ts e2e/a11y/motion-calm.spec.ts` / Expected: PASS（`motion-calm` の CountUp などの位置の前提が静止画で変われば、第 1 版と同じく数値を直し、作業台帳に Ruling を残す）
- [ ] **Step 4: 差分の確認（コミットしない）**

---

### Task 8: Tips から下層ページへ（カメラの移動としてつなぐ）

**Files:**
- Modify: `src/modules/atelier/lib/scene.ts`（`flyTo`）、`src/modules/atelier/islands/{AtelierIsland,AtelierTouch}.tsx`、`src/modules/atelier/components/{AtelierHero.astro,AtelierStill.astro,atelier.css}`、`src/modules/page-transition/lib/names.ts`（`VT.atelier: "vt-atelier"`）
- Create: `src/modules/atelier/lib/transition.ts`（第 1 版の `diorama/lib/transition.ts` の受け渡しの部分を移す）、`tests/modules/atelier/transition.test.ts`
- Test: `e2e/a11y/atelier.spec.ts`（移る分）

**Interfaces:**
- Produces:
  ```ts
  export interface AtelierVt { from: 'top'; to: PageKey; phase: Phase; at: number; }
  export function writeVt(storage: Pick<Storage,'setItem'> | null, vt: AtelierVt): void;
  export function readVt(storage: Pick<Storage,'getItem'|'removeItem'> | null, page: PageKey, now: number): AtelierVt | null; // 行き先が合い、2 秒以内のものだけ。読んだら消す
  ```

- [ ] **Step 1: 失敗するテストを書く**
  - `transition.test.ts`: 正常系 `書いた行き先と同じページで 2 秒以内なら読める・読んだら消える`／異常系 `入力: 行き先が違う・2 秒を超えた・壊れた JSON は null`／異常系 `入力: storage が null・投げるときも null で投げない`／`空入力: 何も書いていなければ null`
  - `atelier.spec.ts`:
    - `Tips の「見る」を押すと、カメラが移り先のカメラへ動き（data-atelier-flying）、終わってから移る`
    - `移っている間だけ、トップの枠と移り先の静止画に vt-atelier が付き、移った後はどちらにも残らない`
    - `下層ページからブラウザーの「戻る」で帰ると、同じ t から描かれ、Tips は閉じ、vt-atelier が残っていない。置き物のボタンが押せる`（Review Focus 4。`page.goBack()`、bfcache の `pageshow` を含む）
    - `18:59 に開いて 19:01 に Tips から移ると、移り先は夕方（dusk）の静止画`（Review Focus 3。`page.clock`）
    - `一時停止のまま・reduced-motion のときは、カメラを動かさずにすぐ移る`（Review Focus 5）
    - `遅い端末（ポスターと一覧）の一覧のリンクから移っても、移り先はその時間帯の静止画`（Review Focus 5）
  - Run: `pnpm test tests/modules/atelier && pnpm build && pnpm a11y e2e/a11y/atelier.spec.ts` / Expected: FAIL
- [ ] **Step 2: 書く。** `flyTo` は今の一人称の位置・向きから `cam_<to>` の位置・向き・画角へ、`DURATION.large`・`EASE.emphasized` で補間する（途中で壁を通り抜けるなら、レールの上を通ってから向きを変える）。島は着いたら `writeVt` し、`pageswap` で枠に `view-transition-name: vt-atelier` を付け、`pageshow` で外す（第 1 版の Ruling: 名前は遷移の間だけ）。行き先の `AtelierStill` の inline script が `readVt` 相当の判定で、遷移の間だけ同じ名前を付け、`pagereveal` の `finished` か 2 秒で外す。移り方は既定の View Transitions（同じ名前の箱が、トップの枠から静止画の枠へ大きさを変える）に任せ、`atelier.css` で長さと緩急をトークンに合わせる。reduced-motion では `flyTo` も View Transitions も使わない。
- [ ] **Step 3: 通ることを確かめる** — Run: Step 1 と同じ ＋ `pnpm a11y e2e/a11y/page-transition.spec.ts` / Expected: PASS
- [ ] **Step 4: 差分の確認（コミットしない）**

---

### Task 9: 画面の端のアバターを外す

**Files:**
- Modify: `src/modules/layout/components/BaseLayout.astro`（`AvatarDock` を外す）、`src/modules/avatar/{index,client}.ts`、`src/styles/global.css`（アバターの規則）、`src/modules/site-content/a11y.ts`（S-24 のうち端のアバターの名前）、`package.json`（`avatar:stills` を外す）
- Delete: `src/modules/avatar/components/AvatarDock.astro`、`src/modules/avatar/islands/AvatarStage.tsx`、`src/modules/avatar/lib/{stage,emotes,triggers,zoom,prefs,scroll-away,yield}.ts`、`src/modules/avatar/assets/{still,icon}.webp`、`src/modules/avatar/tools/capture-stills.mjs`、`tests/modules/avatar/{emotes,triggers,prefs,scroll-away,yield}.test.ts`、`e2e/a11y/avatar.spec.ts`
- Test: 全体の `pnpm test`・`pnpm a11y`

- [ ] **Step 1: 消す前に、使っている所を洗い出す** — Run: `rg -n "AvatarDock|AvatarStage|watchYield|watchScrollAway|watchTriggers|createEmoteScheduler|readCollapsed|writeCollapsed|readGreeted|readZoom|data-avatar" src e2e tests` / 一覧を作業台帳に残し、上の Delete 以外で出たものは、端のアバターのためだけのものなら消し、そうでなければ Ruling を残して残す。
- [ ] **Step 2: 失敗するテストを書く** — `e2e/a11y/structure.spec.ts`（無ければ `atelier.spec.ts`）に `どのページにも画面の端のアバター（[data-avatar-dock]）が無く、avatar の島のスクリプトも読まれない`（A・B の代表のページ 4 つ）/ Run: `pnpm build && pnpm a11y e2e/a11y/structure.spec.ts` / Expected: FAIL
- [ ] **Step 3: 消す・外す。** `avatar` に残すのは `lib/{clip,figure,figure-assets,types}.ts`・`assets/{avatar.vrm,motions/}`・`tools/{slim-vrm,convert-mixamo}.mjs` とそのテスト（`clip`・`convert-mixamo`・`slim-vrm`・`figure`）。`avatar/assets/README.md` の表から消したファイルを外し、「画面の端のアバターは 2026-10-28 にやめた（A-13）」と書く。他のスペック（`motion-vivid`・`motion-calm`・`keyboard`・`states` など）にある端のアバターの前提（`data-avatar-*` の待ち・アバターを避ける位置の計算）を外す。
- [ ] **Step 4: 通ることを確かめる** — Run: `pnpm test && pnpm build && pnpm a11y` / Expected: 単体は失敗が 24 件より減る（端のアバターの R20 のテストが消えるため。減った数と残りの失敗の名前を作業台帳に書く）。a11y は、作業前からの失敗（Cal.com の埋め込みの揺れ）以外は通る
- [ ] **Step 5: 差分の確認（コミットしない）**

---

### Task 10: 第 1 版の片付けと設計文書の改訂

**Files:**
- Delete: `src/modules/diorama/`（丸ごと）、`tests/modules/diorama/`、`e2e/a11y/diorama.spec.ts`、`src/modules/site-content/diorama.ts`、`MOTION_PAUSE_TARGETS.diorama`、`VT.diorama`、`astro.config.mjs` の diorama の項、`package.json` の `diorama:stills`
- Modify: `src/modules/avatar/lib/{figure,figure-assets}.ts`（`nodUrl`・`nod()` の互換を外す）、`e2e/a11y/{motion,motion-vivid,motion-calm,motion-no-webgl,keyboard,states,page-transition}.spec.ts`（`motion:diorama`・`diorama:quality`・`withoutDiorama` を atelier のキーに）、`src/pages/index.astro`（`dioramaTouch` を消す）
- Modify（文書）: `docs/BasicDesign/DesignSpec/website/05-motion-spec.md`（§8.2・§11 を第 2 版に、アバターの節に「端のアバターはやめた」）、`01-content-spec.md`（1-1・1-3・1-8・2-3・§4.11 の `/accessibility/` の静止画）、`02-component-map.md`（§8）、`docs/RequirementDefinition/AA/05-application-decisions.md`（第 1 版の記述を第 2 版に）、`docs/superpowers/specs/2026-10-28-hero-diorama-design.md` と `docs/superpowers/plans/2026-10-28-hero-diorama.md` の冒頭に「第 2 版（`2026-10-28-hero-atelier-design.md`）で置き換えた」の 1 行

- [ ] **Step 1: 使っている所を洗い出す** — Run: `rg -n "diorama|Diorama" src e2e tests docs/BasicDesign docs/RequirementDefinition astro.config.mjs package.json` / 一覧を作業台帳に残す。
- [ ] **Step 2: 消す・置き換える。** `HeroBackdrop`・`MotionSymbol`（第 1 版から使われていない）と、`motion-vivid.spec.ts` の `describe.skip("ヒーロー")` は、ユーザーの判断がまだなので**消さない**（第 1 版の未決の問い。最終報告でもう一度聞く）。
- [ ] **Step 3: 文書を書き換える。** spec の決定（A-1〜A-20）と ★ を、各文書の既存の書き方（表・番号）に合わせて写す。
- [ ] **Step 4: 通ることを確かめる** — Run: `pnpm test && pnpm build && pnpm a11y && rg -n "diorama" src e2e tests` / Expected: テストは Task 9 の結果と同じ。`rg` は 0 件
- [ ] **Step 5: 差分の確認（コミットしない）**

---

### Task 11: 全体の確認

- [ ] **Step 1: 全体の検査** — Run: `pnpm test`・`STRAPI_URL=http://localhost:1337 pnpm build`・`pnpm a11y`（出力は作業台帳の場所に書き出して末尾を読む）。失敗は名前ごとに、今回の変更が原因か・作業前からかを分けて記録する。
- [ ] **Step 2: Lighthouse** — Run: `pnpm lh` / Expected: トップの accessibility 1.0・SEO 1.0・best-practices 0.9 以上。performance は値を記録（warn）。展示の壁の `lighthouse` の額に書いた値と食い違えば、ユーザーに伝えて文言を直すか聞く。
- [ ] **Step 3: 予算** — `ls -l` で glb 2 本・空 3 枚・ポスター 8 枚が予算の中。`rg -l "isWebGLRenderer" dist/_astro | wc -l` が 1。
- [ ] **Step 4: ユーザーの最終確認。** ビルド済みのサイトを配り（第 1 版と同じく作業用の静的サーバー）、トップ（4 つの時間帯。`?` の付かない URL で、確認のための時間帯の切り替えは開発者ツールの `sessionStorage` の `atelier:phase` を書き換えてもらう）・Tips から下層ページへ・ブラウザーの「戻る」・スマートフォンの幅を、「論理の破綻」「つなぎ目」の 2 つの基準で見てもらう。
- [ ] **Step 5: 差分の確認（コミットしない）**
