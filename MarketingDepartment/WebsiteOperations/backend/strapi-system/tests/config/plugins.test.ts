import { describe, expect, it } from 'vitest';

import pluginsConfig from '../../config/plugins';
import { configParams, type EnvVars } from '../helpers/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pluginsOf = (vars: EnvVars = {}) => pluginsConfig(configParams(vars)) as any;
const uploadOf = (vars: EnvVars = {}) => pluginsOf(vars).upload.config;

const s3: EnvVars = {
  UPLOAD_PROVIDER: 'aws-s3',
  UPLOAD_S3_BUCKET: 'comegin-media',
  UPLOAD_S3_REGION: 'ap-northeast-1',
};

describe('config/plugins: アップロード先の切り替え', () => {
  it('UPLOAD_PROVIDER が未設定なら provider を指定しない（Strapi の既定の local）', () => {
    const upload = uploadOf();

    expect(upload).not.toHaveProperty('provider');
    expect(upload).not.toHaveProperty('providerOptions');
  });

  it('local を指定しても provider を指定しない', () => {
    expect(uploadOf({ UPLOAD_PROVIDER: 'local' })).not.toHaveProperty('provider');
  });

  it('対応外の値は例外にし、メッセージに値を含めない', () => {
    expect(() => uploadOf({ UPLOAD_PROVIDER: 'gcs-secret-value' })).toThrow(/UPLOAD_PROVIDER must be/);
    expect(() => uploadOf({ UPLOAD_PROVIDER: 'gcs-secret-value' })).not.toThrow(/gcs-secret-value/);
  });

  it('local・aws-s3 のどちらでもアップロードの許可・拒否リストを保つ', () => {
    for (const upload of [uploadOf(), uploadOf(s3)]) {
      expect(upload.security.allowedTypes).toContain('image/*');
      expect(upload.security.deniedTypes).toContain('image/svg+xml');
    }
  });
});

describe('config/plugins: aws-s3', () => {
  it.each([
    ['UPLOAD_S3_BUCKET が無い', { UPLOAD_PROVIDER: 'aws-s3', UPLOAD_S3_REGION: 'ap-northeast-1' }],
    ['UPLOAD_S3_REGION が無い', { UPLOAD_PROVIDER: 'aws-s3', UPLOAD_S3_BUCKET: 'b' }],
    ['UPLOAD_S3_BUCKET が空文字', { ...s3, UPLOAD_S3_BUCKET: '' }],
    ['UPLOAD_S3_REGION が空文字', { ...s3, UPLOAD_S3_REGION: '' }],
  ])('%s と例外にする', (_name, vars) => {
    expect(() => uploadOf(vars)).toThrow(/UPLOAD_S3_BUCKET and UPLOAD_S3_REGION are required/);
  });

  it('バケットとリージョンを s3Options に渡す', () => {
    const upload = uploadOf(s3);

    expect(upload.provider).toBe('aws-s3');
    expect(upload.providerOptions.s3Options.region).toBe('ap-northeast-1');
    expect(upload.providerOptions.s3Options.params.Bucket).toBe('comegin-media');
  });

  it("ACL を 'private' にして、応答の URL を 1 時間有効の署名付き URL にさせる", () => {
    const { params } = uploadOf(s3).providerOptions.s3Options;

    expect(params.ACL).toBe('private');
    expect(params.signedUrlExpires).toBe(3600);
  });

  it('アップロードの要求では ACL のキーを undefined で上書きし、ACL ヘッダーを送らせない', () => {
    const { actionOptions } = uploadOf(s3);

    for (const action of ['upload', 'uploadStream']) {
      expect(actionOptions[action]).toHaveProperty('ACL');
      expect(actionOptions[action].ACL).toBeUndefined();
    }
  });

  it('アクセスキーを設定に置かない（認証は ECS のタスクロール）', () => {
    const { providerOptions } = uploadOf({ ...s3, AWS_ACCESS_KEY_ID: 'AKIA...', AWS_SECRET_ACCESS_KEY: 'x' });
    const { s3Options } = providerOptions;

    expect(providerOptions).not.toHaveProperty('accessKeyId');
    expect(s3Options).not.toHaveProperty('credentials');
    expect(s3Options).not.toHaveProperty('accessKeyId');
    expect(s3Options).not.toHaveProperty('secretAccessKey');
  });
});

describe('config/plugins: users-permissions', () => {
  it('JWT は refresh 方式で、セッションの Cookie は httpOnly にする', () => {
    expect(pluginsOf()['users-permissions'].config).toEqual({
      jwtManagement: 'refresh',
      sessions: { httpOnly: true },
    });
  });
});
