// Strapi 5 をテストのプロセスの中で起動する（公式の Testing の方法: createStrapi({ appDir, distDir }).load() と
// strapi.server.httpServer への HTTP）。動いている開発サーバー（strapi develop・1337）とは何も共有しない:
//
//   DB      一時ディレクトリの SQLite（DATABASE_FILENAME。config/database.ts はアプリのフォルダからの相対で解くので相対パスで渡す）
//   ポート  空いているポート（listen(0)）。strapi.listen() は開発時に管理画面をブラウザで開くので使わない
//   秘密値  テスト用に毎回作る（.env は読まない。ENV_PATH を空のファイルに向ける）
//   dist    strapi develop がコンパイルした既存のものを読むだけ（pnpm build・strapi build は実行しない）
//
// Strapi は dist の CommonJS を Node の require で読むので、src の差し替え（vi.mock）は効かない。
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Core } from '@strapi/strapi';

export const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const DIST_DIR = join(APP_DIR, 'dist');

const secret = () => randomBytes(16).toString('base64');

export interface StrapiHarness {
  strapi: Core.Strapi;
  baseUrl: string;
  stop: () => Promise<void>;
}

/** listen の前に足すルート（テスト用に 5xx・4xx を起こすため）。strapi.server.routes() にそのまま渡す */
export interface TestRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: (ctx: { throw: (status: number, message?: string) => never; body: unknown }) => unknown;
  config: { auth: false };
}

export interface StartOptions {
  posthogHost: string;
  routes?: TestRoute[];
}

const DIST_FILES = ['config/database.js', 'src/index.js', 'src/posthog.js', 'src/middlewares/posthog-error.js'];

/**
 * dist がそろうまで待つ。strapi develop はアプリのフォルダのファイルが変わるたびに dist を消して作り直すため、
 * その最中に始めると一時的にファイルが無い。60 秒待ってもそろわなければ、理由を書いて止める
 */
export async function waitForDist(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const missing = DIST_FILES.filter((file) => !existsSync(join(DIST_DIR, file)));
    if (missing.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`dist/${missing[0]} が無い。strapi develop を一度起動して dist を作る（このテストは pnpm build を実行しない）`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function startStrapi({ posthogHost, routes = [] }: StartOptions): Promise<StrapiHarness> {
  await waitForDist();
  const tmp = await mkdtemp(join(tmpdir(), 'strapi-it-'));
  const emptyEnv = join(tmp, 'empty.env');
  await writeFile(emptyEnv, '');

  const env: Record<string, string> = {
    ENV_PATH: emptyEnv,
    HOST: '127.0.0.1',
    PORT: '0',
    APP_KEYS: [secret(), secret()].join(','),
    API_TOKEN_SALT: secret(),
    ADMIN_JWT_SECRET: secret(),
    TRANSFER_TOKEN_SALT: secret(),
    JWT_SECRET: secret(),
    ENCRYPTION_KEY: secret(),
    DATABASE_CLIENT: 'sqlite',
    DATABASE_FILENAME: relative(APP_DIR, join(tmp, 'data.db')),
    UPLOAD_PROVIDER: 'local',
    POSTHOG_PROJECT_TOKEN: 'phc_it_fake_project_token',
    POSTHOG_HOST: posthogHost,
    STRAPI_TELEMETRY_DISABLED: 'true',
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);

  // Strapi の destroy() は process.removeAllListeners() を呼び、Vitest のワーカーの listener まで外してしまう。
  // 起動前からあった listener は残し、Strapi と posthog-node（例外の自動捕捉）が足したものだけを外す
  const before = new Map(process.eventNames().map((name) => [name, process.listeners(name as NodeJS.Signals)]));

  const requireFromApp = createRequire(join(APP_DIR, 'package.json'));
  const { createStrapi } = requireFromApp('@strapi/strapi') as typeof import('@strapi/strapi');
  const strapi = createStrapi({ appDir: APP_DIR, distDir: DIST_DIR });
  // 起動のログ（http の行など）でテストの出力を埋めない
  strapi.log.level = 'error';
  await strapi.load();
  if (routes.length > 0) strapi.server.routes(routes as Parameters<typeof strapi.server.routes>[0]);
  await new Promise<void>((done) => strapi.server.listen(0, '127.0.0.1', () => done()));
  const { port } = strapi.server.httpServer.address() as AddressInfo;

  const stop = async () => {
    const original = process.removeAllListeners;
    process.removeAllListeners = function (this: NodeJS.Process, name?: string | symbol) {
      for (const n of name === undefined ? process.eventNames() : [name]) {
        const keep = before.get(n) ?? [];
        for (const listener of process.listeners(n as NodeJS.Signals)) {
          if (!keep.includes(listener)) process.removeListener(n, listener);
        }
      }
      return this;
    } as typeof process.removeAllListeners;
    try {
      await strapi.destroy();
    } finally {
      process.removeAllListeners = original;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(tmp, { recursive: true, force: true });
    }
  };

  return { strapi, baseUrl: `http://127.0.0.1:${port}`, stop };
}

/** Content API のトークン（full-access）。インプロセスの DB の中だけで作る */
export async function createFullAccessToken(strapi: Core.Strapi): Promise<string> {
  const token = (await strapi.service('admin::api-token').create({
    name: `it-${randomBytes(4).toString('hex')}`,
    description: '結合テスト用',
    type: 'full-access',
    lifespan: null,
  })) as { accessKey: string };
  return token.accessKey;
}
