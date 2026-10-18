## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## アクセシビリティとモーション（React Bits）の規則

公開サイトは JIS X 8341-3:2016 の AA を目標に試験し、対応度（一部準拠）と試験結果を `/accessibility/` に公開している（ADR-27）。UI を変えるときは `docs/BasicDesign/DesignSpec/website/04-accessibility-spec.md` のチェックリストを守り、`pnpm a11y` の違反を 0 に保つ。

React Bits の部品を足すときは、次を守る（ADR-28・`05-motion-spec.md`）。

- 原本は shadcn CLI（`@react-bits/<Name>-TS-TW`）で取り込み、`src/modules/motion/vendor/react-bits/<Name>/` に置く。冒頭に出典の URL と取り込み日を書き、こちらの変更には `// a11y:`・`// perf:`・`// token:` の印を付ける。ページとレイアウトは `motion/index.ts` のラッパーだけを使う。
- `useReducedMotion()`（`a11y/client.ts`）が真のときは静止させる。
- 5 秒を超えて自動で動くものには `MotionPause` を付ける（2.2.2）。
- 1 秒に 3 回を超えて点滅させない（2.3.1）。
- 装飾の canvas には `aria-hidden` を付け、意味は文字・形・状態で持たせる。動きに意味を持たせない。
- `SplitText` のように文字を分割する部品は、元の文を `aria-label` か sr-only で 1 回だけ読ませる。
- 静的な HTML（SVG・`<img>`・`<a>`）で内容が完結するようにし、WebGL と React はその上に載せる。WebGL が無くても内容が欠けないこと。
- hover で起きることは focus-visible でも起こす。
- 1 つの画面で目を引く動きは 1 つまで。時間と緩急は `theme.css` の `--motion-duration-*`・`--motion-ease-*` を使う。
- island で新しい依存を import したら `astro.config.mjs` の `vite.optimizeDeps.include` に足す。

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
