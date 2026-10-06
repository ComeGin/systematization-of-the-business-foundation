import path from 'path';
import { describe, expect, it } from 'vitest';

import databaseConfig from '../../config/database';
import { configParams, type EnvVars } from '../helpers/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connectionOf = (vars: EnvVars = {}) => databaseConfig(configParams(vars)).connection as any;

describe('config/database: クライアントの切り替え', () => {
  it('DATABASE_CLIENT が未設定なら sqlite を使う', () => {
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

  it.each(['mssql', 'oracle', 'Postgres', ''])('対応外のクライアント %j は例外にする', (client) => {
    expect(() => connectionOf({ DATABASE_CLIENT: client })).toThrow(/Unsupported DATABASE_CLIENT/);
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

  it('DATABASE_SSL_REJECT_UNAUTHORIZED を空文字にすると false と読まれ、検証が外れる', () => {
    // .env.example の注意書き（空にもしない）の根拠
    const connection = connectionOf({ ...rds, DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: '' });

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
});

describe('config/database: 接続の待ち時間', () => {
  it('acquireConnectionTimeout は既定で 60000 ミリ秒', () => {
    expect(connectionOf().acquireConnectionTimeout).toBe(60000);
    expect(connectionOf({ DATABASE_CLIENT: 'postgres' }).acquireConnectionTimeout).toBe(60000);
  });

  it('DATABASE_CONNECTION_TIMEOUT で変えられる', () => {
    expect(connectionOf({ DATABASE_CONNECTION_TIMEOUT: '5000' }).acquireConnectionTimeout).toBe(5000);
  });
});
