import { toNextJsHandler } from "better-auth/next-js";
import { ensureAuthSchema, getAuth } from "@/lib/auth";

// モジュールの読み込み時（next build のデータ収集を含む）に DB を開かないよう、要求のたびに取り出す
async function handlers() {
  await ensureAuthSchema();
  return toNextJsHandler(getAuth());
}

export async function GET(request: Request) {
  return (await handlers()).GET(request);
}

export async function POST(request: Request) {
  return (await handlers()).POST(request);
}
