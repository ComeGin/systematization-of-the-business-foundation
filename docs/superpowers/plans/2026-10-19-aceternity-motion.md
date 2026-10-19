# 公開サイトの動きの作り込み（Aceternity UI ＋ VRM アバター）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 規約・ポリシー以外の全ページに、Aceternity UI を参考にした動きとページ間の形のつながりを入れる。さらに、代表の VRM アバターを画面の左下に置き、訪問者の操作に合わせてエモートさせる。

**Architecture:** ページの動きの強さを `BaseLayout` の `motionZone`（`vivid`／`calm`／`none`）で決め、部品はそれを props で受ける。Aceternity の原本は `motion/vendor/aceternity/` に置き、ページは `motion/sections/` の包みだけを使う。React に依存しない動きは CSS と素の `<script>`、WebGL（3D Globe とアバター）は React の island で、three.js を共有する。ページのつながりはブラウザ標準の文書間 View Transitions を `page-transition` モジュールで広げる。アバターは `avatar` モジュールで、身ぶりは Mixamo のモーション（FBX）を three-vrm の公式サンプルと同じ方法で VRM の骨格へ当て直し、小さな JSON のクリップに変換して再生する（2026-10-19 のユーザーの決定 U-14）。

**Tech Stack:** Astro 7.3、React 19、Tailwind v4、`motion` 12、`three`・`@pixiv/three-vrm`・`@pixiv/three-vrm-animation`、shadcn CLI（`@aceternity` レジストリ）、vitest、Playwright ＋ axe

**Spec:** `docs/superpowers/specs/2026-10-19-aceternity-motion-design.md`（以下「設計書」。U-1〜U-12 はユーザーの決定、★ は設計者の判断）

## Global Constraints

- 作業ディレクトリは `frontend/verdant-virgo`（パスはここからの相対。`docs/` はリポジトリのルートから）。
- **git の状態を変えない**（`.claude/rules/git.md`）。各タスクの最後は「差分の確認（`git status --short`）」までで、コミットはユーザーが行う。
- **デプロイしない。** ビルド・テストの実行とテストコードの追加はこの作業で許可済み（U-11）。ビルドは `SITE_URL=https://comegin.com pnpm build`。
- パッケージは pnpm 11。依存の追加は `pnpm add <name>@<exact>`。ルートの `pnpm-workspace.yaml` の `minimumReleaseAge`・`trustPolicy` に従い、通らなければ公開から日の経った版を選ぶ。island で使う依存は `astro.config.mjs` の `optimizeDeps.include` にも足す。
- 区分: **A（vivid）＝** `/`、`/services/`、`/services/{environment-setup,development,consulting,partnership}/`。**C（none）＝** `/legal/privacy/`、`/legal/tokushoho/`。**それ以外はすべて B（calm）。**
- **C のページには動き・アバター・形のつながりを一切出さない**（JS も読まない）。
- 動きの規則（`docs/BasicDesign/DesignSpec/website/05-motion-spec.md`）:
  - reduced-motion で止める（`a11y` の `prefersReducedMotion()`／`useReducedMotion()`）。
  - 5 秒を超えて自動で動くものには一時停止ボタン（`MOTION_PAUSE` の文言）を付ける。
  - 点滅は 1 秒に 3 回まで。光の明るさの周期は 1 秒以上にする。
  - 装飾の canvas・SVG は `aria-hidden`。
  - 画面外・タブ非表示で止める（`runWhenVisible`）。
  - フォーカスリングを隠さない。
- **h1・本文・LCP の写真は最初の HTML で読める状態にする。** opacity を 0 から始める演出を h1・本文に使わない（A のヒーローの見出しは opacity 0.35 以上から始める。Task 3）。
- 色はパレット（`theme.css`・`tokens.css` の変数）だけを使う。値の直書き禁止。ロゴ（ComeGin・他社とも）を傾けない・光らせない。他社のロゴは足さない。
- 時間・緩急は `--motion-duration-{micro,small,medium,large}`（120/200/320/600ms）と `--motion-ease-{standard,emphasized}`、JS は `motion/lib/tokens.ts`。足りない値は新しいトークンとして `theme.css` と `tokens.ts` の両方に足す。
- 文言は `src/modules/site-content/` から渡し、部品に既定値を持たせない（H-16）。新しい文言は `docs/BasicDesign/DesignSpec/website/01-content-spec.md` §12 にも同じ文で足す。
- 取り込んだ原本は `vendor/<出典>/<Name>/` に置き、冒頭に出典の URL・取り込み日・ライセンスを書く。こちらの変更には `// a11y:`／`// perf:` の印を付ける（P-10）。Aceternity の**有料（Pro）のコードは使わない。**
- コードのコメント・テスト名・文書は日本語。
- 単体テストの書き方（vitest、`tests/modules/<module>/`）:
  - 対象ごとの describe の中を `describe("正常系")`／`describe("異常系")` に分ける。
  - 公開関数ごとに `空入力: ` のケースを置く。異常系の名前は `入力: ` か `サーバ: ` で始める。
  - 外部はモックする。
- e2e は `e2e/a11y/` に置き、`e2e/support/fixtures` の `test`・`expect` と `./axe` の `open` を使う。既存の `motion.spec.ts` の `instrument()`（rAF と CLS の計数）を真似る。

## Review Focus

1. **reduced-motion の訪問者**: A のページでも、どの部品も rAF を回さない。アバターは静止画（three.js を読まない）にし、一時停止ボタンも出さない。→ Task 3・6・10 の e2e。
2. **JS が無い・遅い**: 見出し・本文・数値の最終値・ツールのバッジ・料金がすべて読める。3D Marquee の複製と数え上げ中の数字は読み上げに出ない。→ Task 4・5・7 の e2e（`javaScriptEnabled: false`）。
3. **キーボードだけの訪問者**: 3D Card・3D Pin・光の縁は、フォーカスでも同じ見た目の変化を起こす。アバターの一時停止・たたむボタンに Tab で届く。アバターが送信ボタンやフォーカスリングに重ならない。→ Task 4・5・10 の e2e。
4. **規約・ポリシーへの行き来**: C のページへ入るとき・出るときに形のつながりが起きない。C のページにアバターの DOM も JS も無い。→ Task 1・8・10 の e2e。
5. **同意バナーとチャットとの共存**: 同意バナーが出ている間、アバターはその上に逃げる。右下の Chatwoot のボタンには重ならない。→ Task 10 の e2e。

---

### Task 1: 区分（motionZone）と、新しいモジュールの骨組み

**Files:**
- Create: `src/modules/motion/lib/zone.ts`、`src/modules/page-transition/{index.ts,client.ts,lib/rules.ts,components/PageTransition.astro}`、`src/modules/avatar/{index.ts,client.ts,lib/types.ts}`
- Modify: `src/modules/motion/index.ts`、`src/modules/motion/client.ts`、`src/modules/layout/components/BaseLayout.astro`、`src/pages/index.astro`、`src/pages/services/index.astro`、`src/pages/services/[slug].astro`、`src/pages/legal/privacy.astro`、`src/pages/legal/tokushoho.astro`
- Test: `tests/modules/page-transition/rules.test.ts`、`e2e/a11y/motion-zone.spec.ts`

**Interfaces:**
- Produces:
  - `type MotionZone = "vivid" | "calm" | "none"`（`motion/lib/zone.ts`。`motion` の `index.ts`・`client.ts` から export）
  - `type LiveZone = Exclude<MotionZone, "none">`
  - `BaseLayout` の prop `motionZone?: MotionZone`（既定 `"calm"`）。`<html data-motion-zone={motionZone}>` を出す。
  - `isStillPath(pathname: string): boolean`（`page-transition/lib/rules.ts`。`/legal/` で始まるパスなら true）
  - `shouldSkipTransition(fromPath: string, toPath: string): boolean`（どちらかが `isStillPath` なら true）
  - `avatar/lib/types.ts` に、Task 10 が使う型（下記）を先に置く:
    ```ts
    export type AvatarTrigger = "arrive" | "reach-pricing" | "cta-intent" | "idle" | "form-success";
    export type VrmaEmote = "greeting" | "peace" | "show-full-body";
    export type ProceduralEmote = "nod" | "point" | "think";
    export type EmoteId = VrmaEmote | ProceduralEmote;
    export interface AvatarLabels { pause: string; resume: string; collapse: string; expand: string; summon: string; }
    ```

- [ ] **Step 1: 失敗するテストを書く**（`tests/modules/page-transition/rules.test.ts`）

```ts
describe("isStillPath", () => {
  describe("正常系", () => {
    it("規約・ポリシーは true", () => {
      expect(isStillPath("/legal/privacy/")).toBe(true);
      expect(isStillPath("/legal/tokushoho")).toBe(true);
    });
    it("ほかのページは false", () => {
      for (const p of ["/", "/services/", "/pricing/", "/blog/x/", "/legalese/"]) expect(isStillPath(p)).toBe(false);
    });
  });
  describe("異常系", () => {
    it("空入力: 空文字は false", () => expect(isStillPath("")).toBe(false));
  });
});
describe("shouldSkipTransition", () => {
  describe("正常系", () => {
    it("C のページへ入る・出るときは true", () => {
      expect(shouldSkipTransition("/", "/legal/privacy/")).toBe(true);
      expect(shouldSkipTransition("/legal/tokushoho/", "/pricing/")).toBe(true);
    });
    it("A・B どうしは false", () => expect(shouldSkipTransition("/services/", "/services/development/")).toBe(false));
  });
  describe("異常系", () => {
    it("空入力: 移動元が空なら移動先だけで決める", () => {
      expect(shouldSkipTransition("", "/legal/privacy/")).toBe(true);
      expect(shouldSkipTransition("", "/")).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる** — `pnpm test tests/modules/page-transition` → FAIL（モジュールが無い）
- [ ] **Step 3: `zone.ts`・`rules.ts`・`avatar/lib/types.ts` と、各 `index.ts`／`client.ts` の export を書く**
- [ ] **Step 4: `BaseLayout` に `motionZone` を足す**
  - A の 6 ルートのページは `motionZone="vivid"`、規約 2 ページは `"none"` を渡す。ほかは渡さない（既定の `calm`）。
  - `PageTransition.astro` は `motionZone !== "none"` のときだけ body の末尾に置く（中身は Task 8。ここでは空の `<script>` でよい）。
- [ ] **Step 5: e2e を書く**（`e2e/a11y/motion-zone.spec.ts`）
  - `/`・`/services/development/` は `html[data-motion-zone="vivid"]`。
  - `/pricing/`・`/blog/`・`/404` 相当（`NOT_FOUND_ROUTE`）は `"calm"`。
  - `/legal/privacy/`・`/legal/tokushoho/` は `"none"`。
- [ ] **Step 6: テストを通す** — `pnpm test tests/modules/page-transition` → PASS。`SITE_URL=https://comegin.com pnpm build && pnpm exec playwright test e2e/a11y/motion-zone.spec.ts` → PASS
- [ ] **Step 7: 差分の確認**（`git status --short`。コミットしない）

---

### Task 2: 依存と Aceternity の原本の取り込み、共通の一時停止、トークン

**Files:**
- Modify: `components.json`（`registries` に `"@aceternity": "https://ui.aceternity.com/registry/{name}.json"`）、`package.json`、`astro.config.mjs`（`optimizeDeps.include`）、`src/styles/theme.css`、`src/modules/motion/lib/tokens.ts`
- Create: `src/modules/motion/vendor/aceternity/<Name>/`（下の一覧）、`src/modules/motion/islands/PauseToggle.tsx`、`src/modules/motion/components/MotionPauseFor.astro`
- Test: `tests/modules/motion/tokens.test.ts`（既存が無ければ作る）

**Interfaces:**
- Produces:
  - `MotionPauseFor.astro` props `{ target: string; storageKey: string; pauseLabel: string; resumeLabel: string; tone?: "light" | "dark"; class?: string }`
    - `#target` の要素に `data-motion-paused="true"|"false"` を付け外しする（中は `PauseToggle` island ＋ `a11y` の `MotionPause`）。
    - `global.css` の `[data-motion-paused="true"], [data-motion-paused="true"] * { animation-play-state: paused !important; }` で CSS の動きを止める。
    - JS の部品は `data-motion-paused` を `MutationObserver` で読んで止める。
    - reduced-motion のときは何も描かない。
  - トークン `--motion-duration-ambient`（ゆっくり漂う動きの 1 周。★ 8000ms）、`--motion-duration-glow`（光の明るさの 1 周。★ 2400ms。1 秒以上の規則）。`tokens.ts` の `DURATION.ambient`・`DURATION.glow` も同じ値にする。
- 取り込む原本（無料のもの。shadcn CLI `pnpm dlx shadcn@latest add @aceternity/<name>` で入れてから `vendor/aceternity/<Name>/` へ移す）:
  - `spotlight-new`、`background-beams`、`text-generate-effect`、`glowing-effect`、`3d-card`、`3d-marquee`、`3d-pin`、`github-globe`
  - 取り込みの段階で有料と分かったもの、または存在しない名前は、同じ見せ方の無料の部品か自作に替え、`vendor/aceternity/README.md` に替えた理由を書く。
- 依存: `three`、`@pixiv/three-vrm`、`@pixiv/three-vrm-animation` と、`github-globe` が要るもの（`three-globe`・`@react-three/fiber`・`@react-three/drei` など。取り込んだ原本の import に従う）。`three` は 1 つの版にそろえる。

- [ ] **Step 1: 失敗するテストを書く** — `tokens.test.ts` の正常系に次を足す。
  - `DURATION.ambient` が 8000、`DURATION.glow` が 2400。
  - `DURATION.glow >= 1000`（点滅の規則）。
  - `theme.css` の `--motion-duration-ambient`・`--motion-duration-glow` が同じ値（`theme-tokens.test.ts` と同じく、ファイルを読んで比べる）。
- [ ] **Step 2: FAIL を確かめる** — `pnpm test tests/modules/motion`
- [ ] **Step 3: トークンを足し、registry・依存・原本を取り込む。原本の冒頭に出典の URL・取り込み日・ライセンスを書く**
- [ ] **Step 4: `PauseToggle.tsx` と `MotionPauseFor.astro`、`global.css` の一時停止の規則を書く**
- [ ] **Step 5: 確かめる** — `pnpm test` → PASS。`pnpm exec astro check` → 新しいエラー 0。`SITE_URL=https://comegin.com pnpm build` → 成功
- [ ] **Step 6: 差分の確認**

---

### Task 3: A のヒーロー（Hero Sections ＋ Backgrounds & Effects）

**Files:**
- Create: `src/modules/motion/sections/hero/{HeroBackdrop.astro,HeroHeading.astro}`
- Modify: `src/pages/index.astro`（1-3）、`src/pages/services/index.astro`（導入）、`src/pages/services/[slug].astro`（導入ヒーロー）、`src/modules/motion/index.ts`
- Test: `e2e/a11y/motion-vivid.spec.ts`（このタスクで作り、Task 4〜6 が足していく）

**Interfaces:**
- Consumes: `MotionPauseFor`（Task 2）、`MOTION_PAUSE`（`site-content/a11y.ts`）
- Produces:
  - `HeroBackdrop.astro` props `{ pauseLabel: string; resumeLabel: string; class?: string }`（根に `data-motion="hero"`）
    - ヒーローの `Section` の中に `absolute inset-0 -z-10` で置く。
    - 中身は navy の地の上のグリッド、`spotlight-new`（漂う。`--motion-duration-ambient`）、`background-beams`（光の筋）。
    - 一時停止は右下（`MotionPauseFor`、storageKey `motion:hero`）。
    - md 以上かつ hover のある端末だけで動かす。Mobile と reduced-motion は静止のグラデーションにする。
  - `HeroHeading.astro` props `{ level: "h1"; class?: string }`、slot に見出しの文字
    - CSS だけで、行ごとに `opacity: .35; filter: blur(6px)` から焦点が合う（`--motion-ease-emphasized`、各行 `--motion-duration-large`、行の間隔 120ms）。
    - JS に依存しない。文字を分割しない（行は既存の `HeadingLines` の行単位）。
- ★ ヒーローの地は navy.900（試作 `zoning.html` の A）。文字は白で、コントラスト 4.5:1 以上を `contrastRatio` で確かめる。既存の写真（LCP）と `MotionSymbol` はそのまま残す。

- [ ] **Step 1: 失敗する e2e を書く**（`motion-vivid.spec.ts` の `describe("ヒーロー")`）
  - 3 ルート（`/`・`/services/`・`/services/development/`）で `[data-motion="hero"]` があり、中の装飾は `aria-hidden`。
  - 通常は 5 秒以内に一時停止ボタン（名前 `MOTION_PAUSE.pause`）が出る。押すと sessionStorage `motion:hero` が `paused` になり、rAF の数が増えない（`instrument()` を共通の `e2e/support/motion.ts` に移して使う）。
  - `emulateMedia({ reducedMotion: "reduce" })` では一時停止ボタンが無く、2 秒の間の rAF の増分が 0。
  - h1 の computed `opacity` は、読み込みの直後でも 0.35 以上。
  - axe の違反 0（`open()`）。motion の CLS（`__motionCls`）は 0.01 未満。
- [ ] **Step 2: FAIL を確かめる** — `pnpm exec playwright test e2e/a11y/motion-vivid.spec.ts -g ヒーロー`（先に build）
- [ ] **Step 3: `HeroBackdrop`・`HeroHeading` を書き、3 ページに置く**
- [ ] **Step 4: PASS を確かめる**（build してから同じコマンド）
- [ ] **Step 5: 差分の確認**

---

### Task 4: Feature Sections と 3D Card Effect（A）

**Files:**
- Create: `src/modules/motion/sections/feature/GlowGrid.astro`、`src/modules/motion/sections/card3d/Tilt3d.astro`、`src/modules/motion/lib/pointer-vars.ts`
- Modify: `src/pages/index.astro`（1-4a・1-4c・1-4d・1-7）、`src/pages/services/index.astro`（サービスカード）、`src/pages/services/[slug].astro`（こんな方に向いています）、`src/modules/motion/index.ts`
- Test: `tests/modules/motion/pointer-vars.test.ts`、`e2e/a11y/motion-vivid.spec.ts`

**Interfaces:**
- Produces:
  - `tiltFromPointer(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, maxDeg: number): { rotateX: number; rotateY: number }`（`pointer-vars.ts`）
    - 中心で 0。右端で `rotateY = +maxDeg`、上端で `rotateX = +maxDeg`。範囲の外の座標は端の値に丸める。
  - `glowFromPointer(rect, x, y): { x: string; y: string }`（`"37.5%"` の形）
  - `GlowGrid.astro` props `{ class?: string }`、slot にカード
    - 子の `[data-glow-card]` に、ポインターの位置の光の縁を出す（`glowing-effect` の見せ方。CSS 変数 `--glow-x/--glow-y`）。
    - `:focus-within` では縁の全体を静かに光らせる（キーボードでも同じ変化）。
  - `Tilt3d.astro` props `{ maxDeg?: number /* 既定 8 */; class?: string }`、slot に 1 枚のカード
    - `3d-card` の見せ方。`pointer: fine` のときだけ傾き、`:focus-within` では傾けずに `translateZ` で浮かせる。
    - reduced-motion と coarse pointer では何もしない。カードの中のリンクの当たり判定とフォーカスリングを崩さない。

- [ ] **Step 1: 失敗するテストを書く**（`pointer-vars.test.ts`）

```ts
describe("tiltFromPointer", () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  describe("正常系", () => {
    it("中心は 0", () => expect(tiltFromPointer(rect, 100, 50, 8)).toEqual({ rotateX: 0, rotateY: 0 }));
    it("右上の角は rotateY=+8・rotateX=+8", () => expect(tiltFromPointer(rect, 200, 0, 8)).toEqual({ rotateX: 8, rotateY: 8 }));
  });
  describe("異常系", () => {
    it("入力: 範囲の外は端に丸める", () => expect(tiltFromPointer(rect, 999, -50, 8)).toEqual({ rotateX: 8, rotateY: 8 }));
    it("空入力: 幅か高さが 0 なら 0", () => expect(tiltFromPointer({ ...rect, width: 0 }, 10, 10, 8)).toEqual({ rotateX: 0, rotateY: 0 }));
  });
});
describe("glowFromPointer", () => {
  describe("正常系", () => {
    it("左上の 1/4 は 25%・25%", () => expect(glowFromPointer({ left: 0, top: 0, width: 200, height: 100 }, 50, 25)).toEqual({ x: "25%", y: "25%" }));
  });
  describe("異常系", () => {
    it("空入力: 幅か高さが 0 なら 50%", () => expect(glowFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 1, 1)).toEqual({ x: "50%", y: "50%" }));
  });
});
```

- [ ] **Step 2: FAIL を確かめる** — `pnpm test tests/modules/motion/pointer-vars.test.ts`
- [ ] **Step 3: `pointer-vars.ts` を書いて PASS させる**
- [ ] **Step 4: e2e を足す**（`describe("Feature・3D Card")`）
  - トップ 1-7 のカードに hover すると `transform` が `none` 以外になる。
  - キーボードの Tab でカードの中のリンクにフォーカスすると、傾き 0 で浮く（`transform` に `translateZ` を含む）。フォーカスリングの外形が要素の外に 2px 出ている（既存の `keyboard.spec.ts` の確かめ方に従う）。
  - Mobile プロジェクトでは `transform` が `none` のまま。
  - `javaScriptEnabled: false` でもカードの文字・リンクがすべて見える。
- [ ] **Step 5: `GlowGrid`・`Tilt3d` を書いて置き、e2e を PASS させる**（build してから実行）
- [ ] **Step 6: 差分の確認**

---

### Task 5: 3D Marquee・3D Animated Pin・Stats（A）

**Files:**
- Create: `src/modules/motion/sections/marquee3d/ToolMarquee.astro`、`src/modules/motion/sections/pin3d/Pin3d.astro`、`src/modules/motion/sections/stats/StatRow.astro`
- Modify: `src/pages/index.astro`（1-6・1-8・1-9）、`src/modules/motion/index.ts`
- Test: `e2e/a11y/motion-vivid.spec.ts`

**Interfaces:**
- Consumes: `MotionPauseFor`（Task 2）
- Produces:
  - `ToolMarquee.astro` props `{ items: readonly string[]; pauseLabel: string; resumeLabel: string }`（根に `data-motion="marquee"`）
    - 1-6 の今のバッジ（`TOP.tools` の配列をそのまま渡す）を、`3d-marquee` の見せ方で傾いた面に 2〜3 列で流す（CSS の animation、1 周 `--motion-duration-ambient` の 3 倍）。
    - **読み上げ用の一覧（`<ul>`。今のバッジと同じ見た目でよい）を 1 つだけ DOM に置き**、流れる複製は `aria-hidden` かつ `inert` にする。
    - 一時停止は `MotionPauseFor`（storageKey `motion:marquee`）。reduced-motion・JS なしは傾けずに今の折り返しの並びで見せる。
  - `Pin3d.astro` props `{ class?: string }`、slot に 1 枚のカード
    - `3d-pin` の見せ方。hover と `:focus-within` でカードが奥へ倒れ、上にピン（線と点、`brand.sky`）が立つ。CSS だけ。
  - `StatRow.astro` props `{ class?: string }`、slot に `StatCard` 群
    - カードが画面に入ると順に現れ、値の下に罫が引かれる（CSS の scroll-driven animation `animation-timeline: view()`。対応していないブラウザは静止）。
    - 値は「—」のまま（数え上げない）。

- [ ] **Step 1: 失敗する e2e を書く**（`describe("Marquee・Pin・Stats")`）
  - `/` のアクセシビリティツリーで、ツールの名前（`TOP.tools` の各文字列）がちょうど 1 回ずつ現れる（`page.accessibility.snapshot()` か `getByText` の可視・非 aria-hidden の数）。
  - 一時停止ボタンを押すと、流れる面の `getAnimations()` がすべて `playState === "paused"` になる。
  - 1-8・1-9 のカードに Tab でフォーカスすると、ピンの要素の `opacity` が 1 になる。
  - reduced-motion では、流れる面の要素が描かれない（`display: none`）か、animation が無い。
  - axe 違反 0。
- [ ] **Step 2: FAIL を確かめる**（build してから `-g Marquee`）
- [ ] **Step 3: 3 部品を書いて置く**
- [ ] **Step 4: PASS を確かめる**
- [ ] **Step 5: 差分の確認**

---

### Task 6: 3D Globe（A。サービス一覧）

**Files:**
- Create: `src/modules/motion/sections/globe3d/GlobeOsaka.astro`、`src/modules/motion/islands/GlobeIsland.tsx`、`src/modules/motion/lib/three.ts`
- Modify: `src/pages/services/index.astro`、`src/modules/motion/index.ts`
- Test: `tests/modules/motion/three.test.ts`、`e2e/a11y/motion-vivid.spec.ts`

**Interfaces:**
- Produces:
  - `loadThree(): Promise<typeof import("three")>`（`motion/lib/three.ts`）。three を読む唯一の入口で、動的 import の Promise を 1 つだけ作って使い回す。**Task 10 のアバターもこれを使う。**
  - `OSAKA = { lat: 34.6937, lng: 135.5023 } as const`
  - `GlobeOsaka.astro` props `{ pauseLabel: string; resumeLabel: string; class?: string }`（根に `data-motion="globe"`）
    - `github-globe` の見せ方。日本が正面に来る向きで、ゆっくり自転する。大阪にだけ脈打つ点を置く。**弧は出さない。**
    - 点の色は `cssColor("--color-brand-sky")`、地球の面は navy の階調にする。
    - `client:visible`、md 以上だけで動かす。Mobile・reduced-motion・WebGL が無いときは静止画（日本が正面の SVG か WebP）にする。
    - 一時停止は storageKey `motion:globe`。画面外で止める。

- [ ] **Step 1: 失敗するテストを書く**（`three.test.ts`。`vi.mock("three", () => ({ marker: 1 }))`）
  - 正常系: 2 回呼んでも同じオブジェクトが返る（`toBe`）。動的 import は 1 回だけ。
  - 異常系 `サーバ: 読み込みに失敗したら reject し、次の呼び出しで読み直す`: `vi.doMock` で 1 回目に throw させる。
  - 空入力のケースは引数が無いので置かない（理由をテストのコメントに 1 行書く）。
- [ ] **Step 2: FAIL → `three.ts` を書いて PASS**（`pnpm test tests/modules/motion/three.test.ts`）
- [ ] **Step 3: e2e を足す**（`describe("Globe")`）
  - `/services/` の `[data-motion="globe"]` の canvas は `aria-hidden`。
  - 一時停止で rAF の増分が 0。reduced-motion では canvas が無く、静止画がある。Mobile でも静止画になる。
- [ ] **Step 4: `GlobeOsaka`・`GlobeIsland` を書いて置き、PASS させる**
- [ ] **Step 5: ビルドの出力で three が 1 つのチャンクだけに入っていることを確かめる** — `rg -l "WebGLRenderer" dist/_astro | wc -l` → 1
- [ ] **Step 6: 差分の確認**

---

### Task 7: B の動き（Pricing／Team／Contact／Blog／Blog Content／Stats／CTA ほか）と、A の CTA

**Files:**
- Create: `src/modules/motion/sections/reveal/Reveal.astro`、`src/modules/motion/sections/stats/CountUp.astro`、`src/modules/motion/lib/count.ts`、`src/modules/motion/sections/blog-content/ReadingProgress.astro`、`src/modules/motion/sections/cta/CtaGlow.astro`
- Modify:
  - B のページ: `src/pages/pricing.astro`、`about.astro`、`contact/index.astro`、`contact/thanks.astro`、`blog/_BlogListing.astro`、`blog/_ArticleCard.astro`、`blog/[slug].astro`、`accessibility.astro`、`sitemap.astro`、`404.astro`
  - CTA: B のページの CTA バナーに `MotionBlobs` を置く（今はトップだけ）。A の 3 ページの CTA バナーに `CtaGlow` を足す。
  - 部品: `src/modules/legal/components/LegalToc.astro`（prop `trackCurrent?: boolean`、既定 false）、`src/modules/motion/index.ts`
- Test: `tests/modules/motion/count.test.ts`、`e2e/a11y/motion-calm.spec.ts`

**Interfaces:**
- Produces:
  - `Reveal.astro` props `{ as?: "div" | "li" | "article" | "section"; step?: 0 | 1 | 2 | 3; class?: string }`
    - 画面に入るときに 16px 下からふわっと上がる（`animation-timeline: view()`、`animation-range: entry 0% entry 40%`、遅れは `step × 80ms`）。CSS だけ。
    - 対応していないブラウザ・reduced-motion・印刷では静止。**ヒーローの h1 と本文には使わない。**
  - `formatCount(finalText: string, progress: number): string`（`count.ts`）
    - `"72.2%"` の数字の部分だけを `progress`（0〜1）で比例させ、小数の桁と前後の文字を保つ。
    - 数字が無い文字列はそのまま返す。progress は 0〜1 に丸める。
  - `CountUp.astro` props `{ value: string; class?: string }`
    - 最終値を見える文字として HTML に入れる（読み上げはこれだけ）。数え上げは `aria-hidden` の重ねた要素で、画面に入ったとき 1 回、`--motion-duration-large` の 2 倍の時間で行う。
    - ブログ一覧 7-3 の 72.2%・53.8%・50.8% に使う。
  - `ReadingProgress.astro`（props なし）: 記事の上端に 2px の進み具合のバー（`animation-timeline: scroll()`、`aria-hidden`、`brand.blue.500`）。
  - `LegalToc` の `trackCurrent`: true のとき、画面内の見出しに対応する項目へ `aria-current="location"` と見た目の印を付ける。ブログ記事だけが true を渡し、規約は渡さない。
  - `CtaGlow.astro` props `{ pauseLabel: string; resumeLabel: string }`（根に `data-motion="cta-glow"`）
    - A の CTA バナーの縁を光が巡る（周期 `--motion-duration-glow`）。中の粒（sparkles）は 1 秒以上の周期で明滅する。
    - `CTABanner` の `slot="decoration"` に、`MotionBlobs` と並べて置く。一時停止は `MotionBlobs` と同じ storageKey `motion:cta-blobs` を共有し、1 つのボタンで両方を止める。
- B の置き場所（★。設計書 §6）:
  - 料金カード・料金表の行・会社紹介の各節・メンバー・お問い合わせの 3 枚の案内カード・ブログのカード → `Reveal`
  - 金額の数字 → 切り替わらない（料金ページには数え上げを使わない。誤読を避ける）
  - 完了画面 → 見出しと本文を `Reveal`
  - アクセシビリティ方針・サイトマップ・404 → 節ごとに `Reveal`

- [ ] **Step 1: 失敗するテストを書く**（`count.test.ts`）

```ts
describe("formatCount", () => {
  describe("正常系", () => {
    it("小数の桁と単位を保つ", () => {
      expect(formatCount("72.2%", 1)).toBe("72.2%");
      expect(formatCount("72.2%", 0.5)).toBe("36.1%");
      expect(formatCount("72.2%", 0)).toBe("0.0%");
    });
    it("3 桁区切りを保つ", () => expect(formatCount("1,234人", 1)).toBe("1,234人"));
  });
  describe("異常系", () => {
    it("空入力: 空文字は空文字", () => expect(formatCount("", 0.5)).toBe(""));
    it("入力: 数字が無ければそのまま", () => expect(formatCount("—", 0.3)).toBe("—"));
    it("入力: progress は 0〜1 に丸める", () => {
      expect(formatCount("50.8%", 2)).toBe("50.8%");
      expect(formatCount("50.8%", -1)).toBe("0.0%");
    });
  });
});
```

- [ ] **Step 2: FAIL → `count.ts` を書いて PASS**
- [ ] **Step 3: 失敗する e2e を書く**（`e2e/a11y/motion-calm.spec.ts`）
  - B の全ルート（`distRoutes()` から、A と `/legal/` を除いたもの）で、`[data-motion-zone="calm"]` の中に光り物（`[data-motion="hero"], [data-motion="globe"], [data-motion="cta-glow"], [data-motion="marquee"]`）が 0 個。
  - ブログ一覧の 72.2% はアクセシビリティツリーに 1 回だけ現れる。`javaScriptEnabled: false` でも 72.2% が見える。
  - 記事で、スクロールすると目次の項目のどれか 1 つが `aria-current="location"` になる。`/legal/privacy/` の目次には `aria-current` が付かない。
  - reduced-motion で rAF の増分が 0（MotionBlobs を含む）。
  - 全 B ルートで axe 違反 0（既存の `pages.spec.ts` が担うなら、そちらが通ることを確かめるだけでよい）。
- [ ] **Step 4: 部品を書いて置き、PASS させる**（build してから `pnpm exec playwright test e2e/a11y/motion-calm.spec.ts`）
- [ ] **Step 5: 差分の確認**

---

### Task 8: ページの形のつながり（View Transitions）

**Files:**
- Create: `src/modules/page-transition/lib/names.ts`、`src/modules/page-transition/lib/morph.ts`
- Modify: `src/modules/page-transition/components/PageTransition.astro`、`src/modules/marketing-ui/components/ServiceCard.astro`、`src/pages/blog/_ArticleCard.astro`、`src/pages/services/[slug].astro`、`src/pages/blog/[slug].astro`、`src/pages/contact/index.astro`、`src/styles/global.css`
- Test: `tests/modules/page-transition/morph.test.ts`、`e2e/a11y/page-transition.spec.ts`

**Interfaces:**
- Consumes: `shouldSkipTransition`（Task 1）
- Produces:
  - `VT = { serviceTitle: "vt-service-title", serviceIcon: "vt-service-icon", articleTitle: "vt-article-title", articleMedia: "vt-article-media", contactTitle: "vt-contact-title" } as const`（`names.ts`）
  - `morphTargetsFor(toPath: string): readonly (typeof VT)[keyof typeof VT][]`
    - `/services/<slug>/` → `[serviceTitle, serviceIcon]`
    - `/blog/<slug>/`（`page`・`category` を除く）→ `[articleTitle, articleMedia]`
    - `/contact/` → `[contactTitle]`
    - それ以外 → `[]`
  - 遷移先のページは、対応する要素に**静的に** `view-transition-name` を持つ（詳細の h1 とアイコン、記事の h1 とアイキャッチ、お問い合わせの h1）。
  - 遷移元のページは、`pageswap` イベントで、行き先の URL に一致する `a[href]` を含むカード（`[data-morph-source]`）の中の `[data-morph="title"|"icon"|"media"]` にだけ名前を付ける。
    - 戻るときは `pagereveal` で、移動元の URL に一致するカードに名前を付ける。
    - CTA ボタン（`[data-cta-id]` で行き先が `/contact/`）は、ボタン自身に `vt-contact-title` を付ける。
  - `shouldSkipTransition(from, to)` が true なら `event.viewTransition.skipTransition()`。

- [ ] **Step 1: 失敗するテストを書く**（`morph.test.ts`）
  - 正常系: 上の 4 つの対応。末尾のスラッシュの有無とクエリ（`/contact/?cta=x`）を同じに扱う。
  - 異常系: `空入力: 空文字は []`、`入力: /blog/page/2/ と /blog/category/x/ は []`、`入力: /legal/privacy/ は []`。
- [ ] **Step 2: FAIL → `names.ts`・`morph.ts` を書いて PASS**
- [ ] **Step 3: e2e を書く**（`page-transition.spec.ts`。Desktop の Chromium だけで実行する）
  - `/services/` でサービスカードの「詳しく見る」を押す直前に、`pageswap` のハンドラーが名前を付けた要素の数がちょうど 2（`page.evaluate` で `pageswap` を待ち、`[style*="view-transition-name"]` を数える）。
  - 遷移先 `/services/<slug>/` の h1 の computed `view-transition-name` が `vt-service-title`。
  - 1 ページの中で、同じ `view-transition-name` を持つ要素が 2 つ以上ない（全ルート）。
  - `/legal/privacy/` へ移るとき、`skipTransition` が呼ばれる（`window.__vtSkipped` の印で確かめる）。
  - reduced-motion では `::view-transition-*` の animation が `none`（既存の `global.css` の規則が効いていることを確かめる）。
- [ ] **Step 4: 実装して PASS させる**
- [ ] **Step 5: 差分の確認**

---

### Task 9: アバターの素材（モデルの軽量化・Mixamo のクリップ変換・静止画）

**前提（2026-10-19 にユーザーが配置済み。始める前にあることだけ確かめる）:**
- `assets-original/avatar/亀谷銀大_VRoid.vrm`（約 11MB）
- `assets-original/avatar/mixamo/` の FBX 7 本（Without Skin、30fps）: `Waving.fbx`・`HeadNodYes.fbx`・`Pointing.fbx`・`Thinking.fbx`・`Victory.fbx`・`StandingGreeting.fbx`・`BreathingIdle.fbx`
- `assets-original/avatar/vrma/`（VRoid 公式の 7 種セット）は**使わない**（U-13→U-14。Readme の禁止事項のため）。

**Files:**
- Create:
  - `assets-original/avatar/README.md`（各ファイルの出所・取得日。Mixamo は Adobe の FAQ のとおり商用可・クレジット不要で、FBX そのものは配らない〈リポジトリにも入れない〉こと。7 種セットを使わない理由）
  - `src/modules/avatar/tools/slim-vrm.mjs`、`src/modules/avatar/tools/convert-mixamo.mjs`、`src/modules/avatar/tools/mixamo-rig-map.mjs`、`src/modules/avatar/tools/capture-stills.mjs`
  - `src/modules/avatar/assets/avatar.vrm`、`src/modules/avatar/assets/motions/{greeting,nod,point,think,peace,show-full-body,idle}.json`、`src/modules/avatar/assets/{still.webp,icon.webp}`
- Modify:
  - `package.json`（scripts に `"avatar:slim": "node src/modules/avatar/tools/slim-vrm.mjs"`、`"avatar:motions": "node src/modules/avatar/tools/convert-mixamo.mjs"`、`"avatar:stills": "node src/modules/avatar/tools/capture-stills.mjs"`）
  - ルートの `.gitignore`（`frontend/verdant-virgo/assets-original/avatar/vrma/` と `frontend/verdant-virgo/assets-original/avatar/mixamo/` を除外。`.vrm` の原本は除外しない）
- Test: `tests/modules/avatar/slim-vrm.test.ts`、`tests/modules/avatar/convert-mixamo.test.ts`

**Interfaces:**
- Produces:
  - `slim-vrm.mjs` の export `planTextureSize(width: number, height: number, max: number): { width: number; height: number }`
    - 長い辺を `max`（★ 1024）に収める。縦横比を保つ。小さいものは変えない。
  - `slim-vrm.mjs` の export `applyMetaLicense(json: object): object`
    - VRM 1.0（`extensions.VRMC_vrm.meta`）なら `avatarPermission: "onlyAuthor"`、`allowRedistribution: false`、`commercialUsage: "personalNonProfit"`。
    - VRM 0.x（`extensions.VRM.meta`）なら `allowedUserName: "OnlyAuthor"`、`commercialUssageName: "Disallow"`、`licenseName: "Redistribution_Prohibited"`。
    - ほかの値はそのまま。
  - slim の CLI: GLB を読み、埋め込みの PNG・JPEG を `sharp` で縮めて `bufferViews` を詰め直し、メタ情報を書き換えて `src/modules/avatar/assets/avatar.vrm` に出す。**VRM の拡張（表情・揺れもの・lookAt）の JSON は変えない。**
  - `mixamo-rig-map.mjs` の export `MIXAMO_TO_VRM: Record<string, VRMHumanBoneName>`（three-vrm の公式サンプル `humanoidAnimation/mixamoVRMRigMap.js` と同じ対応。出典の URL と MIT を冒頭に書く。`mixamorig:` の接頭辞の付いた名前）
  - クリップの JSON の形（`MotionClipJson`。Task 10 の読み込みが使う。型は `src/modules/avatar/lib/types.ts` に足す）:
    ```ts
    export interface MotionClipJson {
      version: 1;
      name: EmoteId | "idle";
      duration: number;            // 秒
      fps: number;                 // 書き出しの間隔（★ 30）
      mixamoHipsHeight: number;    // Mixamo の腰の高さ（位置の縮尺の基準）
      tracks: { bone: VRMHumanBoneName; path: "quaternion" | "position"; times: number[]; values: number[] }[];
    }
    ```
    - 回転は、three-vrm のサンプル `loadMixamoAnimation` と同じ式で、Mixamo の休止姿勢を打ち消して **VRM 1.0 の正規化された骨の空間**へ直した値にする（VRM 0.x の x・z の反転は再生側で行う）。
    - 位置は `hips` だけ。値は Mixamo の単位のままにし、再生側で `vrmHipsHeight / mixamoHipsHeight` を掛ける。
    - 数値は小数 4 桁に丸める。指の骨は `point`・`peace`・`think` だけ残し、ほかのクリップでは落とす（★ 大きさを抑える）。
  - `convert-mixamo.mjs` の export `toClipJson(fbxScene: THREE.Group, clip: THREE.AnimationClip, name: string, opts: { keepFingers: boolean; fps: number }): MotionClipJson`（three の `FBXLoader` で Node から読む。`TextDecoder` のほかにブラウザの API が要るなら、最小の代用を tools の中だけで足す）
  - FBX と JSON の対応: `Waving`→`greeting`、`HeadNodYes`→`nod`、`Pointing`→`point`、`Thinking`→`think`、`Victory`→`peace`、`StandingGreeting`→`show-full-body`、`BreathingIdle`→`idle`。
  - `capture-stills.mjs`: Task 10 の `AvatarStage` を開発サーバーで開き、Playwright で背景を透明にして撮る（`omitBackground: true`）。
    - `still.webp`: 待機の姿勢・高さ 560px。`icon.webp`: 顔のアップ・112px 四方。

- [ ] **Step 1: 失敗するテストを書く**（`slim-vrm.test.ts`）
  - 正常系:
    - `planTextureSize(2048, 1024, 1024)` → `{ width: 1024, height: 512 }`、`planTextureSize(512, 512, 1024)` → 変わらない。
    - `applyMetaLicense` が 1.0 と 0.x それぞれで上の値になり、ほかのキー（`name` など）は保つ。
  - 異常系:
    - `空入力: applyMetaLicense({}) は {} のまま`
    - `入力: 幅か高さが 0 以下なら throw`
- [ ] **Step 2: FAIL → 2 つの関数を書いて PASS**（`pnpm test tests/modules/avatar`）
- [ ] **Step 3: 失敗するテストを書く**（`convert-mixamo.test.ts`。three の `Bone`・`Group`・`AnimationClip`・`QuaternionKeyframeTrack` で小さな Mixamo 風の骨格〈`mixamorig:Hips` と子の `mixamorig:Spine`〉とクリップを組む。FBX ファイルは読まない）
  - 正常系:
    - 休止姿勢が単位回転なら、回転の値は入力と同じ（小数 4 桁）。`bone` は `hips`・`spine`。
    - `mixamorig:Hips` の位置のトラックは `path: "position"` で残り、`mixamoHipsHeight` が腰の高さ。
    - `keepFingers: false` で `mixamorig:LeftHandIndex1` のトラックが落ちる。
  - 異常系:
    - `空入力: トラックの無いクリップは tracks: []`
    - `入力: 対応表に無い骨のトラックは落とす`
- [ ] **Step 4: FAIL → `toClipJson` を書いて PASS**
- [ ] **Step 5: `pnpm avatar:slim` を実行する** → `src/modules/avatar/assets/avatar.vrm` が **4MB 以下が目標、6MB 以下が必須**。超えたら `max` を 768 にして再実行し、それでも超えたら報告して止める。
- [ ] **Step 6: `pnpm avatar:motions` を実行する** → `motions/*.json` が 7 本。合計の大きさを報告する（★ 目安は合計 800KB 以下〈gzip 前〉。超えたら書き出しの fps を 24 にする）。
- [ ] **Step 7: `assets-original/avatar/README.md` を書き、`.gitignore` に 2 行足す**
- [ ] **Step 8: 静止画は Task 10 の後に撮る**（Task 10 の Step 5 で `pnpm avatar:stills`）
- [ ] **Step 9: 差分の確認**

---

### Task 10: アバターの表示（avatar モジュール）

**Files:**
- Create:
  - `src/modules/avatar/lib/emotes.ts`、`src/modules/avatar/lib/triggers.ts`、`src/modules/avatar/lib/clip.ts`、`src/modules/avatar/lib/prefs.ts`
  - `src/modules/avatar/islands/AvatarStage.tsx`、`src/modules/avatar/components/AvatarDock.astro`
- Modify:
  - `src/modules/avatar/{index.ts,client.ts}`、`src/modules/layout/components/BaseLayout.astro`（`motionZone !== "none"` のときだけ `AvatarDock` を置く）、`src/modules/site-content/a11y.ts`
  - 合図の印: 料金・プランの節（`services/[slug].astro` の plans、`index.astro` の 1-7、`pricing.astro` の 4-4）に `data-avatar-cue="pricing"`、会社紹介 5-7 に `data-avatar-cue="team"`、完了画面の main に `data-avatar-cue="form-success"`
  - `astro.config.mjs`（`optimizeDeps.include` に three-vrm）
- Test: `tests/modules/avatar/emotes.test.ts`、`tests/modules/avatar/prefs.test.ts`、`tests/modules/avatar/clip.test.ts`、`e2e/a11y/avatar.spec.ts`

**Interfaces:**
- Consumes: `loadThree()`（Task 6）、`LiveZone`・`AvatarTrigger`・`EmoteId`・`AvatarLabels`（Task 1）、`MotionClipJson` と `motions/*.json`（Task 9）、`MotionPause`（a11y）、`runWhenVisible`
- Produces:
  - `EMOTE_TABLE: Record<LiveZone, Partial<Record<AvatarTrigger, EmoteId>>>`（`emotes.ts`）
    - `vivid`: `arrive→greeting`、`reach-pricing→nod`、`cta-intent→point`、`form-success→peace`、`idle→`（下の交互）
    - `calm`: `arrive→greeting`、`form-success→peace`（ほかは無し）
  - `createEmoteScheduler(zone: LiveZone, opts?: { cooldownMs?: number; playMs?: number }): { request(trigger: AvatarTrigger, now: number): EmoteId | null }`
    - 既定は `cooldownMs = 20_000`（同じエモートの繰り返しを禁じる間）、`playMs = 3_000`（1 つの再生中は次を受けない）。
    - `idle` は `think` と `show-full-body` を交互に返す（最初は `think`）。表に無い合図は null。
  - `IDLE_AFTER_MS = 15_000`（A だけ。ポインター・スクロール・キーの操作がこの間無ければ `idle`）
  - `watchTriggers(zone: LiveZone, emit: (t: AvatarTrigger) => void): () => void`（`triggers.ts`。ブラウザ専用）
    - 開始時に `arrive` を出す。ただし `[data-avatar-cue="form-success"]` があるページでは、代わりに `form-success`。
    - `[data-avatar-cue="pricing"]` が画面に入ったら `reach-pricing`（1 ページ 1 回）。
    - `[data-cta-id]` への `pointerenter`・`focusin` で `cta-intent`。
    - `document` の `comegin:form-success`（Task 11）で `form-success`。
    - A だけ `idle`。
  - `toAnimationClip(three: typeof import("three"), json: MotionClipJson, vrm: { humanoid: { getNormalizedBoneNode(name: VRMHumanBoneName): { name: string } | null; normalizedRestPose?: unknown }; meta: { metaVersion: "0" | "1" } }, vrmHipsHeight: number): THREE.AnimationClip`（`clip.ts`）
    - トラック名は `<正規化された骨のノード名>.quaternion|position`。モデルに無い骨のトラックは落とす。
    - `metaVersion === "0"` なら回転の x・z と位置の x・z の符号を反転する（three-vrm のサンプルと同じ）。
    - `hips` の位置に `vrmHipsHeight / json.mixamoHipsHeight` を掛ける。
  - 再生（`AvatarStage` の中）: `idle` を `AnimationMixer` で常にループし、エモートは 1 回だけ再生して `crossFadeTo`（★ 0.3 秒）で `idle` に戻す。エモートの長さは JSON の `duration` に従い、スケジューラーの `playMs` はその間だけ次を受けない値として最長のクリップ（切り上げ）を渡す。まばたき（表情 `blink`）と視線（lookAt）はコードで動かす。
  - `readCollapsed(): boolean`／`writeCollapsed(v: boolean): void`（`prefs.ts`。sessionStorage `avatar:collapsed`、try/catch で囲む）
    - 一時停止は `MotionPause` の storageKey `motion:avatar`。
  - `AvatarDock.astro` props `{ zone: MotionZone }`
    - `none` なら何も出さない。
    - 資産は `?url` で import する（`_astro/` のハッシュ付き。設計書 §4.4）。
    - island を `client:idle` で置く。根に `data-motion="avatar"`。
  - `AvatarStage.tsx` props `{ zone: LiveZone; modelUrl: string; motionUrls: Record<EmoteId | "idle", string>; stillUrl: string; iconUrl: string; labels: AvatarLabels }`
    - クリップの JSON は、そのエモートを初めて使うときに `fetch` する（`idle` と `greeting` だけはモデルと一緒に先に読む）。
- 見え方（設計書 §7）:
  - 左下 16px。同意バナーが出ている間は `--consent-banner-height` の分だけ上へ逃がす（`global.css` の `html:has(#cookie-banner:not([hidden]))` の規則に足す）。
  - 高さ: A 280px、B 180px。`data-avatar-cue="team"` が見えている間は 120px。
  - canvas は `aria-hidden`。
  - ボタン（名前は `labels`）:
    - 一時停止（`MotionPause`、`motion:avatar`）
    - たたむ・出す（`readCollapsed`／`writeCollapsed`）
  - A では視線（lookAt）がポインターを追う。B では正面のまま。まばたきと呼吸は常に続ける。
  - **reduced-motion**: three.js を読まず、`stillUrl` の `<img alt="">` だけを出す。一時停止ボタンも出さない。
  - **Mobile（`(max-width: 767px)` か `(pointer: coarse)`）**: 最初は `iconUrl` のボタン（名前 `labels.summon`、56px 四方）だけ。押したら three.js とモデルを読む。
  - フォームの中（`form :is(input, textarea, select, button)`）にフォーカスが入り、アバターの矩形がその要素と重なるなら、たたんだ状態にする（保存しない一時的なもの）。
  - 画面外・タブ非表示・一時停止で、描画の rAF を止める。
  - 印刷（`@media print`）では出さない。
- 文言（`site-content/a11y.ts` の `AVATAR_LABELS`。01-content-spec.md §12 に S-12 として同じ文で足す）:
  - `pause: MOTION_PAUSE.pause`、`resume: MOTION_PAUSE.resume`
  - `collapse: "アバターをしまう"`、`expand: "アバターを出す"`、`summon: "アバターを表示する"`

- [ ] **Step 1: 失敗するテストを書く**（`emotes.test.ts`）

```ts
describe("createEmoteScheduler", () => {
  describe("正常系", () => {
    it("vivid: 着いたら greeting、料金で nod、CTA で point", () => {
      const s = createEmoteScheduler("vivid");
      expect(s.request("arrive", 0)).toBe("greeting");
      expect(s.request("reach-pricing", 4_000)).toBe("nod");
      expect(s.request("cta-intent", 8_000)).toBe("point");
    });
    it("calm: 料金・CTA・idle では何もしない", () => {
      const s = createEmoteScheduler("calm");
      for (const t of ["reach-pricing", "cta-intent", "idle"] as const) expect(s.request(t, 0)).toBeNull();
    });
    it("idle は think → show-full-body の交互", () => {
      const s = createEmoteScheduler("vivid");
      expect(s.request("idle", 0)).toBe("think");
      expect(s.request("idle", 30_000)).toBe("show-full-body");
    });
  });
  describe("異常系", () => {
    it("入力: 再生中（3 秒以内）の合図は捨てる", () => {
      const s = createEmoteScheduler("vivid");
      s.request("arrive", 0);
      expect(s.request("cta-intent", 2_999)).toBeNull();
    });
    it("入力: 同じエモートは 20 秒の間に繰り返さない", () => {
      const s = createEmoteScheduler("vivid");
      s.request("cta-intent", 0);
      expect(s.request("cta-intent", 19_999)).toBeNull();
      expect(s.request("cta-intent", 20_000)).toBe("point");
    });
    it("空入力: opts を省くと既定値", () => {
      const s = createEmoteScheduler("calm", {});
      expect(s.request("arrive", 0)).toBe("greeting");
    });
  });
});
```

- [ ] **Step 2: `prefs.test.ts` を書く**
  - `vi.stubGlobal("window", { sessionStorage })` でモックする。
  - 正常系: 書いて読める。
  - 異常系 `サーバ: sessionStorage が throw しても false を返し、書き込みは黙って捨てる`。
  - `空入力: 何も保存されていなければ false`。
- [ ] **Step 3: `clip.test.ts` を書く**（three の実物と、`getNormalizedBoneNode` を持つ小さな偽の vrm を使う）
  - 正常系: `hips` と `spine` のトラックがノード名に付け替わる。`metaVersion: "0"` で回転の x・z の符号が反転する。腰の位置が縮尺される（`mixamoHipsHeight: 100`、`vrmHipsHeight: 1` で 100 → 1）。
  - 異常系: `空入力: tracks が [] なら空のクリップ`、`入力: モデルに無い骨のトラックは落とす`。
- [ ] **Step 4: FAIL → `emotes.ts`・`prefs.ts`・`clip.ts` を書いて PASS**（`pnpm test tests/modules/avatar`）
- [ ] **Step 5: 失敗する e2e を書く**（`e2e/a11y/avatar.spec.ts`）
  - `/legal/privacy/` に `[data-motion="avatar"]` が無い。ネットワークの要求に `.vrm` が無い。
  - Desktop の `/`:
    - 読み込みの後、`[data-motion="avatar"] canvas[aria-hidden="true"]` が出る。
    - `window.__avatar.lastEmote` が `"greeting"`（テスト用に `AvatarStage` が `window.__avatar` へ最後のエモートを書く。本番でも害は無い）。
  - Desktop の `/services/development/` で plans の節までスクロールすると `"nod"`。主 CTA にフォーカスすると `"point"`。
  - 一時停止ボタンで rAF の増分が 0 になり、sessionStorage `motion:avatar` が `paused`。
  - 「アバターをしまう」を押すと canvas が消え、ページを移っても `avatar:collapsed` が残る。
  - reduced-motion: `.vrm` を要求せず、`img` だけがある。一時停止ボタンが無い。
  - Mobile: 最初は「アバターを表示する」のボタンだけ（56px 以上）。押すと `.vrm` を要求する。
  - 同意バナーが出ているとき、アバターの下端がバナーの上端より上にある。Chatwoot の起動ボタン（右下）と矩形が重ならない。
  - お問い合わせの送信ボタンにフォーカスしたとき、アバターがその矩形と重ならない。
  - axe 違反 0。motion の CLS は 0.01 未満。
- [ ] **Step 6: `triggers.ts`・`AvatarStage.tsx`・`AvatarDock.astro` を書き、BaseLayout と合図の印を入れる。`astro dev --background` で開き、`pnpm avatar:stills` で静止画を撮ってから（Ruling R2）、build して e2e を PASS させる**
- [ ] **Step 7: 差分の確認**

---

### Task 11: 送信の通知

**Files:**
- Modify:
  - `src/modules/forms/lib/events.ts`
  - `src/modules/forms/components/SourceDownloadForm.tsx`（成功の直後に `dispatchFormSuccess("source_dl")`）
  - `src/modules/forms/components/ContactForm.tsx`（`location.assign` の直前に `dispatchFormSuccess("consult")`）
- Test: `tests/modules/forms/events.test.ts`

**Interfaces:**
- Produces:
  - `FORM_SUCCESS_EVENT = "comegin:form-success"`
  - `dispatchFormSuccess(formKey: FormKey): void`（`document` に `CustomEvent<{ formKey: FormKey }>` を出す。`document` が無い環境では何もしない）
- クレジットは置かない（7 種セットを使わないため。U-13）。`SiteFooter`・アクセシビリティ方針は変えない。

- [ ] **Step 1: 失敗するテストを書く**（`events.test.ts`）
  - `vi.stubGlobal("document", new EventTarget())` を使う。
  - 正常系: `dispatchFormSuccess("consult")` を `addEventListener(FORM_SUCCESS_EVENT)` で受け、`detail.formKey === "consult"`。
  - 異常系 `入力: document が無ければ throw しない`（`vi.stubGlobal("document", undefined)`）。
  - `空入力` は引数が型で必須なので置かない（理由をコメントで 1 行）。
- [ ] **Step 2: FAIL → 実装して PASS**（`pnpm test tests/modules/forms`）
- [ ] **Step 3: `avatar.spec.ts` に足す**
  - 無料 DL の送信が成功（既存の `e2e/support/forms` のモックを使う）すると `window.__avatar.lastEmote === "peace"`。
- [ ] **Step 4: PASS を確かめる**
- [ ] **Step 5: 差分の確認**

---

### Task 12: ゲート G-M（ユーザーの承認）

- [ ] **Step 1: 動画を撮る** — Playwright の `recordVideo` で、次の 8 本を `.a11y/videos/`（Git 管理外）に出す。
  - 組み合わせは Desktop・Mobile × 通常・reduced-motion の 4 通り。
  - それぞれで `/`（着いてから 1-9 までスクロール）と `/pricing/`（着いてから料金カードまで）を撮る。
  - 撮影のスクリプトは `e2e/a11y/record.spec.ts` に `test.skip(!process.env.RECORD)` で置く（普段の `pnpm a11y` では走らない）。
- [ ] **Step 2: ユーザーに見せて承認を取る。** 見てほしい点は、アバターのエモート 6 種の手触り、A と B の強さ、ヒーロー・Globe・Marquee の速さ。**承認まで Task 13 に進まない。** 直しの指示はそのタスクに戻して反映する。

---

### Task 13: 文書・しきい値の更新

**Files:**
- Modify:
  - `lighthouserc.cjs`（`"categories:performance": ["warn", { minScore: 0.9 }]`。ほかは変えない）
  - `docs/BasicDesign/DesignSpec/website/05-motion-spec.md`（A／B／C、14 種の置き場所、アバター、ページのつながり、新しいトークン）
  - `docs/BasicDesign/DesignSpec/website/01-content-spec.md` §12（S-12 アバターの文言）
  - `docs/RequirementDefinition/AA/05-application-decisions.md`（ADR-29）
  - 非機能要件の performance の記述（`rg -n "performance" docs/RequirementDefinition docs/BasicDesign` で場所を探す）
  - `.claude/agents/quality-checker.md`（リポジトリのルート）の 20 行目の判定: `LH-performance` を違反から外して「参考（warn）」にする。
  - `.claude/agents/seo-auditor.md`（リポジトリのルート）の 57 行目: しきい値の記述から performance を外し、事実として値だけ書く。
- Create: `docs/proposals/brand-guideline-web-motion-exception.md`（ガイドラインに足す節「9.5 Web サイト」の下の「動きと装飾の例外」の文案。ユーザーが正本へ反映する）

**ADR-29 に書くこと:**
- 決定: A のページ（6 ルート）に限り、動き・光・立体の表現でブランドガイドライン §2.7・§5.4・§7.3 の例外を認める。アバターは全ページ（C を除く）で例外。
- 守るもの: 色はパレットだけ。本文のコントラスト 4.5:1。ロゴの禁止例。組版。
- performance は warn。理由は U-3 と U-5 で、日付は 2026-10-19。
- 見直しの条件: ★ 公開後 4 週の GA4・PostHog で、A のページの直帰率と CWV の LCP（p75）が 2.5 秒を超えたら見直しを起票する。

- [ ] **Step 1: 文書を書く**
- [ ] **Step 2: 確かめる**
  - `rg -n "ADR-29" docs` で、ADR の本文と 05-motion-spec からの参照の両方が出る。
  - `node -e "require('./lighthouserc.cjs')"` が通る。
- [ ] **Step 3: 差分の確認**

---

### Task 14: 全体の確認

- [ ] **Step 1: ほかの build・ブラウザが動いていないことを確かめる**（`uptime`、`pgrep -fa "astro|chrome|lhci"`）
- [ ] **Step 2: 単体テスト** — `pnpm test` → 全合格
- [ ] **Step 3: 型** — `pnpm exec astro check` → エラー 0
- [ ] **Step 4: ビルド** — `SITE_URL=https://comegin.com pnpm build` → 成功
- [ ] **Step 5: a11y** — `pnpm a11y` → 違反 0・全合格（`.a11y/summary.json` で確かめる）
- [ ] **Step 6: Lighthouse** — `pnpm lh`
  - accessibility・best-practices が 0.9 以上、SEO が 1.0 で合格すること。performance は warn でよい。
  - 値と `benchmarkIndex` を報告する。終わったら 4322 の preview を PID を指定して止める。
- [ ] **Step 7: 申し送り** — 次の 3 点をユーザーに報告する。
  - NVDA ＋ Chrome での確認を頼む: アバターのボタン 3 つ、Marquee の一覧、記事の目次の現在地、CountUp の読み上げが最終値だけであること。
  - ブランドガイドラインの文案を正本へ反映するよう頼む。
  - `.superpowers/` を `.gitignore` に足すことを提案する。
- [ ] **Step 8: 差分の確認**（`git status --short` の一覧を報告する。コミットしない）
