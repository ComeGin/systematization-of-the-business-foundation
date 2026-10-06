import { describe, expect, it } from "vitest";

import { MauticApiError } from "../../src/services/mautic-client.js";
import { registerSystemTools } from "../../src/tools/system.js";
import { createFakeClient, createFakeServer } from "../helpers/fake-server.js";

function setup() {
  const fake = createFakeServer();
  const client = createFakeClient();
  registerSystemTools(fake.server, client.client);
  return { ...fake, ...client };
}

describe("registerSystemTools", () => {
  it("3 ツールを参照専用で登録する", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual(["mautic_list_files", "mautic_list_lookup", "mautic_list_themes"]);
    for (const tool of tools.values()) expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("mautic_list_files", () => {
  it("既定は images を subdir なしで取る", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ files: [] });
    await call("mautic_list_files");
    expect(get).toHaveBeenCalledWith("/files/images", { subdir: undefined });
  });

  it("dir と subdir を指定できる", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ files: [] });
    await call("mautic_list_files", { dir: "media", subdir: "files/2026" });
    expect(get).toHaveBeenCalledWith("/files/media", { subdir: "files/2026" });
  });

  it("subdir に .. や記号は使えない", async () => {
    const { call, get } = setup();
    await expect(call("mautic_list_files", { subdir: "../../etc" })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("mautic_list_themes", () => {
  it("/themes を返し、引数は受け付けない", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ themes: { blank: { name: "Blank" } } });
    const result = await call("mautic_list_themes");
    expect(get).toHaveBeenCalledWith("/themes");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ themes: { blank: { name: "Blank" } } });
    await expect(call("mautic_list_themes", { dir: "x" })).rejects.toThrow();
  });
});

describe("mautic_list_lookup", () => {
  it.each([
    ["point_action_types", "/points/actions/types"],
    ["point_trigger_event_types", "/points/triggers/events/types"],
    ["webhook_triggers", "/hooks/triggers"],
    ["contact_owners", "/contacts/list/owners"],
  ])("kind=%s は %s を呼ぶ", async (kind, path) => {
    const { call, get } = setup();
    get.mockResolvedValue([]);
    await call("mautic_list_lookup", { kind });
    expect(get).toHaveBeenCalledWith(path);
  });

  it("API エラーは isError の結果にする", async () => {
    const { call, get } = setup();
    get.mockRejectedValue(new MauticApiError(403, "denied"));
    expect((await call("mautic_list_lookup", { kind: "contact_owners" })).isError).toBe(true);
  });
});
