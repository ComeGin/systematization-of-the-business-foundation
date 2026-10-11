// config/*.ts に渡す env() ヘルパーの偽物。process.env ではなく渡したオブジェクトだけを読む。
// 振る舞いは @strapi/utils の env-helper に合わせる（キーが無ければ既定値、あれば空文字でもその値を使う。
// bool は 'true' のときだけ true、int は parseInt、array はカンマ区切りで前後の空白と " を外す）。
export type EnvVars = Record<string, string>;

export const createEnv = (vars: EnvVars = {}) => {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(vars, key);
  const raw = (key: string) => vars[key] ?? '';

  const env = (key: string, defaultValue?: unknown) => (has(key) ? vars[key] : defaultValue);

  return Object.assign(env, {
    int: (key: string, defaultValue?: number) => (has(key) ? parseInt(raw(key), 10) : defaultValue),
    float: (key: string, defaultValue?: number) => (has(key) ? parseFloat(raw(key)) : defaultValue),
    bool: (key: string, defaultValue?: boolean) => (has(key) ? raw(key) === 'true' : defaultValue),
    json: (key: string, defaultValue?: unknown) => (has(key) ? JSON.parse(raw(key)) : defaultValue),
    array: (key: string, defaultValue?: string[]) => {
      if (!has(key)) {
        return defaultValue;
      }
      let value = raw(key);
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.substring(1, value.length - 1);
      }
      return value.split(',').map((v) => v.trim().replace(/^"+|"+$/g, ''));
    },
    date: (key: string, defaultValue?: Date) => (has(key) ? new Date(raw(key)) : defaultValue),
    oneOf: (key: string, expected: unknown[], defaultValue?: unknown) => {
      const value = env(key, defaultValue);
      return value !== undefined && expected.includes(value) ? value : defaultValue;
    },
  });
};

// Core.Config.Shared.ConfigParams の形（{ env }）で渡すための薄い包み
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const configParams = (vars: EnvVars = {}) => ({ env: createEnv(vars) }) as any;
