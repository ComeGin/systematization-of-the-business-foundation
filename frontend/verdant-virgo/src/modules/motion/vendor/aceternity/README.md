# Aceternity UI の原本

`src/modules/motion/vendor/aceternity/<Name>/` は Aceternity UI の無料の部品を、shadcn CLI（`@aceternity/<name>`）で取り込んだ原本。
2026-10-19 に取り込んだ。ページとレイアウトは原本を直接 import せず、`motion/sections/` の包みだけを使う（`frontend/verdant-virgo/AGENTS.md`。React Bits の規則と同じ）。

- 冒頭に出典の URL・取り込み日・ライセンスを書く。こちらの変更には `// a11y:`・`// perf:`・`// token:` の印を付ける（計画書 P-10）。
- Aceternity の**有料（Pro）のコードは使わない。**
- shadcn CLI は `src/components/ui/` に書くので、取り込んだら `<Name>/` へ移し、`src/components/ui/` には残さない。`src/lib/utils.ts`・`components.json` の `registries` 以外は書き換わらない（取り込みのたびに `git diff` で確かめる）。

## 取り込んだ原本

| ディレクトリ | registry の名前 | 依存 | 備考 |
|---|---|---|---|
| ~~`SpotlightNew`~~ | `spotlight-new` | motion | 2026-10-29 に削除（使っていた HeroBackdrop をヒーロー第 2 版で消した） |
| ~~`BackgroundBeams`~~ | `background-beams` | motion | 2026-10-29 に削除（同上） |
| `TextGenerateEffect` | `text-generate-effect` | motion | |
| `GlowingEffect` | `glowing-effect` | motion | |
| `ThreeDCard` | `3d-card` | （なし） | 公式の名前は 3D Card Effect |
| `ThreeDMarquee` | `3d-marquee` | motion | |
| `ThreeDPin` | `3d-pin` | motion | |
| `Globe` | `globe` | three、three-globe、@react-three/fiber | `github-globe` の替え（下記）。CLI は @react-three/drei も入れたが、原本は import しないので外した（2026-10-19） |

## 替えたもの

### `github-globe` → `globe`（`Globe/`）

- 計画の `github-globe` は、registry（`https://ui.aceternity.com/registry/github-globe.json`）が認証なしでは `401 Unauthorized - Please provide a valid API token or sign in` を返す。有料（Pro）または存在しない名前のどちらかで、どちらでもこの作業では使えない。
- 公式の文書では、無料の Globe の部品の頁は `/components/github-globe` で、registry の名前は `globe`（認証なしで取得できる）。同じ見せ方（three-globe の六角形の陸地・自転・弧とリングの演出）なので、これに替えた。
- 依存は three の周りが重い（three、three-globe、@react-three/fiber）。サービス一覧の導入ヒーローの地球（`motion/sections/globe3d/GlobeOsaka.astro`。Task 6）が、island（`GlobeIsland`）から動的 import で使う。弧は出さない（サイトの方針）。
- 原本は陸地の GeoJSON を `@/data/globe.json` から読む。registry にはこのデータが含まれないので、three-globe の配布物にある `example/country-polygons/ne_110m_admin_0_countries.geojson`（Natural Earth の 110m の国境。パブリックドメイン。three-globe は MIT）を `Globe/globe.json` に複写し、import を相対パスに替えた（約 480KB。Task 6 で必要な国だけに絞った。下の表）。
- `@react-three/fiber` は、CLI が `10.0.0-alpha.6` を入れたので、安定版の `9.8.1`（React 19.3 の範囲に入る）に替えた。

## ライセンスの確認

- 取り込んだ部品はすべて、認証なしの registry で配布されている無料のもの。
- 公式の `https://ui.aceternity.com/licence` は Pro の条項（End Product の作成・配布・改変を許す）で、無料の部品の条項は別に書かれていない。二次情報（比較記事など）は無料の部品を MIT と書くが、一次の確認は取れていない。**公開の前に、ユーザーが Aceternity の GitHub／配布元で無料の部品のライセンスを確かめる**（report の懸念に挙げた）。

## こちらで手を入れた原本

`SpotlightNew`・`BackgroundBeams` は `motion/sections/hero/HeroBackdrop.astro`（A のヒーローの地）の中でだけ使っていた。2026-10-29 にヒーロー第 2 版（アトリエ）で HeroBackdrop を消し、2 つの原本も消した（下の表は当時の変更の記録）。変更の理由と内容は各ファイルの冒頭（`// perf:`・`// a11y:`・`// token:` の印）にある。

| ディレクトリ | 変えたこと |
|---|---|
| `SpotlightNew` | motion/react（JS で `x` を動かす）をやめ、CSS の animation にした（合成だけで動く。rAF・水和が要らない。一時停止を global.css の `[data-motion-paused]` に任せられる）。1 周を `--motion-duration-ambient` に、色をパレットの color-mix にした |
| `BackgroundBeams` | 50 本の linearGradient を JS で毎フレーム動かす実装をやめ、17 本の筋の `stroke-dashoffset` を CSS で動かす実装にした（`Math.random()` を使わない。紫など palette 外の色をやめた）。曲線の形は原本のまま |
| `TextGenerateEffect` | **使わない**。語に分割して opacity 0 から JS で出す作りで、日本語は語の区切りが無く、h1 が最初の HTML で読めなくなるため。ヒーローの見出しは `motion/sections/hero/HeroHeading.astro` が、見た目（ぼやけて焦点が合う）だけを CSS で再現する |
| `GlowingEffect` | **使わない**（Task 4）。`body` に `pointermove`、`window` に `scroll` を常に聞かせ、`motion/react` の `animate` で毎フレーム `--start` を書く作りで、reduced-motion でも rAF が回るため。色もパレット外（`#dd7bbb` など）。見せ方（縁だけがポインターの近くで光る）は `motion/sections/feature/GlowGrid.astro` が CSS（`--glow-x`／`--glow-y`）と小さな素の script で再現した（`// perf:`・`// a11y:` の印と理由は GlowGrid の冒頭） |
| `ThreeDCard` | **使わない**（Task 4）。hover を React の状態で持ち、`CardItem` ごとに `useEffect` で `style.transform` を書く。傾く面でポインターを聞くため縁でちらつき、reduced-motion・タッチの分岐も無い。見せ方（`perspective`＋`preserve-3d`＋`translateZ`）は `motion/sections/card3d/Tilt3d.astro` が再現した（ポインターを聞く面と傾く面を分け、キーボードでは傾けず浮かせる） |
| `ThreeDMarquee` | **使わない**（Task 5）。`motion/react` が列ごとに JS で `y` を往復させ（rAF が常時回り、reduced-motion でも止まらない）、画像専用（`alt` が「Image 1」）で、止める手段も無い。見せ方（奥へ傾いた面に流れる列）は `motion/sections/marquee3d/ToolMarquee.astro` が CSS だけで再現した。今の文字のバッジを流し（他社のロゴは足さない）、流れは横向きの 3 本にした（日本語の文字は横に流れるほうが読める）。傾きは奥へ 40 度＋面の中で -5 度（原本は 55 度＋-45 度で、画像向き）。読み上げ用の `<ul>` を 1 つだけ DOM に置き、流れる複製は `aria-hidden`＋`inert`。一時停止（`MotionPauseFor`）と、ポインターを載せている間の停止付き |
| `ThreeDPin` | **使わない**（Task 5）。hover を React の状態で持ち、ピンの波紋が `motion/react` の無限の animation（6 秒）で止められず、カードが黒地・外部リンク専用（`<a>` の入れ子）、hover だけでフォーカスに応えない。見せ方（hover で奥へ倒れるカードと、上に立つ線と点）は `motion/sections/pin3d/Pin3d.astro` が CSS だけで再現した（hover と `:has(:focus-visible)` の両方。波紋は付けない。色は `brand.sky`。タイトルのピル〈新しい文言〉も付けない） |
| `Globe` | **使うが、大きく変えた**（Task 6）。サービス一覧の地球儀（`GlobeOsaka`）が、`GlobeIsland` から動的 import で使う。変えた点: **(1) 弧をやめた**（`data: Position[]` → `markers`。点は大阪だけ。販売先は大阪府内で、どこへ弧を伸ばしても事実に反する）。**(2) 自転をやめ、大阪を軸に左右へ振れる**（`OrbitControls` の `autoRotate` を、`useFrame` で 30 度・往復 24 秒の振れにした。陸地のデータを見える範囲の国だけにするため一周させない。時間は描画された分だけ進める）。**(3) `OrbitControls`（drei）を使わない**（ドラッグ・自動回転は装飾に不要。drei を読まない）。**(4) 一時停止・画面外で rAF を止める**（R3F の `frameloop` を `active` で `always`/`demand` に切り替え、three-globe が作った時点から自前で回す rAF〈tween・輪〉も `pauseAnimation()`/`resumeAnimation()` で止める。止める間に作ったときは作った直後に止める）。**(5) 脈打つ輪を three-globe の `ringRepeatPeriod` に任せた**（原本は 2 秒ごとの `setInterval` でランダムに入れ替えていた。1 か所だけを一定の周期〈2.4 秒〉で。広がって消える輪なので点滅ではない）。**(6)** `animateIn`（出現時の拡大と一周の回転）・`waitForGlobeReady` をやめた。点・輪の `transition` を 0 に。**(7)** `Scene`・`PerspectiveCamera` を描画のたびに作り直さず、`Canvas` の prop にした。`dpr` は 1.5 まで。canvas に `aria-hidden`。色は呼び出し側が `cssColor()` で役割トークンから解決して渡す（原本の既定色〈紫〉を持たない）。**(8) 陸地のデータを絞った**: `Globe/globe.json` は `scripts/make-globe-assets.mjs` が three-globe の例から作る（大阪から 105 度以内の国だけ〈遠近のカメラが球の中心から見込む角 約 70.5 度＋振れ幅 30 度＋余白〉、プロパティなし、座標は小数 1 桁。約 480KB → 約 108KB）。同じスクリプトが静止画の陸地 `motion/sections/globe3d/globe-land.svg`（大阪が中心の正射図法）も作る |

### three-globe の `three/webgpu` をビルドから外す

three-globe（2.42 以降のすべて）は、heatmaps の GPU 計算のために `three/webgpu`・`three/tsl` を先頭で静的に import する。使わないのに地球儀のチャンクが約 1.5MB になり、three の実装が WebGL 用・WebGPU 用に 2 か所へ入る。`src/modules/motion/vite-plugin.ts`（`astro.config.mjs` に登録）が、**importer が three-globe のときだけ、ビルドで**この 2 つを空の部品に差し替える（約 1.5MB → 約 0.8MB）。heatmaps（`heatmapsData`）を使うと「使えない」と例外を投げる。この地球儀は hex の陸地・点・輪だけを使う。

### three のチャンクについて

`loadThree()`（`motion/lib/three.ts`）が three を読む唯一の入口で、アバターもこれを使う。地球儀の原本（R3F・three-globe）は three を静的に import するが、three の実装は 1 つのチャンク（`three.module.*.js`）にだけ入る（`rg -l "isWebGLRenderer" dist/_astro` が 1）。ただし `rg -l "WebGLRenderer" dist/_astro` は **2** になる: R3F の `import * as THREE` が `WebGLRenderer as x` という import 指定として 1 回現れるため（名前を使う部品は必ずその文字列を持つ。アバターが `THREE.WebGLRenderer` を呼ぶときも同じ）。実装のあるチャンクの数で見る。
