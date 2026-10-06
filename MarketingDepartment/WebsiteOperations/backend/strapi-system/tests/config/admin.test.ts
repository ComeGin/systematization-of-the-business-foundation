import { describe, expect, it } from 'vitest';

import adminConfig from '../../config/admin';
import { configParams, type EnvVars } from '../helpers/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminOf = (vars: EnvVars = {}) => adminConfig(configParams(vars)) as any;

const secrets: EnvVars = {
  ADMIN_JWT_SECRET: 'admin-jwt',
  API_TOKEN_SALT: 'api-salt',
  TRANSFER_TOKEN_SALT: 'transfer-salt',
  ENCRYPTION_KEY: 'enc-key',
};

describe('config/admin', () => {
  it('秘密値をそれぞれ対応する環境変数から読む', () => {
    const admin = adminOf(secrets);

    expect(admin.auth.secret).toBe('admin-jwt');
    expect(admin.apiToken.salt).toBe('api-salt');
    expect(admin.transfer.token.salt).toBe('transfer-salt');
    expect(admin.secrets.encryptionKey).toBe('enc-key');
  });

  it('プレビューを無効にし（編集画面の 404 を止める）、handler は null を返す', () => {
    const admin = adminOf(secrets);

    expect(admin.preview.enabled).toBe(false);
    expect(admin.preview.config.handler()).toBeNull();
  });

  it('フラグは既定で true、環境変数で false にできる', () => {
    expect(adminOf(secrets).flags).toEqual({ nps: true, promoteEE: true, docLinks: true });
    expect(
      adminOf({ ...secrets, FLAG_NPS: 'false', FLAG_PROMOTE_EE: 'false', FLAG_DOC_LINKS: 'false' }).flags
    ).toEqual({ nps: false, promoteEE: false, docLinks: false });
  });
});
