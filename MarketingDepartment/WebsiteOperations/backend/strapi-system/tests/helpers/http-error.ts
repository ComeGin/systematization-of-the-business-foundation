import { createRequire } from 'node:module';

// @strapi/utils の errors.HttpError は http-errors の HttpError をそのまま出している（抽象クラスで new できない）。
// http-errors は直接の依存ではないため、@strapi/utils の場所から読み込んで同じクラスの実物を作る。
const requireHere = createRequire(import.meta.url);
const requireFromUtils = createRequire(requireHere.resolve('@strapi/utils'));
const createHttpError = requireFromUtils('http-errors') as (status: number, message?: string) => Error & {
  status: number;
};

export const httpError = (status: number, message?: string) =>
  message === undefined ? createHttpError(status) : createHttpError(status, message);
