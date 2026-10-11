// Route Handler を関数として直接呼ぶとき、Next.js の要求の文脈（headers()）は無い。
// テストの vi.mock("next/headers") がここの値を返し、lib/session.ts の getSession() に要求のヘッダーを渡す。
// next/headers の差し替えから読むため、このファイルは何も import しない（循環を避ける）。
export const requestScope: { headers: Headers } = { headers: new Headers() };
