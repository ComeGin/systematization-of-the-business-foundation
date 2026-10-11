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

// koa の ctx.throw が使う http-errors（koa が依存する版。2026-10 時点で 1.8 系）。@strapi/utils の版とはクラスが別で、
// errors.HttpError の instanceof が偽になる（src/middlewares/posthog-error.ts の判定の回帰の確認に使う）
const requireFromCore = createRequire(requireHere.resolve('@strapi/core', { paths: [requireHere.resolve('@strapi/strapi')] }));
const requireFromKoa = createRequire(requireFromCore.resolve('koa'));
const createKoaHttpError = requireFromKoa('http-errors') as typeof createHttpError;

export const koaHttpError = (status: number, message?: string) =>
  message === undefined ? createKoaHttpError(status) : createKoaHttpError(status, message);
