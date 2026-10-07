import { describe, expect, it } from "vitest";

import type { ContactDetail } from "../../src/schemas/contacts.js";
import { renderContactDetail, renderContactList, toContactDetail, toContactSummary } from "../../src/services/format.js";
import { pagedOutput } from "../../src/services/results.js";
import type { MauticContact } from "../../src/types.js";

function contact(overrides: Partial<MauticContact> = {}, fields: Record<string, unknown> = {}): MauticContact {
  return {
    id: 42,
    dateAdded: "2026-01-01T00:00:00+00:00",
    dateModified: "2026-02-01T00:00:00+00:00",
    lastActive: "2026-03-01T00:00:00+00:00",
    points: 15,
    owner: { id: 1, firstName: "Taro", lastName: "Sato" },
    stage: { id: 2, name: "Lead" },
    tags: [{ tag: "vip" }, { tag: "trial" }],
    fields: { all: { id: 42, email: "alice@example.com", firstname: "Alice", lastname: "Tanaka", company: "Acme", ...fields } },
    ...overrides,
  };
}

describe("toContactSummary", () => {
  describe("正常系", () => {
    it("一覧に出す項目に整形する", () => {
      expect(toContactSummary(contact())).toEqual({
        id: 42,
        email: "alice@example.com",
        firstname: "Alice",
        lastname: "Tanaka",
        company: "Acme",
        points: 15,
        stage: "Lead",
        owner: "Taro Sato",
        tags: ["vip", "trial"],
        last_active: "2026-03-01T00:00:00+00:00",
        date_added: "2026-01-01T00:00:00+00:00",
      });
    });

    it("担当者・ステージがなければ null にする", () => {
      const summary = toContactSummary(contact({ owner: null, stage: null }));
      expect(summary.owner).toBeNull();
      expect(summary.stage).toBeNull();
    });

    it("空入力: 担当者の姓名がどちらも空なら null にし、片方だけなら前後の空白を除く", () => {
      expect(toContactSummary(contact({ owner: { id: 1, firstName: "", lastName: "" } })).owner).toBeNull();
      expect(toContactSummary(contact({ owner: { id: 1, firstName: "", lastName: "Sato" } })).owner).toBe("Sato");
    });

    it("空入力: fields.all・tags が空なら、名前などは null・tags は [] にする", () => {
      const summary = toContactSummary({ ...contact(), tags: [], fields: { all: {} } });
      expect(summary).toMatchObject({ email: null, firstname: null, lastname: null, company: null, tags: [] });
    });
  });

  describe("異常系", () => {
    it("サーバ: 空文字・null・文字列以外のフィールドは null、数値は文字列にする", () => {
      const summary = toContactSummary(contact({}, { email: "", firstname: null, lastname: { x: 1 }, company: 123 }));
      expect(summary.email).toBeNull();
      expect(summary.firstname).toBeNull();
      expect(summary.lastname).toBeNull();
      expect(summary.company).toBe("123");
    });
  });
});

describe("toContactDetail", () => {
  describe("正常系", () => {
    it("fields から id・null・空文字を除く", () => {
      const detail = toContactDetail(contact({}, { phone: null, city: "", plan: "pro", score: 0 }));
      expect(detail.fields).toEqual({ email: "alice@example.com", firstname: "Alice", lastname: "Tanaka", company: "Acme", plan: "pro", score: 0 });
    });

    it("Do Not Contact の reason を名前に変換し、未知の値は数値の文字列にする", () => {
      const detail = toContactDetail(
        contact({
          doNotContact: [
            { channel: "email", reason: 1, comments: "clicked unsubscribe" },
            { channel: "sms", reason: 2, comments: null },
            { channel: "email", reason: 3, comments: null },
            { channel: "email", reason: 0, comments: null },
            { channel: "email", reason: 9, comments: null },
          ],
        }),
      );
      expect(detail.do_not_contact.map((dnc) => dnc.reason)).toEqual(["unsubscribed", "bounced", "manual", "contactable", "9"]);
      expect(detail.do_not_contact[0]).toEqual({ channel: "email", reason: "unsubscribed", comments: "clicked unsubscribe" });
    });

    it("空入力: doNotContact がなければ空配列にする", () => {
      expect(toContactDetail(contact()).do_not_contact).toEqual([]);
    });

    it("空入力: fields.all が id だけなら fields は空オブジェクトにする", () => {
      expect(toContactDetail({ ...contact(), fields: { all: { id: 42 } } }).fields).toEqual({});
    });

    it("要約の項目に date_modified を加える", () => {
      const detail = toContactDetail(contact());
      expect(detail.id).toBe(42);
      expect(detail.date_modified).toBe("2026-02-01T00:00:00+00:00");
    });
  });
});

describe("renderContactList", () => {
  describe("正常系", () => {
    it("検索語付きの見出しと、表示範囲・各コンタクトの要約を出す", () => {
      const output = pagedOutput(30, 10, [toContactSummary(contact())]);
      const text = renderContactList(output, "tag:vip");
      expect(text).toContain("# Contacts matching 'tag:vip'");
      expect(text).toContain("Showing 11-11 of 30");
      expect(text).toContain("## Alice Tanaka (ID: 42)");
      expect(text).toContain("- **Email**: alice@example.com");
      expect(text).toContain("- **Tags**: vip, trial");
      expect(text).toContain("More results available: call again with offset=11.");
    });

    it("空入力: 検索語がなければ見出しは # Contacts", () => {
      expect(renderContactList(pagedOutput(1, 0, [toContactSummary(contact())]), undefined).split("\n")[0]).toBe("# Contacts");
    });

    it("空入力: 検索語が空文字でも見出しは # Contacts", () => {
      expect(renderContactList(pagedOutput(1, 0, [toContactSummary(contact())]), "").split("\n")[0]).toBe("# Contacts");
    });

    it("空入力: 0 件なら件数だけを伝える", () => {
      expect(renderContactList(pagedOutput(0, 0, []), "x")).toBe("# Contacts matching 'x'\n\nNo contacts found (total: 0).");
    });

    it("続きがなければページングの案内を出さない", () => {
      expect(renderContactList(pagedOutput(1, 0, [toContactSummary(contact())]), undefined)).not.toContain("More results");
    });

    it("truncation_message があれば Note として出す", () => {
      const output = { ...pagedOutput(1, 0, [toContactSummary(contact())]), truncation_message: "cut" };
      expect(renderContactList(output, undefined)).toContain("Note: cut");
    });

    it("名前がなければメール、メールもなければ (anonymous) を表示名にする", () => {
      const byEmail = toContactSummary(contact({}, { firstname: "", lastname: "" }));
      const anonymous = toContactSummary(contact({ owner: null, stage: null, tags: [], lastActive: null }, { firstname: "", lastname: "", email: "", company: "" }));
      const text = renderContactList(pagedOutput(2, 0, [byEmail, anonymous]), undefined);
      expect(text).toContain("## alice@example.com (ID: 42)");
      expect(text).toContain("## (anonymous) (ID: 42)");
    });

    it("空入力: 空の項目は行を出さず、最終アクティブがなければ never と出す", () => {
      const summary = toContactSummary(contact({ owner: null, stage: null, tags: [], lastActive: null }, { email: "", company: "" }));
      const text = renderContactList(pagedOutput(1, 0, [summary]), undefined);
      expect(text).not.toContain("**Email**");
      expect(text).not.toContain("**Company**");
      expect(text).not.toContain("**Stage**");
      expect(text).not.toContain("**Owner**");
      expect(text).not.toContain("**Tags**");
      expect(text).toContain("- **Points**: 15");
      expect(text).toContain("- **Last active**: never");
    });
  });
});

describe("renderContactDetail", () => {
  describe("正常系", () => {
    it("要約・日付・フィールドを出し、オブジェクトの値は JSON にする", () => {
      const detail = toContactDetail(contact({}, { social: { twitter: "@alice" } }));
      const text = renderContactDetail(detail);
      expect(text).toContain("## Alice Tanaka (ID: 42)");
      expect(text).toContain("- **Added**: 2026-01-01T00:00:00+00:00");
      expect(text).toContain("- **Modified**: 2026-02-01T00:00:00+00:00");
      expect(text).toContain("### Fields");
      expect(text).toContain('- **social**: {"twitter":"@alice"}');
    });

    it("Do Not Contact があるときだけその節を出し、コメントは括弧で添える", () => {
      const withDnc = toContactDetail(contact({ doNotContact: [{ channel: "email", reason: 1, comments: "via link" }] }));
      expect(renderContactDetail(withDnc)).toContain("### Do Not Contact\n- email: unsubscribed (via link)");
      expect(renderContactDetail(toContactDetail(contact()))).not.toContain("Do Not Contact");
    });

    it("空入力: 日付がなければ - を出す", () => {
      const detail: ContactDetail = { ...toContactDetail(contact()), date_added: null, date_modified: null };
      const text = renderContactDetail(detail);
      expect(text).toContain("- **Added**: -");
      expect(text).toContain("- **Modified**: -");
    });

    it("空入力: fields が空なら Fields の見出しだけを最後に出す", () => {
      const detail: ContactDetail = { ...toContactDetail(contact()), fields: {} };
      expect(renderContactDetail(detail).endsWith("\n\n### Fields")).toBe(true);
    });
  });
});
