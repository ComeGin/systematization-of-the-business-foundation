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
  describe('正常系', () => {
    it('空入力: UPLOAD_PROVIDER が未設定なら provider を指定しない（Strapi の既定の local）', () => {
      const upload = uploadOf();

      expect(upload).not.toHaveProperty('provider');
      expect(upload).not.toHaveProperty('providerOptions');
    });

    it('local を指定しても provider を指定しない', () => {
      expect(uploadOf({ UPLOAD_PROVIDER: 'local' })).not.toHaveProperty('provider');
    });

    it('local・aws-s3 のどちらでもアップロードの許可・拒否リストを保つ', () => {
      for (const upload of [uploadOf(), uploadOf(s3)]) {
        expect(upload.security.allowedTypes).toContain('image/*');
        expect(upload.security.deniedTypes).toContain('image/svg+xml');
      }
    });

    it('実行ファイル・シェルスクリプトを拒否リストに入れる', () => {
      expect(uploadOf().security.deniedTypes).toEqual(
        expect.arrayContaining(['application/x-msdownload', 'application/x-sh', 'text/x-shellscript'])
      );
    });
  });

  describe('異常系', () => {
    it('入力: 対応外の値は例外にし、メッセージに値を含めない', () => {
      expect(() => uploadOf({ UPLOAD_PROVIDER: 'gcs-secret-value' })).toThrow(/UPLOAD_PROVIDER must be/);
      expect(() => uploadOf({ UPLOAD_PROVIDER: 'gcs-secret-value' })).not.toThrow(/gcs-secret-value/);
    });

    it.each(['AWS-S3', 'Local', 's3'])('入力: 大文字小文字や別名の %j も対応外として例外にする', (provider) => {
      expect(() => uploadOf({ UPLOAD_PROVIDER: provider })).toThrow(/UPLOAD_PROVIDER must be/);
    });

    it('空入力: UPLOAD_PROVIDER が空文字なら既定の local にせず例外にする', () => {
      expect(() => uploadOf({ UPLOAD_PROVIDER: '' })).toThrow(/UPLOAD_PROVIDER must be/);
    });
  });
});

describe('config/plugins: aws-s3', () => {
  describe('正常系', () => {
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

  describe('異常系', () => {
    it.each([
      ['UPLOAD_S3_BUCKET が無い', { UPLOAD_PROVIDER: 'aws-s3', UPLOAD_S3_REGION: 'ap-northeast-1' }],
      ['UPLOAD_S3_REGION が無い', { UPLOAD_PROVIDER: 'aws-s3', UPLOAD_S3_BUCKET: 'b' }],
      ['UPLOAD_S3_BUCKET が空文字', { ...s3, UPLOAD_S3_BUCKET: '' }],
      ['UPLOAD_S3_REGION が空文字', { ...s3, UPLOAD_S3_REGION: '' }],
      ['両方とも空文字', { ...s3, UPLOAD_S3_BUCKET: '', UPLOAD_S3_REGION: '' }],
    ])('空入力: %s と例外にする', (_name, vars) => {
      expect(() => uploadOf(vars)).toThrow(/UPLOAD_S3_BUCKET and UPLOAD_S3_REGION are required/);
    });

    it('空入力: 例外の文に、設定済みのもう片方の値（バケット名）を含めない', () => {
      expect(() => uploadOf({ ...s3, UPLOAD_S3_REGION: '' })).not.toThrow(/comegin-media/);
    });

    it.each([
      ['UPLOAD_S3_BUCKET が空白だけ', { ...s3, UPLOAD_S3_BUCKET: ' ' }],
      ['UPLOAD_S3_REGION が空白だけ', { ...s3, UPLOAD_S3_REGION: ' \t ' }],
    ])('空入力: %s でも未設定として例外にし、例外の文に値を含めない', (_name, vars) => {
      expect(() => uploadOf(vars)).toThrow(/UPLOAD_S3_BUCKET and UPLOAD_S3_REGION are required/);
      expect(() => uploadOf(vars)).not.toThrow(/comegin-media|ap-northeast-1/);
    });
  });
});

describe('config/plugins: users-permissions', () => {
  describe('正常系', () => {
    it('JWT は refresh 方式で、セッションの Cookie は httpOnly にする', () => {
      expect(pluginsOf()['users-permissions'].config).toEqual({
        jwtManagement: 'refresh',
        sessions: { httpOnly: true },
      });
    });
  });
});
