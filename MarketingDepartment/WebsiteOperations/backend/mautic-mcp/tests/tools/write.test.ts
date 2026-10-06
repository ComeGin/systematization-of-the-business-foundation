import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { CHARACTER_LIMIT } from "../../src/constants.js";
import { MauticApiError } from "../../src/services/mautic-client.js";
import { registerWriteTools } from "../../src/tools/write.js";
import { createFakeClient, createFakeServer } from "../helpers/fake-server.js";

type AccessLevel = "read_only" | "read_write" | "full";

function setup(accessLevel: AccessLevel = "full") {
  const fake = createFakeServer();
  const client = createFakeClient();
  registerWriteTools(fake.server, client.client, accessLevel);
  return { ...fake, ...client };
}

describe("registerWriteTools: ACCESS_LEVEL ごとの登録", () => {
  it("read_only では書き込みツールを 1 つも登録しない", () => {
    expect([...setup("read_only").tools.keys()]).toEqual([]);
  });

  it("read_write では作成・更新だけを登録し、削除は登録しない", () => {
    expect([...setup("read_write").tools.keys()].sort()).toEqual(["mautic_create_record", "mautic_update_record"]);
  });

  it("full では作成・更新・削除を登録する", () => {
    expect([...setup("full").tools.keys()].sort()).toEqual(["mautic_create_record", "mautic_delete_record", "mautic_update_record"]);
  });

  it("read_only ⊂ read_write ⊂ full の包含関係になる", () => {
    const names = (level: AccessLevel) => new Set(setup(level).tools.keys());
    const [readOnly, readWrite, full] = [names("read_only"), names("read_write"), names("full")];
    for (const name of readOnly) expect(readWrite.has(name)).toBe(true);
    for (const name of readWrite) expect(full.has(name)).toBe(true);
    expect(full.size).toBeGreaterThan(readWrite.size);
    expect(readWrite.size).toBeGreaterThan(readOnly.size);
  });
});

describe("registerWriteTools: SDK の McpServer への登録", () => {
  it.each<AccessLevel>(["read_only", "read_write", "full"])("%s の書き込みツールを SDK の McpServer に登録できる", (level) => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => registerWriteTools(server, createFakeClient().client, level)).not.toThrow();
  });
});

describe("registerWriteTools: annotation", () => {
  it("作成は destructiveHint=false・idempotentHint=false", () => {
    expect(setup().tools.get("mautic_create_record")!.config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it.each(["mautic_update_record", "mautic_delete_record"])("%s は destructiveHint=true（クライアントに確認させる）", (name) => {
    expect(setup().tools.get(name)!.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe("mautic_create_record", () => {
  it("POST {path}/new に data を送り、作成結果を返す", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({ list: { id: 9, name: "VIP", alias: "vip" } });

    const result = await call("mautic_create_record", { resource: "segments", data: { name: "VIP" } });
    expect(write).toHaveBeenCalledWith("POST", "/segments/new", { name: "VIP" });
    expect(result.structuredContent).toEqual({ resource: "segments", action: "created", record: { id: 9, name: "VIP", alias: "vip" } });
    expect(result.content[0]!.text.startsWith("created segments 9\n\n# segments 9")).toBe(true);
  });

  it("contacts は /contacts/new に送り、contact キーの中身を取り出す", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({ contact: { id: 5, points: 0 } });
    const result = await call("mautic_create_record", { resource: "contacts", data: { email: "a@example.com" } });
    expect(write).toHaveBeenCalledWith("POST", "/contacts/new", { email: "a@example.com" });
    expect(result.structuredContent?.record).toEqual({ id: 5, points: 0 });
  });

  it("レスポンスに one のキーがなければ全体を record にする", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({ id: 3, name: "Customer" });
    const result = await call("mautic_create_record", { resource: "stages", data: { name: "Customer" } });
    expect(result.structuredContent?.record).toEqual({ id: 3, name: "Customer" });
  });

  it("返す record の秘匿情報（Webhook の secret など）を伏せる", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({ hook: { id: 1, name: "CRM", secret: "whsec_123" } });
    const result = await call("mautic_create_record", {
      resource: "webhooks",
      data: { name: "CRM" },
      response_format: "json",
    });
    expect(result.structuredContent?.record).toEqual({ id: 1, name: "CRM", secret: "[redacted]" });
    expect(result.content[0]!.text).not.toContain("whsec_123");
  });

  it("response_format=json なら action・resource・record の JSON をテキストにする", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({ tag: { id: 3, tag: "vip" } });
    const result = await call("mautic_create_record", { resource: "tags", data: { tag: "vip" }, response_format: "json" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ action: "created", resource: "tags", record: { id: 3, tag: "vip" } });
  });

  it("テキストが CHARACTER_LIMIT を超えたら切り詰める（structuredContent はそのまま）", async () => {
    const { call, write } = setup();
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, "x".repeat(900)]));
    write.mockResolvedValue({ email: { id: 1, ...many } });
    const result = await call("mautic_create_record", { resource: "emails", data: { name: "n" } });
    expect(result.content[0]!.text.endsWith("\n… [truncated]")).toBe(true);
    expect(result.content[0]!.text.length).toBe(CHARACTER_LIMIT + "\n… [truncated]".length);
    expect(Object.keys(result.structuredContent?.record as object)).toHaveLength(61);
  });

  it("data が空なら入力検証で拒否する", async () => {
    const { call, write } = setup();
    await expect(call("mautic_create_record", { resource: "tags", data: {} })).rejects.toThrow("data must contain at least one field");
    expect(write).not.toHaveBeenCalled();
  });

  it("書き込み対象でない resource は入力検証で拒否する", async () => {
    const { call } = setup();
    await expect(call("mautic_create_record", { resource: "smses", data: { a: 1 } })).rejects.toThrow();
  });

  it("API エラーは isError の結果にする", async () => {
    const { call, write } = setup();
    write.mockRejectedValue(new MauticApiError(422, "name: required"));
    const result = await call("mautic_create_record", { resource: "segments", data: { alias: "x" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Mautic rejected the request (name: required)");
  });
});

describe("mautic_update_record", () => {
  it("PATCH {path}/{id}/edit で送る（PUT は使わない）", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({ contact: { id: 42, points: 150 } });

    const result = await call("mautic_update_record", { resource: "contacts", id: 42, data: { points: 150 } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("PATCH", "/contacts/42/edit", { points: 150 });
    expect(result.structuredContent).toEqual({ resource: "contacts", action: "updated", record: { id: 42, points: 150 } });
  });

  it("どの resource でも PUT を使わない", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({});
    for (const resource of ["contacts", "emails", "segments", "webhooks"]) {
      await call("mautic_update_record", { resource, id: 1, data: { name: "x" } });
    }
    expect(write.mock.calls.map(([method]) => method)).toEqual(["PATCH", "PATCH", "PATCH", "PATCH"]);
  });

  it("id は正の整数だけを受け付ける", async () => {
    const { call, write } = setup();
    await expect(call("mautic_update_record", { resource: "tags", id: 0, data: { tag: "x" } })).rejects.toThrow();
    await expect(call("mautic_update_record", { resource: "tags", id: "1/delete", data: { tag: "x" } })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("存在しない ID の 404 は Not found のエラーにする", async () => {
    const { call, write } = setup();
    write.mockRejectedValue(new MauticApiError(404, "Item was not found."));
    const result = await call("mautic_update_record", { resource: "tags", id: 999, data: { tag: "x" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^Error: Not found \(Item was not found\.\)/);
  });
});

describe("mautic_delete_record", () => {
  it("DELETE {path}/{id}/delete を body なしで送り、削除前の record を返す", async () => {
    const { call, write } = setup();
    write.mockResolvedValue({ email: { id: 7, name: "Old" } });
    const result = await call("mautic_delete_record", { resource: "emails", id: 7 });
    expect(write).toHaveBeenCalledWith("DELETE", "/emails/7/delete");
    expect(result.structuredContent).toEqual({ resource: "emails", action: "deleted", record: { id: 7, name: "Old" } });
  });

  it("data は受け付けない（strict）", async () => {
    const { call } = setup();
    await expect(call("mautic_delete_record", { resource: "emails", id: 7, data: { a: 1 } })).rejects.toThrow();
  });
});
