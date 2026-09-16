import { PostHog } from 'posthog-node';

const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;

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

export const posthog =
  configuredProjectToken && configuredHost
    ? new PostHog(configuredProjectToken, {
        host: configuredHost,
        enableExceptionAutocapture: true,
      })
    : undefined;

export const capturePostHogEvent = async (
  distinctId: string,
  event: string,
  properties: Record<string, unknown>
) => {
  if (!posthog) {
    return;
  }

  posthog.capture({ distinctId, event, properties });
  await posthog.flush();
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
  await posthog.flush();
};

export const shutdownPostHog = async () => {
  await posthog?.shutdown();
};
