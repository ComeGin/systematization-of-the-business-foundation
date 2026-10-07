import { PostHog } from 'posthog-node';

// 前後の空白を外し、空白だけ（引用符つきの '   ' など）の値は未設定として扱う
const readEnv = (name: string) => process.env[name]?.trim() || undefined;

const projectToken = readEnv('POSTHOG_PROJECT_TOKEN');
const host = readEnv('POSTHOG_HOST');

const requireInDevelopment = (value: string | undefined, variableName: string) => {
  if (!value && process.env.NODE_ENV !== 'production') {
    throw new Error(
      `${variableName} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variableName} is configured`
    );
  }

  return value;
};

const configuredProjectToken = requireInDevelopment(projectToken, 'POSTHOG_PROJECT_TOKEN');
const configuredHost = requireInDevelopment(host, 'POSTHOG_HOST');

// 記事の保存と元の例外の再送出を PostHog の遅れで待たせない（DD-01 の 7.2 と DD-04 の 2・3 節）。
// リトライはしない（送信失敗は記事の保存を止めない）。
const POSTHOG_TIMEOUT_MS = 5000;

export const posthog =
  configuredProjectToken && configuredHost
    ? new PostHog(configuredProjectToken, {
        host: configuredHost,
        enableExceptionAutocapture: true,
        requestTimeout: POSTHOG_TIMEOUT_MS,
        fetchRetryCount: 0,
      })
    : undefined;

// requestTimeout は 1 回の HTTP リクエストにしか効かないため、flush 全体も 5 秒で見切る。
// 見切った後も送信自体は裏で続くが、呼び出し側（ライフサイクルとミドルウェア）はここで先へ進む。
const flushWithTimeout = async (client: PostHog) => {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      client.flush().catch((error: unknown) => {
        console.error('PostHog flush failed', error);
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`PostHog flush timed out after ${POSTHOG_TIMEOUT_MS}ms`);
          resolve();
        }, POSTHOG_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const capturePostHogEvent = async (
  distinctId: string,
  event: string,
  properties: Record<string, unknown>
) => {
  if (!posthog) {
    return;
  }

  posthog.capture({ distinctId, event, properties });
  await flushWithTimeout(posthog);
};

export const capturePostHogException = async (
  error: unknown,
  distinctId: string,
  properties: Record<string, unknown>
) => {
  if (!posthog) {
    return;
  }

  posthog.captureException(error, distinctId, properties);
  await flushWithTimeout(posthog);
};

export const shutdownPostHog = async () => {
  await posthog?.shutdown();
};
