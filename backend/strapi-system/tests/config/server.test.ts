import { describe, expect, it } from 'vitest';

import serverConfig from '../../config/server';
import { configParams, type EnvVars } from '../helpers/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serverOf = (vars: EnvVars = {}) => serverConfig(configParams(vars)) as any;

describe('config/server', () => {
  describe('正常系', () => {
    it('空入力: 開発環境の既定は 0.0.0.0:1337・PUBLIC_URL なし・プロキシなし', () => {
      const server = serverOf();

      expect(server.host).toBe('0.0.0.0');
      expect(server.port).toBe(1337);
      expect(server.url).toBe('');
      expect(server.proxy).toBe(false);
    });

    it('本番（オンプレの 1338）ではホスト・ポートを環境変数で変え、ポートは数値にする', () => {
      const server = serverOf({ HOST: '127.0.0.1', PORT: '1338' });

      expect(server.host).toBe('127.0.0.1');
      expect(server.port).toBe(1338);
    });

    it('PROXY=true と PUBLIC_URL を設定に渡す（Secure Cookie の発行に必要）', () => {
      const server = serverOf({ PROXY: 'true', PUBLIC_URL: 'https://cms.comegin.com' });

      expect(server.proxy).toBe(true);
      expect(server.url).toBe('https://cms.comegin.com');
    });

    it('APP_KEYS はカンマ区切りの配列にする', () => {
      expect(serverOf({ APP_KEYS: 'key1,key2' }).app.keys).toEqual(['key1', 'key2']);
      expect(serverOf({ APP_KEYS: '"key1", "key2"' }).app.keys).toEqual(['key1', 'key2']);
    });

    it('webhooks の populateRelations は既定で false、環境変数で true にできる', () => {
      expect(serverOf().webhooks.populateRelations).toBe(false);
      expect(serverOf({ WEBHOOKS_POPULATE_RELATIONS: 'true' }).webhooks.populateRelations).toBe(true);
    });

    it('MCP を有効にし、接続 10 秒・要求 2 分で打ち切る', () => {
      expect(serverOf().mcp).toEqual({ enabled: true, connectTimeoutMs: 10000, requestTimeoutMs: 120000 });
    });
  });

  describe('異常系', () => {
    it('空入力: APP_KEYS が未設定なら keys は undefined（Strapi の session ミドルウェアが起動時に拒否する）', () => {
      expect(serverOf().app.keys).toBeUndefined();
    });

    it("空入力: APP_KEYS が空文字なら [''] になる（空のキーも Strapi の session ミドルウェアが起動時に拒否する）", () => {
      expect(serverOf({ APP_KEYS: '' }).app.keys).toEqual(['']);
    });

    it("入力: PROXY が 'TRUE'（大文字）だとプロキシを信頼しない（'true' だけが有効）", () => {
      expect(serverOf({ PROXY: 'TRUE' }).proxy).toBe(false);
    });

    it('入力: PORT が数値でなければ NaN を渡す（設定関数では検証しない）', () => {
      expect(serverOf({ PORT: 'http' }).port).toBeNaN();
    });
  });
});
