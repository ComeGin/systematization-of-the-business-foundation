import { afterEach, describe, expect, it, vi } from "vitest";
import { FORM_SUCCESS_EVENT as AVATAR_FORM_SUCCESS_EVENT } from "@/modules/avatar/lib/triggers";
import {
  dispatchFormSuccess,
  FORM_SUCCESS_EVENT,
  type FormKey,
} from "@/modules/forms/lib/events";

// dispatchFormSuccess（送信の成功を document に知らせる。受け手はアバターの watchTriggers）。
// 計測（PostHog）は外部なのでモックする。document は EventTarget の偽物にする。
vi.mock("@/modules/analytics/client", () => ({ track: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchFormSuccess", () => {
  describe("正常系", () => {
    it("document に comegin:form-success を出し、detail.formKey に送ったフォームが入る", () => {
      const target = new EventTarget();
      vi.stubGlobal("document", target);
      const received: FormKey[] = [];
      target.addEventListener(FORM_SUCCESS_EVENT, (event) => {
        received.push((event as CustomEvent<{ formKey: FormKey }>).detail.formKey);
      });

      dispatchFormSuccess("consult");

      expect(received).toEqual(["consult"]);
    });

    it("送り手（forms）の定数と受け手（avatar の triggers）の定数が同じ値", () => {
      expect(FORM_SUCCESS_EVENT).toBe("comegin:form-success");
      expect(AVATAR_FORM_SUCCESS_EVENT).toBe(FORM_SUCCESS_EVENT);
    });
  });

  describe("異常系", () => {
    // 空入力: は置かない（formKey は型で必須。空の値を渡す経路が無い）

    it("入力: document が無い環境（SSR・Node）では throw しない", () => {
      vi.stubGlobal("document", undefined);
      expect(() => dispatchFormSuccess("source_dl")).not.toThrow();
    });
  });
});
