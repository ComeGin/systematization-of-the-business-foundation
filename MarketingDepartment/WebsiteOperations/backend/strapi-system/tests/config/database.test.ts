import path from 'path';
import { describe, expect, it } from 'vitest';

import databaseConfig from '../../config/database';
import { configParams, type EnvVars } from '../helpers/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connectionOf = (vars: EnvVars = {}) => databaseConfig(configParams(vars)).connection as any;

describe('config/database: クライアントの切り替え', () => {
  describe('正常系', () => {
    it('空入力: DATABASE_CLIENT が未設定なら sqlite を使う', () => {
      const connection = connectionOf();

      expect(connection.client).toBe('sqlite');
      expect(connection.useNullAsDefault).toBe(true);
    });

    it('sqlite のファイルは DATABASE_FILENAME を既定 .tmp/data.db として絶対パスにする', () => {
      const connection = connectionOf();

      expect(path.isAbsolute(connection.connection.filename)).toBe(true);
      expect(connection.connection.filename.endsWith(path.join('.tmp', 'data.db'))).toBe(true);
    });

    it('DATABASE_FILENAME を指定すると sqlite のファイルに使う', () => {
      const connection = connectionOf({ DATABASE_FILENAME: 'custom/dev.db' });

      expect(connection.connection.filename.endsWith(path.join('custom', 'dev.db'))).toBe(true);
    });

    it('postgres を指定すると postgres の接続設定になる', () => {
      const connection = connectionOf({ DATABASE_CLIENT: 'postgres' });

      expect(connection.client).toBe('postgres');
      expect(connection.connection).toMatchObject({
        host: 'localhost',
        port: 5432,
        database: 'strapi',
        user: 'strapi',
        password: 'strapi',
        schema: 'public',
        ssl: false,
      });
      expect(connection.pool).toEqual({ min: 2, max: 10 });
      expect(connection.useNullAsDefault).toBeUndefined();
    });

    it('mysql を指定すると mysql の接続設定になり、schema を持たない', () => {
      const connection = connectionOf({ DATABASE_CLIENT: 'mysql' });

      expect(connection.client).toBe('mysql');
      expect(connection.connection.port).toBe(3306);
      expect(connection.connection).not.toHaveProperty('schema');
    });
  });

  describe('異常系', () => {
    it.each(['mssql', 'oracle', 'Postgres', 'postgresql'])('入力: 対応外のクライアント %j は例外にする', (client) => {
      expect(() => connectionOf({ DATABASE_CLIENT: client })).toThrow(/Unsupported DATABASE_CLIENT/);
    });

    it.each(['', ' '])('空入力: DATABASE_CLIENT が %j なら例外にする', (client) => {
      expect(() => connectionOf({ DATABASE_CLIENT: client })).toThrow(/Unsupported DATABASE_CLIENT/);
    });

    it('入力: 例外の文で使える値（postgres・mysql・sqlite）を示す', () => {
      expect(() => connectionOf({ DATABASE_CLIENT: 'mssql' })).toThrow(/"postgres", "mysql", or "sqlite"/);
    });

    // @strapi/database の isDatabaseClientKind（`client in clientMap`）はこれらを通すため、config/database.ts は自前の表で判定する
    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      '入力: DATABASE_CLIENT が Object.prototype のキー %j でも例外にする',
      (client) => {
        expect(() => connectionOf({ DATABASE_CLIENT: client })).toThrow(/Unsupported DATABASE_CLIENT/);
      }
    );
  });
});

describe('config/database: postgres（本番の RDS）', () => {
  const rds: EnvVars = {
    DATABASE_CLIENT: 'postgres',
    DATABASE_HOST: 'strapi.xxxx.ap-northeast-1.rds.amazonaws.com',
    DATABASE_PORT: '15432',
    DATABASE_NAME: 'strapi_prod',
    DATABASE_USERNAME: 'app',
    DATABASE_PASSWORD: 'secret-from-secrets-manager',
    DATABASE_SCHEMA: 'cms',
    DATABASE_POOL_MIN: '0',
    DATABASE_POOL_MAX: '5',
  };

  describe('正常系', () => {
    it('環境変数の値を接続設定に渡し、ポートとプールは数値にする', () => {
      const connection = connectionOf(rds);

      expect(connection.connection).toMatchObject({
        host: rds.DATABASE_HOST,
        port: 15432,
        database: 'strapi_prod',
        user: 'app',
        password: 'secret-from-secrets-manager',
        schema: 'cms',
      });
      expect(connection.pool).toEqual({ min: 0, max: 5 });
    });

    it('DATABASE_URL を connectionString に渡す', () => {
      const connection = connectionOf({ ...rds, DATABASE_URL: 'postgres://u:p@h:5432/db' });

      expect(connection.connection.connectionString).toBe('postgres://u:p@h:5432/db');
    });

    it('DATABASE_SSL=true なら証明書を検証する SSL 設定になる（既定で rejectUnauthorized は true）', () => {
      const connection = connectionOf({ ...rds, DATABASE_SSL: 'true' });

      expect(connection.connection.ssl).toEqual({
        key: undefined,
        cert: undefined,
        ca: undefined,
        capath: undefined,
        cipher: undefined,
        rejectUnauthorized: true,
      });
    });

    it('DATABASE_SSL_REJECT_UNAUTHORIZED=false のときだけ証明書の検証を外す', () => {
      const connection = connectionOf({ ...rds, DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' });

      expect(connection.connection.ssl.rejectUnauthorized).toBe(false);
    });

    it('SSL の証明書類を環境変数から渡す', () => {
      const connection = connectionOf({ ...rds, DATABASE_SSL: 'true', DATABASE_SSL_CA: 'ca-pem' });

      expect(connection.connection.ssl.ca).toBe('ca-pem');
    });

    it('DATABASE_SSL が true 以外なら SSL を使わない', () => {
      expect(connectionOf({ ...rds, DATABASE_SSL: 'false' }).connection.ssl).toBe(false);
      expect(connectionOf(rds).connection.ssl).toBe(false);
    });

    it('空入力: DATABASE_URL が未設定なら connectionString は undefined で、個別の値で接続する', () => {
      const connection = connectionOf(rds);

      expect(connection.connection.connectionString).toBeUndefined();
      expect(connection.connection.host).toBe(rds.DATABASE_HOST);
    });
  });

  describe('異常系', () => {
    it('空入力: DATABASE_SSL_REJECT_UNAUTHORIZED を空文字にすると false と読まれ、検証が外れる', () => {
      // .env.example の注意書き（空にもしない）の根拠
      const connection = connectionOf({ ...rds, DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: '' });

      expect(connection.connection.ssl.rejectUnauthorized).toBe(false);
    });

    it('空入力: 接続先の環境変数が空文字だと既定値ではなく空文字・NaN を渡す（.env.example の空欄のまま postgres にしたとき）', () => {
      // 既定値はキーが無いときだけ使われる。本番は onprem/strapi/compose.yml の ${VAR:-既定値}・${VAR:?} で空を防いでいる
      const connection = connectionOf({
        DATABASE_CLIENT: 'postgres',
        DATABASE_HOST: '',
        DATABASE_PORT: '',
        DATABASE_NAME: '',
        DATABASE_USERNAME: '',
        DATABASE_PASSWORD: '',
      });

      expect(connection.connection).toMatchObject({ host: '', database: '', user: '', password: '' });
      expect(connection.connection.port).toBeNaN();
    });

    it("入力: DATABASE_SSL が 'TRUE'（大文字）や '1' だと SSL を使わない（'true' だけが有効）", () => {
      expect(connectionOf({ ...rds, DATABASE_SSL: 'TRUE' }).connection.ssl).toBe(false);
      expect(connectionOf({ ...rds, DATABASE_SSL: '1' }).connection.ssl).toBe(false);
    });

    it('入力: DATABASE_PORT・DATABASE_POOL_MAX が数値でなければ NaN を渡す（設定関数では検証しない）', () => {
      const connection = connectionOf({ ...rds, DATABASE_PORT: 'five-four-three-two', DATABASE_POOL_MAX: 'ten' });

      expect(connection.connection.port).toBeNaN();
      expect(connection.pool.max).toBeNaN();
    });
  });
});

describe('config/database: 接続の待ち時間', () => {
  describe('正常系', () => {
    it('空入力: DATABASE_CONNECTION_TIMEOUT が未設定なら acquireConnectionTimeout は 60000 ミリ秒', () => {
      expect(connectionOf().acquireConnectionTimeout).toBe(60000);
      expect(connectionOf({ DATABASE_CLIENT: 'postgres' }).acquireConnectionTimeout).toBe(60000);
    });

    it('DATABASE_CONNECTION_TIMEOUT で変えられる', () => {
      expect(connectionOf({ DATABASE_CONNECTION_TIMEOUT: '5000' }).acquireConnectionTimeout).toBe(5000);
    });
  });
});
