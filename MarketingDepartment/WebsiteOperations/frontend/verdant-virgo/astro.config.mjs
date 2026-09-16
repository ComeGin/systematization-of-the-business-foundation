// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

import react from '@astrojs/react';
import markdoc from '@astrojs/markdoc';
import mdx from '@astrojs/mdx';
import partytown from '@astrojs/partytown';
import sitemap from '@astrojs/sitemap';

import tailwindcss from '@tailwindcss/vite';

// .env は設定ファイル内では自動ロードされないため、Vite の loadEnv で明示的に読み込む。
// https://docs.astro.build/en/guides/environment-variables/#in-the-astro-config-file
const { SITE_URL } = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');

// SITE_URL 未設定のままビルドすると sitemap.xml と canonical に localhost が焼き込まれ、
// 警告も出ないまま公開されてしまう。ビルド時のみ停止させる。
const isBuild = process.argv.includes('build');
if (isBuild && !SITE_URL) {
  throw new Error(
    'SITE_URL が未設定です。.env に SITE_URL=https://example.com を設定するか、SITE_URL=... astro build のように渡してください。'
  );
}

// https://astro.build/config
export default defineConfig({
  site: SITE_URL || 'http://localhost:4321',

  integrations: [
    react(),
    markdoc(),
    mdx(),
    partytown(),
    sitemap()
  ],

  vite: {
    plugins: [tailwindcss()],

    server: {
      // Vite は DNS リバインディング対策として Host ヘッダーを照合するため、
      // ngrok 経由のドメインは明示的に許可しないとブロックされる。
      // ドメインは ~/.config/ngrok/ngrok.yml の astro エンドポイント（-> 4321）と対応。
      allowedHosts: ['comegin-astro-dev.ngrok.app']
    }
  }
});
