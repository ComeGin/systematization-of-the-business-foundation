import type { Core } from '@strapi/strapi';

const allowedMediaTypes = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/plain',
  'text/csv',
];

const deniedTypes = [
  'image/svg+xml',
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-mach-binary',
];

// アップロード先の切り替え。local は開発環境（public/uploads）、aws-s3 は本番のメディアのバケット。
// S3 の認証は ECS のタスクロール（AWS SDK の既定の認証情報の探索）で行い、アクセスキーを環境変数に置かない。
const uploadProviderConfig = (env: Core.Config.Shared.ConfigParams['env']) => {
  const provider = env('UPLOAD_PROVIDER', 'local');

  if (provider === 'local') {
    return {};
  }

  if (provider !== 'aws-s3') {
    throw new Error(`UPLOAD_PROVIDER must be "local" or "aws-s3" (got an unsupported value).`);
  }

  const bucket = env('UPLOAD_S3_BUCKET');
  const region = env('UPLOAD_S3_REGION');

  if (!bucket || !region) {
    throw new Error('UPLOAD_S3_BUCKET and UPLOAD_S3_REGION are required when UPLOAD_PROVIDER=aws-s3.');
  }

  return {
    provider: 'aws-s3',
    providerOptions: {
      s3Options: {
        region,
        params: {
          // バケットは公開しない。'private' にすると Strapi が応答の URL を署名付き URL に直す
          // （ビルドは署名付き URL で画像を取得する。TA-06 の 11 節の確認事項）。
          ACL: 'private',
          Bucket: bucket,
          signedUrlExpires: 60 * 60,
        },
      },
    },
    // バケットの Object Ownership は BucketOwnerEnforced（ACL 無効）で、ACL を付けた PUT は拒否される。
    // 'private' は署名付き URL に直す判定にだけ使い、アップロードの要求からは外す。
    actionOptions: {
      upload: { ACL: undefined },
      uploadStream: { ACL: undefined },
    },
  };
};

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  'users-permissions': {
    config: {
      jwtManagement: 'refresh',
      sessions: {
        httpOnly: true,
      },
    },
  },
  upload: {
    config: {
      ...uploadProviderConfig(env),
      security: {
        allowedTypes: allowedMediaTypes,
        deniedTypes,
      },
    },
  },
});

export default config;
