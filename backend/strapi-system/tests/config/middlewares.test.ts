import { describe, expect, it, vi } from 'vitest';

// config/middlewares.ts は読み込み時に process.env を読むため、環境変数を与えてから読み直す
const loadMiddlewares = async (env: Record<string, string | undefined> = {}) => {
  for (const key of ['UPLOAD_PROVIDER', 'UPLOAD_S3_BUCKET', 'UPLOAD_S3_REGION']) {
    vi.stubEnv(key, env[key]);
  }
  vi.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import('../../config/middlewares')).default as any[];
};

const nameOf = (entry: unknown) => (typeof entry === 'string' ? entry : (entry as { name: string }).name);

const s3 = {
  UPLOAD_PROVIDER: 'aws-s3',
  UPLOAD_S3_BUCKET: 'comegin-media',
  UPLOAD_S3_REGION: 'ap-northeast-1',
};

describe('config/middlewares: 並び順', () => {
  describe('正常系', () => {
    it('global::posthog-error は strapi::errors の直後に置く', async () => {
      const names = (await loadMiddlewares()).map(nameOf);

      expect(names.indexOf('global::posthog-error')).toBe(names.indexOf('strapi::errors') + 1);
    });

    it('aws-s3 のときも posthog-error は strapi::errors の直後にある', async () => {
      const names = (await loadMiddlewares(s3)).map(nameOf);

      expect(names.indexOf('global::posthog-error')).toBe(names.indexOf('strapi::errors') + 1);
    });

    it('どの組み合わせでも同じミドルウェアを 1 回ずつ持つ', async () => {
      const plain = (await loadMiddlewares()).map(nameOf);
      const withS3 = (await loadMiddlewares(s3)).map(nameOf);

      expect(withS3).toEqual(plain);
      expect(new Set(plain).size).toBe(plain.length);
    });
  });
});

describe('config/middlewares: strapi::security の CSP', () => {
  describe('正常系', () => {
    it('空入力: UPLOAD_PROVIDER が未設定なら strapi::security を既定のまま使う', async () => {
      const middlewares = await loadMiddlewares();

      expect(middlewares).toContain('strapi::security');
    });

    it('local のときはバケットとリージョンがあっても既定のまま使う', async () => {
      const middlewares = await loadMiddlewares({ ...s3, UPLOAD_PROVIDER: 'local' });

      expect(middlewares).toContain('strapi::security');
    });

    it('aws-s3 のときは img-src と media-src に S3 のホストを足す', async () => {
      const security = (await loadMiddlewares(s3)).find((m) => nameOf(m) === 'strapi::security');
      const { directives } = security.config.contentSecurityPolicy;
      const host = 'comegin-media.s3.ap-northeast-1.amazonaws.com';

      expect(security.config.contentSecurityPolicy.useDefaults).toBe(true);
      expect(directives['img-src']).toContain(host);
      expect(directives['media-src']).toContain(host);
    });

    it('S3 のホストを足しても Strapi の既定の取得元（self・data・blob・market-assets）を残す', async () => {
      const security = (await loadMiddlewares(s3)).find((m) => nameOf(m) === 'strapi::security');
      const { directives } = security.config.contentSecurityPolicy;

      expect(directives['img-src']).toEqual(
        expect.arrayContaining(["'self'", 'data:', 'blob:', 'market-assets.strapi.io'])
      );
      expect(directives['media-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
      expect(directives['connect-src']).toEqual(["'self'", 'https:']);
    });
  });

  describe('異常系', () => {
    it.each([
      ['UPLOAD_S3_BUCKET が無い', { ...s3, UPLOAD_S3_BUCKET: undefined }],
      ['UPLOAD_S3_REGION が無い', { ...s3, UPLOAD_S3_REGION: undefined }],
      ['UPLOAD_S3_BUCKET が空文字', { ...s3, UPLOAD_S3_BUCKET: '' }],
      ['UPLOAD_S3_REGION が空文字', { ...s3, UPLOAD_S3_REGION: '' }],
    ])('空入力: aws-s3 でも %s ときは S3 のホストを足さず既定のまま使う（起動の拒否は config/plugins が行う）', async (_name, env) => {
      const middlewares = await loadMiddlewares(env);

      expect(middlewares).toContain('strapi::security');
    });

    it.each(['gcs', 'AWS-S3'])(
      '入力: UPLOAD_PROVIDER が対応外の %j なら S3 のホストを足さない（起動の拒否は config/plugins が行う）',
      async (provider) => {
        const middlewares = await loadMiddlewares({ ...s3, UPLOAD_PROVIDER: provider });

        expect(middlewares).toContain('strapi::security');
      }
    );
  });
});
