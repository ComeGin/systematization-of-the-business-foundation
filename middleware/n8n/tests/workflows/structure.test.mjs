// 全ワークフロー（workflows/*.json）に共通の不変条件。README.md・GUIDE.md に書いた約束を JSON の上で確かめる。
// 検査の本体は check* の関数にまとめ、正常系では実際の JSON に、異常系では約束を破るように書き換えた複製に当てて、
// 検査が素通りしない（違反を本当に検出する）ことも確かめる。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOWS_DIR, loadWorkflow, referencedNodeNames, workflowFiles } from "../helpers/workflow.mjs";

const FILES = workflowFiles();
const WORKFLOWS = FILES.map((file) => ({ file, wf: loadWorkflow(file) }));
const byPrefix = (prefix) => WORKFLOWS.find(({ file }) => file.startsWith(prefix)).wf;

const TRIGGER_TYPES = new Set(["n8n-nodes-base.webhook", "n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.executeWorkflowTrigger"]);
const STICKY = "n8n-nodes-base.stickyNote";

// README「各ワークフロー」・GUIDE 5 節の Data Table の表
const DATA_TABLES = {
  dedup_mautic: ["dedupKey", "contactId", "eventType", "timestampSec"],
  dedup_chatwoot: ["dedupKey", "displayId", "messageId"],
  ops_settings: ["key", "value"],
  monitor_state: ["checkId", "state"],
  contact_link: ["chatwootContactId", "displayId", "status", "mauticContactId", "matchCount", "checkedAt"],
};

// GUIDE 6 節の資格情報の表（名前 → 種類）
const CREDENTIALS = {
  "Mautic Webhook 署名鍵（Crypto）": "crypto",
  "Chatwoot Webhook 署名鍵（Crypto）": "crypto",
  "Mautic API（client_credentials）": "oAuth2Api",
  "MailHog SMTP（開発）": "smtp",
  "AWS SNS 発行（アクセスキー）": "aws",
  "Chatwoot API（api_access_token）": "httpHeaderAuth",
};

// README の一覧の、連携点の番号（I-xx）を持たない定期実行のワークフロー（ファイル → n8n の名前・スイッチの行・トリガーの数）
const SCHEDULED = {
  "weekly-inquiry-inventory.json": { name: "週次 問い合わせの棚卸し", switchKey: "inventoryEnabled", triggers: 1 },
  "n8n-schedule-heartbeat.json": { name: "n8n スケジュール実行のハートビート", switchKey: "heartbeatEnabled", triggers: 1 },
  "ops-monitor.json": { name: "運用監視（OpenSEO・サンドボックスの証明書）", switchKey: "opsMonitorEnabled", triggers: 2 },
};

// 資格情報なしで呼んでよい URL（無認証の死活確認だけ。host-relay の nginx が GET /api/health だけを通す）
const NO_AUTH_URLS = new Set(["http://host.docker.internal:3001/api/health"]);

/** パラメーターの中の文字列をすべて取り出す（キーのパスつき） */
function* strings(value, path = []) {
  if (typeof value === "string") yield { path, value };
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, [...path, i]);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* strings(v, [...path, k]);
}

function* entries(value, path = []) {
  if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* entries(v, [...path, i]);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      yield { key: k, value: v, path: [...path, k] };
      yield* entries(v, [...path, k]);
    }
}

/** connections を { from, output, to } の一覧にする */
function edges(wf) {
  const out = [];
  for (const [from, types] of Object.entries(wf.connections)) {
    for (const [type, outputs] of Object.entries(types)) {
      for (const [output, targets] of (outputs ?? []).entries()) for (const t of targets ?? []) out.push({ from, type, output, to: t.node, toType: t.type, index: t.index });
    }
  }
  return out;
}

/** start から辿れるノード名（stop のノードの先には進まない） */
function reachable(wf, start, stop = new Set()) {
  const es = edges(wf);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    if (stop.has(cur)) continue;
    for (const e of es) if (e.from === cur && !seen.has(e.to)) seen.add(e.to), queue.push(e.to);
  }
  return seen;
}

const nodeOf = (wf, name) => wf.nodes.find((n) => n.name === name);

// ---------------------------------------------------------------------------
// 検査（実際の JSON と、異常系の壊した複製の両方に当てる）
// ---------------------------------------------------------------------------

function checkShape(wf) {
  expect(typeof wf.name).toBe("string");
  expect(Array.isArray(wf.nodes)).toBe(true);
  expect(wf.nodes.length).toBeGreaterThan(0);
  expect(typeof wf.connections).toBe("object");
  expect(typeof wf.settings).toBe("object");
}

function checkNotActive(wf) {
  expect(wf.active).toBe(false);
}

function checkNoDisabled(wf) {
  expect(wf.nodes.filter((n) => n.disabled).map((n) => n.name)).toEqual([]);
}

function checkUniqueNames(wf) {
  const names = wf.nodes.map((n) => n.name);
  const ids = wf.nodes.map((n) => n.id);
  expect(new Set(names).size).toBe(names.length);
  expect(new Set(ids).size).toBe(ids.length);
}

function checkConnections(wf) {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const e of edges(wf)) {
    expect(names, `接続元 ${e.from}`).toContain(e.from);
    expect(names, `接続先 ${e.to}`).toContain(e.to);
    expect(e.type).toBe("main");
    expect(e.toType).toBe("main");
    expect(e.index).toBe(0);
  }
}

function checkNoOrphans(wf) {
  const targets = new Set(edges(wf).map((e) => e.to));
  const orphans = wf.nodes.filter((n) => !TRIGGER_TYPES.has(n.type) && n.type !== STICKY && !targets.has(n.name)).map((n) => n.name);
  expect(orphans).toEqual([]);
}

function checkReferencesExist(wf) {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const node of wf.nodes) {
    for (const { value } of strings(node.parameters)) for (const ref of referencedNodeNames(value)) expect(names, `${node.name} → ${ref}`).toContain(ref);
  }
}

function checkReferencesUpstream(wf) {
  for (const node of wf.nodes) {
    for (const { value } of strings(node.parameters)) {
      for (const ref of referencedNodeNames(value)) expect(reachable(wf, ref), `${node.name} → ${ref}`).toContain(node.name);
    }
  }
}

function checkNoPinData(wf) {
  expect(Object.keys(wf.pinData ?? {})).toEqual([]);
}

function checkCredentialRefs(wf) {
  for (const node of wf.nodes) {
    for (const [type, cred] of Object.entries(node.credentials ?? {})) {
      expect(Object.keys(cred).every((k) => k === "name" || k === "id"), node.name).toBe(true);
      expect(Object.keys(CREDENTIALS), node.name).toContain(cred.name);
      expect(type, node.name).toBe(CREDENTIALS[cred.name]);
    }
  }
}

function checkNoEmbeddedSecrets(text) {
  const patterns = [
    /AKIA[0-9A-Z]{16}/, // AWS のアクセスキー
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/,
    /\bsk-[A-Za-z0-9_-]{20,}/,
    /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /\bphc_[A-Za-z0-9]{20,}/, // PostHog のプロジェクトキー
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/, // JWT
  ];
  for (const p of patterns) expect(text, String(p)).not.toMatch(p);
}

function checkNoSecretParams(wf) {
  const SECRETISH = /password|passwd|secret|token|api_?key|access_?key|private_?key|authorization/i;
  for (const node of wf.nodes) {
    for (const { key, value, path } of entries(node.parameters)) {
      if (!SECRETISH.test(key)) continue;
      expect(typeof value === "string" ? value : "", `${node.name}: ${path.join(".")}`).toBe("");
    }
  }
}

function checkHttpAuth(wf) {
  for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest")) {
    const { authentication, genericAuthType, nodeCredentialType, url } = node.parameters;
    const credTypes = Object.keys(node.credentials ?? {});
    expect(node.parameters.sendHeaders ?? false, node.name).toBe(false);
    if (authentication === "genericCredentialType") {
      // 汎用の資格情報（OAuth2・Header Auth）。種類と割り当てた資格情報が一致する
      expect(credTypes, node.name).toEqual([genericAuthType]);
    } else if (authentication === "predefinedCredentialType") {
      // 製品の資格情報で署名するのは AWS だけ（ハートビートの PutMetricData。SigV4）
      expect(nodeCredentialType, node.name).toBe("aws");
      expect(credTypes, node.name).toEqual(["aws"]);
      expect(new URL(url).hostname, node.name).toMatch(/\.amazonaws\.com$/);
    } else {
      // 資格情報なしは、無認証の死活確認の URL だけ（GET）
      expect(authentication ?? "none", node.name).toBe("none");
      expect(credTypes, node.name).toEqual([]);
      expect(NO_AUTH_URLS, node.name).toContain(url);
      expect(node.parameters.method ?? "GET", node.name).toBe("GET");
    }
  }
}

function checkCodeNodes(wf) {
  for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.code")) {
    const code = node.parameters.jsCode;
    expect(code, node.name).not.toMatch(/\brequire\s*\(/);
    expect(code, node.name).not.toMatch(/process\.env|\$env\b/);
  }
}

function checkCryptoHmac(wf) {
  for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.crypto" && n.parameters.action === "hmac")) {
    expect(node.credentials?.crypto?.name, node.name).toBeTruthy();
    expect(node.parameters, node.name).not.toHaveProperty("secret");
  }
}

const dataTableNodes = (wf) => wf.nodes.filter((n) => n.type === "n8n-nodes-base.dataTable");

function checkDataTableNames(wf) {
  for (const node of dataTableNodes(wf)) {
    expect(node.parameters.dataTableId.mode, node.name).toBe("name");
    expect(Object.keys(DATA_TABLES), node.name).toContain(node.parameters.dataTableId.value);
  }
}

function checkDataTableColumns(wf) {
  for (const node of dataTableNodes(wf).filter((n) => ["insert", "upsert", "update"].includes(n.parameters.operation))) {
    const allowed = DATA_TABLES[node.parameters.dataTableId.value];
    for (const col of Object.keys(node.parameters.columns.value)) expect(allowed, `${node.name}: ${col}`).toContain(col);
  }
}

function checkDataTableFilters(wf) {
  for (const node of dataTableNodes(wf)) {
    const allowed = [...DATA_TABLES[node.parameters.dataTableId.value], "id", "createdAt", "updatedAt"];
    for (const c of node.parameters.filters?.conditions ?? []) expect(allowed, `${node.name}: ${c.keyName}`).toContain(c.keyName);
  }
}

/** サブワークフローの失敗で止まらない。error 出力に流すもの（I-12 の I-19。成功したときだけ突合の印を記録する）は、error 出力がつながっている */
function checkSubworkflowOnError(wf) {
  for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.executeWorkflow")) {
    expect(["continueRegularOutput", "continueErrorOutput"], node.name).toContain(node.onError);
    if (node.onError === "continueErrorOutput") expect(wf.connections[node.name]?.main?.[1]?.length ?? 0, node.name).toBeGreaterThan(0);
  }
}

const webhooksOf = (wf) => wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook");

function checkWebhookPost(wf) {
  for (const node of webhooksOf(wf)) expect(node.parameters.httpMethod, node.name).toBe("POST");
}

function checkLowercaseHeaders(wf) {
  for (const node of wf.nodes) {
    for (const { value } of strings(node.parameters)) for (const m of value.matchAll(/headers\[['"]([^'"]+)['"]\]/g)) expect(m[1], node.name).toBe(m[1].toLowerCase());
  }
}

/** 署名を検証する Webhook の、200 と 401 の応答ノードと、その分岐の IF */
function signatureGate(wf, hook) {
  const fromHook = reachable(wf, hook.name);
  const respond = wf.nodes.filter((n) => n.type === "n8n-nodes-base.respondToWebhook" && fromHook.has(n.name));
  const ok = respond.find((n) => n.parameters.options?.responseCode === 200);
  const ng = respond.find((n) => n.parameters.options?.responseCode === 401);
  expect(ok).toBeDefined();
  expect(ng).toBeDefined();
  const es = edges(wf);
  const toOk = es.find((e) => e.to === ok.name);
  const toNg = es.find((e) => e.to === ng.name);
  return { fromHook, ok, ng, es, toOk, toNg };
}

function checkSignatureVerifiedThen200(wf, hook) {
  expect(hook.parameters.authentication).toBe("none");
  expect(hook.parameters.options?.rawBody).toBe(true);
  const { fromHook, ok, toOk, toNg } = signatureGate(wf, hook);

  // 署名を資格情報の鍵で計算する Crypto ノードがある
  const hmac = wf.nodes.filter((n) => fromHook.has(n.name) && n.type === "n8n-nodes-base.crypto" && n.parameters.action === "hmac");
  expect(hmac).toHaveLength(1);
  expect(hmac[0].credentials?.crypto?.name).toBeTruthy();

  // 200 と 401 は同じ IF ノードの真（0）と偽（1）に分かれる
  expect(toOk.from).toBe(toNg.from);
  expect(nodeOf(wf, toOk.from).type).toBe("n8n-nodes-base.if");
  expect([toOk.output, toNg.output]).toEqual([0, 1]);

  // IF は計算した署名と受け取った署名を（SHA-256 にしてから）比べる
  const conditions = nodeOf(wf, toOk.from).parameters.conditions;
  expect(conditions.combinator).toBe("and");
  expect(conditions.conditions.some((c) => c.operator.operation === "equals" && /computedDigest/.test(c.leftValue) && /receivedDigest/.test(c.rightValue))).toBe(true);

  // 重複排除・記録・呼び出し・Code は、200 を返した後にしか動かない
  const beforeOk = reachable(wf, hook.name, new Set([ok.name]));
  const PROCESSING = new Set(["n8n-nodes-base.code", "n8n-nodes-base.dataTable", "n8n-nodes-base.executeWorkflow", "n8n-nodes-base.httpRequest"]);
  const early = [...beforeOk].filter((n) => n !== ok.name && PROCESSING.has(nodeOf(wf, n).type));
  expect(early).toEqual([]);
  expect([...reachable(wf, ok.name)].some((n) => nodeOf(wf, n).type === "n8n-nodes-base.code")).toBe(true);
}

function checkSignatureRejects(wf, hook) {
  const { ng, es, toOk } = signatureGate(wf, hook);
  // 署名が空なら通さない（and の条件に notEmpty がある）
  const conditions = nodeOf(wf, toOk.from).parameters.conditions;
  expect(conditions.combinator).toBe("and");
  expect(conditions.conditions.some((c) => c.operator.operation === "notEmpty")).toBe(true);
  // 401 を返したら止まる
  expect(es.filter((e) => e.from === ng.name)).toEqual([]);
}

function checkSwitchGate(wf, spec) {
  const es = edges(wf);
  const PROCESSING = new Set(["n8n-nodes-base.httpRequest", "n8n-nodes-base.executeWorkflow", "n8n-nodes-base.readWriteFile", "n8n-nodes-base.code"]);
  for (const trigger of wf.nodes.filter((n) => n.type === "n8n-nodes-base.scheduleTrigger")) {
    // トリガーから辿った最初の IF がスイッチを見る
    const gate = [...reachable(wf, trigger.name)].map((n) => nodeOf(wf, n)).find((n) => n.type === "n8n-nodes-base.if");
    expect(gate, trigger.name).toBeDefined();
    const conds = gate.parameters.conditions.conditions;
    expect(conds.some((c) => c.leftValue.includes(`'${spec.switchKey}'`) && c.operator.operation === "equals" && c.rightValue === "true"), gate.name).toBe(true);
    // スイッチの値が無いときは 'false' として扱う
    expect(conds.some((c) => /\?\? 'false'/.test(c.leftValue)), gate.name).toBe(true);
    // 偽（1）の出口には何もつながず、処理はスイッチの IF を通った後にしか動かない
    expect(es.filter((e) => e.from === gate.name && e.output === 1)).toEqual([]);
    const beforeGate = [...reachable(wf, trigger.name, new Set([gate.name]))].filter((n) => n !== gate.name);
    expect(beforeGate.filter((n) => PROCESSING.has(nodeOf(wf, n).type)), trigger.name).toEqual([]);
  }
}

/** 定期実行の取得（HTTP・ファイル）は失敗しても止まらず、次の判定のノードまで項目を流す */
function checkScheduledFetchContinues(wf) {
  const FETCH = new Set(["n8n-nodes-base.httpRequest", "n8n-nodes-base.readWriteFile", "n8n-nodes-base.extractFromFile"]);
  for (const node of wf.nodes.filter((n) => FETCH.has(n.type))) {
    expect(node.onError, node.name).toBe("continueRegularOutput");
    expect(node.parameters.options?.timeout ?? 1, node.name).toBeGreaterThan(0);
  }
  // ファイルが 0 件でも次へ項目を流す（読めないことを ng にするため）
  for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.readWriteFile" || n.type === "n8n-nodes-base.extractFromFile")) expect(node.alwaysOutputData, node.name).toBe(true);
}

// ---------------------------------------------------------------------------
// 実際のワークフロー
// ---------------------------------------------------------------------------

describe.each(WORKFLOWS)("$file", ({ file, wf }) => {
  describe("正常系", () => {
    it("JSON として読め、name・nodes・connections・settings を持つ", () => {
      expect(() => JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), "utf8"))).not.toThrow();
      checkShape(wf);
    });

    it("ワークフローの名前がファイル名の連携点の番号（I-xx）で始まる（番号の無い定期実行は README の名前）", () => {
      const id = file.match(/^I-\d+/)?.[0];
      if (id) expect(wf.name.startsWith(`${id} `)).toBe(true);
      else expect(wf.name).toBe(SCHEDULED[file]?.name);
    });

    it("有効化されていない（active: false。公開は人間〈R1〉が行う）", () => checkNotActive(wf));
    it("無効化（disabled）されたノードを残していない", () => checkNoDisabled(wf));
    it("ノード名とノードの id に重複が無い", () => checkUniqueNames(wf));
    it("connections は実在するノードだけを指し、つなぎ先は main の入力 0 である", () => checkConnections(wf));
    it("トリガーと付箋以外のノードには、どこかから入力がつながっている（取り残されたノードが無い）", () => checkNoOrphans(wf));
    it("式や Code の中の $('ノード名') は、実在するノードを指す", () => checkReferencesExist(wf));
    it("$('ノード名') で参照する先は、参照するノードより上流にある", () => checkReferencesUpstream(wf));

    it("タイムゾーンが Asia/Tokyo（自動削除の時刻と表示のため）", () => {
      expect(wf.settings.timezone).toBe("Asia/Tokyo");
    });

    it("ピン留めのデータ（pinData）を書き出していない（テストの本文や個人情報を Git に入れない）", () => checkNoPinData(wf));
    it("サブワークフローの呼び出しは、失敗しても止まらない（continueRegularOutput か、error 出力をつないだ continueErrorOutput）", () => checkSubworkflowOnError(wf));
  });

  describe("資格情報と秘密値", () => {
    describe("正常系", () => {
      it("ノードの資格情報は名前（と id）だけを持ち、名前と種類は GUIDE の表のどれかである", () => checkCredentialRefs(wf));
      it("API キー・トークン・秘密鍵らしい文字列が平文で埋め込まれていない", () => checkNoEmbeddedSecrets(readFileSync(join(WORKFLOWS_DIR, file), "utf8")));
      it("パスワード・シークレット・トークン・API キーの名前のパラメーターに、値を直接書いていない", () => checkNoSecretParams(wf));
      it("HTTP リクエストは資格情報で認証し、Authorization などのヘッダーを手で書いていない", () => checkHttpAuth(wf));
      it("Code ノードは crypto・環境変数を使わない（秘密値と任意コードを同居させない。README の署名検証の方針）", () => checkCodeNodes(wf));
      it("Crypto ノードの HMAC は資格情報の鍵を使い、鍵をパラメーターに持たない", () => checkCryptoHmac(wf));
    });
  });

  describe("Data Table", () => {
    describe("正常系", () => {
      it("名前で参照し、README の 5 つの表のどれかを指す", () => checkDataTableNames(wf));
      it("書き込む列は、その表の README の列だけ（email などを記録しない）", () => checkDataTableColumns(wf));
      it("絞り込みの列は、その表の列か自動で付く列（id・createdAt・updatedAt）だけ", () => checkDataTableFilters(wf));
    });
  });

  describe("Webhook", () => {
    const webhooks = webhooksOf(wf);
    const verified = webhooks.filter((n) => n.parameters.responseMode === "responseNode").map((n) => [n.name, n]);

    describe("正常系", () => {
      it("POST だけを受ける", () => checkWebhookPost(wf));
      it("ヘッダーは小文字の名前で読む（n8n は受け取ったヘッダー名を小文字にする）", () => checkLowercaseHeaders(wf));

      it.each(verified)("%s: 認証は none で、ワークフローの中で署名を検証してから 200 を返し、その後で処理する", (_name, hook) => checkSignatureVerifiedThen200(wf, hook));

      it.each(webhooks.filter((n) => n.parameters.responseMode !== "responseNode").map((n) => [n.name, n]))(
        "%s: 署名を検証しない Webhook は、何もしない骨格（NoOp だけにつながる）である",
        (_name, hook) => {
          const downstream = [...reachable(wf, hook.name)].filter((n) => n !== hook.name);
          expect(downstream.length).toBeGreaterThan(0);
          for (const n of downstream) expect(nodeOf(wf, n).type, n).toBe("n8n-nodes-base.noOp");
        },
      );
    });

    if (verified.length) {
      describe("異常系", () => {
        it.each(verified)("入力: %s: 署名が不正・空なら 401 を返してそこで止まる（署名が空でないことも条件にある）", (_name, hook) => checkSignatureRejects(wf, hook));
      });
    }
  });
});

describe("ワークフローの一覧（README の表）", () => {
  describe("正常系", () => {
    it("README の一覧の 8 本が、すべてファイルとしてある", () => {
      expect(FILES).toEqual([
        "I-11-mautic-webhook-dedup.json",
        "I-12-chatwoot-webhook-dedup.json",
        "I-18-posthog-writeback.json",
        "I-19-email-match.json",
        "I-21-sns-notify.json",
        "n8n-schedule-heartbeat.json",
        "ops-monitor.json",
        "weekly-inquiry-inventory.json",
      ]);
    });

    it("Webhook のパスはワークフローをまたいで重複せず、I-11・I-12 は README の受け口（mautic-event・chatwoot-event）である", () => {
      const paths = WORKFLOWS.flatMap(({ wf }) => wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook").map((n) => n.parameters.path));
      expect(new Set(paths).size).toBe(paths.length);
      const pathOf = (wf) => wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook").parameters.path;
      expect(pathOf(byPrefix("I-11"))).toBe("mautic-event");
      expect(pathOf(byPrefix("I-12"))).toBe("chatwoot-event");
    });

    it("I-11・I-12・I-19 は成功した実行のデータを保存しない（メールアドレスを実行履歴に残さない）", () => {
      for (const p of ["I-11", "I-12", "I-19"]) expect(byPrefix(p).settings.saveDataSuccessExecution, p).toBe("none");
    });

    it("I-21 はワークフロー全体のタイムアウトが 10 秒", () => {
      expect(byPrefix("I-21").settings.executionTimeout).toBe(10);
    });

    it("I-19・I-21 はサブワークフロー（入力を定義したトリガー）で、Webhook を持たない", () => {
      for (const p of ["I-19", "I-21"]) {
        const wf = byPrefix(p);
        const triggers = wf.nodes.filter((n) => TRIGGER_TYPES.has(n.type));
        expect(triggers.map((n) => n.type), p).toEqual(["n8n-nodes-base.executeWorkflowTrigger"]);
        expect(triggers[0].parameters.inputSource, p).toBe("workflowInputs");
      }
    });

    it("I-11・I-12 が呼ぶ子のワークフローに渡す入力は、子のトリガーで定義した入力と一致する", () => {
      const inputsOf = (p) => byPrefix(p).nodes.find((n) => n.type === "n8n-nodes-base.executeWorkflowTrigger").parameters.workflowInputs.values.map((v) => v.name);
      const calls = [
        ["I-11", "I-21 通知を呼ぶ", "I-21"],
        ["I-12", "I-21 通知を呼ぶ", "I-21"],
        ["I-12", "I-19 突合を呼ぶ", "I-19"],
      ];
      for (const [parent, nodeName, child] of calls) {
        const node = nodeOf(byPrefix(parent), nodeName);
        expect(node.parameters.workflowId.cachedResultName, `${parent}/${nodeName}`).toBe(byPrefix(child).name);
        expect(Object.keys(node.parameters.workflowInputs.value).sort(), `${parent}/${nodeName}`).toEqual(inputsOf(child).sort());
      }
    });

    it("サブワークフローの呼び出しはすべて、実在する子を名前で指し、子のトリガーの入力をそのまま渡す", () => {
      const children = WORKFLOWS.filter(({ wf }) => wf.nodes.some((n) => n.type === "n8n-nodes-base.executeWorkflowTrigger"));
      const childByName = new Map(children.map(({ wf }) => [wf.name, wf]));
      for (const { file, wf } of WORKFLOWS) {
        for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.executeWorkflow")) {
          const child = childByName.get(node.parameters.workflowId.cachedResultName);
          expect(child, `${file}/${node.name}`).toBeDefined();
          const inputs = child.nodes.find((n) => n.type === "n8n-nodes-base.executeWorkflowTrigger").parameters.workflowInputs.values.map((v) => v.name);
          expect(Object.keys(node.parameters.workflowInputs.value).sort(), `${file}/${node.name}`).toEqual(inputs.sort());
        }
      }
    });

    it("I-21 の呼び出しの detail は、空か、件数・状態を作るノードの値だけ（email・氏名・本文を参照しない。README の I-21）", () => {
      for (const { file, wf } of WORKFLOWS) {
        for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.executeWorkflow" && n.parameters.workflowId.cachedResultName === byPrefix("I-21").name)) {
          const detail = node.parameters.workflowInputs.value.detail;
          expect(typeof detail, `${file}/${node.name}`).toBe("string");
          expect(detail, `${file}/${node.name}`).not.toMatch(/email|name|content|sender|phone|message/i);
        }
      }
    });

    it("I-18 は PostHog への送信ノードを持たない（誤って有効化しても何も越境しない）", () => {
      const wf = byPrefix("I-18");
      expect(wf.nodes.map((n) => n.type).sort()).toEqual(["n8n-nodes-base.noOp", "n8n-nodes-base.stickyNote", "n8n-nodes-base.webhook"]);
      expect(JSON.stringify(wf.nodes)).not.toMatch(/posthog\.com|httpRequest/i);
    });

    it("保持期限の掃除（I-11 は 03:00、I-12 は 03:05）で、7 日を過ぎた dedup の行を消す", () => {
      for (const [p, minute, table] of [
        ["I-11", 0, "dedup_mautic"],
        ["I-12", 5, "dedup_chatwoot"],
      ]) {
        const wf = byPrefix(p);
        const schedule = wf.nodes.find((n) => n.type === "n8n-nodes-base.scheduleTrigger");
        expect(schedule.parameters.rule.interval[0], p).toMatchObject({ field: "days", daysInterval: 1, triggerAtHour: 3, triggerAtMinute: minute });
        const [next] = edges(wf).filter((e) => e.from === schedule.name);
        const del = nodeOf(wf, next.to);
        expect(del.parameters, p).toMatchObject({ operation: "deleteRows", dataTableId: { value: table } });
        expect(del.parameters.filters.conditions, p).toEqual([expect.objectContaining({ keyName: "createdAt", condition: "lt", keyValue: expect.stringContaining("minus({ days: 7 })") })]);
      }
    });
  });
});

describe("番号の無い定期実行のワークフロー（README の一覧の下 3 本）", () => {
  const scheduled = Object.entries(SCHEDULED).map(([file, spec]) => ({ file, spec, wf: loadWorkflow(file) }));

  describe("正常系", () => {
    it.each(scheduled.map((s) => [s.file, s]))("%s: スケジュールだけで起動し、Webhook を持たず、成功した実行のデータを保存しない", (_file, { spec, wf }) => {
      const triggers = wf.nodes.filter((n) => TRIGGER_TYPES.has(n.type));
      expect(triggers.map((n) => n.type)).toEqual(Array(spec.triggers).fill("n8n-nodes-base.scheduleTrigger"));
      expect(wf.settings.saveDataSuccessExecution).toBe("none");
      expect(wf.settings.executionTimeout).toBeGreaterThan(0);
    });

    it.each(scheduled.map((s) => [s.file, s]))("%s: ops_settings のスイッチの行が 'true' のときだけ先へ進む（既定で止まっている）", (_file, { spec, wf }) => checkSwitchGate(wf, spec));

    it("棚卸しは毎週月曜 09:00 に、Chatwoot の会話を読む（GET）だけで、顧客には何も送らない", () => {
      const wf = loadWorkflow("weekly-inquiry-inventory.json");
      const trigger = wf.nodes.find((n) => n.type === "n8n-nodes-base.scheduleTrigger");
      expect(trigger.parameters.rule.interval[0]).toEqual({ field: "cronExpression", expression: "0 9 * * 1" });
      const http = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
      expect(http.length).toBeGreaterThan(0);
      for (const node of http) {
        expect(node.parameters.method ?? "GET", node.name).toBe("GET");
        expect(node.parameters.url, node.name).toMatch(/\/api\/v1\/accounts\/.*\/conversations$/);
        expect(node.credentials?.httpHeaderAuth?.name, node.name).toBe("Chatwoot API（api_access_token）");
      }
    });

    it("棚卸しの通知に載せるのは件数・会話の番号・待ち時間だけ（氏名・email・本文を読まない）", () => {
      const wf = loadWorkflow("weekly-inquiry-inventory.json");
      // 使ってよいのは meta（件数）・id（会話の番号）・waiting_since（待ち時間）だけ。会話の応答にある連絡先・本文のフィールドを参照しない
      const text = JSON.stringify(wf.nodes.filter((n) => n.type !== STICKY).map((n) => n.parameters));
      expect(text).not.toMatch(/\.(?:email|phone_number|name|content|sender|messages|contact|additional_attributes|custom_attributes)\b/);
    });

    it("ハートビートは 5 分ごとに、名前空間 ComeGin/OnpremN8n のメトリクス ScheduleHeartbeat（値 1、ディメンションなし）を送る（cloud の IAM の条件とアラームに合わせる）", () => {
      const wf = loadWorkflow("n8n-schedule-heartbeat.json");
      const trigger = wf.nodes.find((n) => n.type === "n8n-nodes-base.scheduleTrigger");
      expect(trigger.parameters.rule.interval[0]).toEqual({ field: "minutes", minutesInterval: 5 });
      const [http] = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
      expect(http.parameters.url).toBe("https://monitoring.ap-northeast-1.amazonaws.com/");
      expect(http.parameters.method).toBe("POST");
      // JSON の本文は SigV4 の署名と食い違うため、フォーム形式で送る
      expect(http.parameters.contentType).toBe("form-urlencoded");
      const body = Object.fromEntries(http.parameters.bodyParameters.parameters.map((p) => [p.name, p.value]));
      expect(body.Action).toBe("PutMetricData");
      expect(body.Namespace).toContain("'ComeGin/OnpremN8n'");
      expect(body["MetricData.member.1.MetricName"]).toBe("ScheduleHeartbeat");
      expect(body["MetricData.member.1.Value"]).toBe("1");
      expect(Object.keys(body).some((k) => /Dimensions/.test(k))).toBe(false);
    });

    it("運用監視は OpenSEO の health と、sandbox-tls の公開部分（*.crt）だけを読む（秘密鍵を読まない）", () => {
      const wf = loadWorkflow("ops-monitor.json");
      const http = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
      expect(http.map((n) => n.parameters.url)).toEqual(["http://host.docker.internal:3001/api/health"]);
      const files = wf.nodes.filter((n) => n.type === "n8n-nodes-base.readWriteFile");
      expect(files.length).toBeGreaterThan(0);
      for (const node of files) {
        expect(node.parameters.operation ?? "read", node.name).toBe("read");
        expect(node.parameters.fileSelector, node.name).toMatch(/^\/home\/node\/\.n8n-files\/sandbox-tls\/[^/]*\.crt$/);
      }
    });

    it("運用監視の 2 つの項目（9・5）は、別々の kind で I-21 に状態を伝える（monitor_state の行が混ざらない）", () => {
      const wf = loadWorkflow("ops-monitor.json");
      const kinds = wf.nodes.filter((n) => n.type === "n8n-nodes-base.executeWorkflow").map((n) => n.parameters.workflowInputs.value.kind);
      expect(kinds.sort()).toEqual(["ops-monitor:5", "ops-monitor:9"]);
    });
  });

  describe("異常系", () => {
    it.each(scheduled.filter((s) => s.file !== "n8n-schedule-heartbeat.json").map((s) => [s.file, s]))(
      "サーバ: %s: 取得（HTTP・ファイル）が失敗・タイムアウトしても止まらず、次のノードで ng を判定できる（onError: continueRegularOutput）",
      (_file, { wf }) => checkScheduledFetchContinues(wf),
    );

    it("サーバ: 棚卸しの取得の状態を伝えたあと、I-21 が失敗しても対応待ちの判定へ進む（alwaysOutputData）", () => {
      const wf = loadWorkflow("weekly-inquiry-inventory.json");
      const fetchState = nodeOf(wf, "取得の状態を伝える（I-21）");
      expect(fetchState.onError).toBe("continueRegularOutput");
      expect(fetchState.alwaysOutputData).toBe(true);
    });

    it.each(scheduled.map((s) => [s.file, s]))("空入力: %s: スイッチの IF は executeOnce で、ops_settings が何行でも 1 回だけ判定する", (_file, { wf }) => {
      for (const trigger of wf.nodes.filter((n) => n.type === "n8n-nodes-base.scheduleTrigger")) {
        const gate = [...reachable(wf, trigger.name)].map((n) => nodeOf(wf, n)).find((n) => n.type === "n8n-nodes-base.if");
        expect(gate.executeOnce, gate.name).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 検査そのものが違反を検出すること（約束を破るように書き換えた複製に当てる）
// ---------------------------------------------------------------------------

describe("検査が約束違反を検出する（壊した複製）", () => {
  const clone = (prefix) => structuredClone(WORKFLOWS.find(({ file }) => file.startsWith(prefix)).wf);
  const node = (wf, name) => wf.nodes.find((n) => n.name === name);

  describe("正常系", () => {
    it("壊していない複製は、すべての検査を通る（異常系の失敗は書き換えによるもの）", () => {
      for (const prefix of ["I-11", "I-12", "weekly", "ops-monitor"]) {
        const wf = clone(prefix);
        for (const check of [checkShape, checkNotActive, checkNoOrphans, checkReferencesExist, checkNoPinData, checkCredentialRefs, checkNoSecretParams, checkHttpAuth, checkCodeNodes, checkDataTableColumns]) check(wf);
        checkNoEmbeddedSecrets(JSON.stringify(wf));
      }
    });
  });

  describe("異常系", () => {
    it("空入力: ノードが 0 個のワークフローは形の検査で落ちる", () => {
      const wf = clone("I-21");
      wf.nodes = [];
      expect(() => checkShape(wf)).toThrow();
    });

    it("入力: 有効化（active: true）されたまま書き出したワークフローを検出する", () => {
      const wf = clone("I-21");
      wf.active = true;
      expect(() => checkNotActive(wf)).toThrow();
    });

    it("入力: pinData（テストの本文）を書き出したワークフローを検出する", () => {
      const wf = clone("I-12");
      wf.pinData = { "Chatwoot からの Webhook": [{ json: { body: { email: "a@example.com" } } }] };
      expect(() => checkNoPinData(wf)).toThrow();
    });

    it("入力: 取り残されたノード・存在しないノードへの $() の参照を検出する", () => {
      const orphan = clone("I-21");
      orphan.nodes.push({ id: "x", name: "取り残し", type: "n8n-nodes-base.noOp", parameters: {} });
      expect(() => checkNoOrphans(orphan)).toThrow();
      const ref = clone("I-21");
      node(ref, "メッセージを組み立てる").parameters.assignments.assignments[0].value = "={{ $('無いノード').first().json.x }}";
      expect(() => checkReferencesExist(ref)).toThrow();
    });

    it.each([
      ["AWS のアクセスキー", "AKIAABCDEFGHIJKLMNOP"],
      ["秘密鍵", "-----BEGIN PRIVATE KEY-----"],
      ["Bearer トークン", "Bearer abcdefghijklmnopqrstuv"],
      ["PostHog のキー", "phc_abcdefghijklmnopqrstuvwxyz"],
      ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"],
    ])("入力: %s を平文で埋め込んだワークフローを検出する", (_label, secret) => {
      const wf = clone("I-21");
      node(wf, "メッセージを組み立てる").notes = `メモ ${secret}`;
      expect(() => checkNoEmbeddedSecrets(JSON.stringify(wf))).toThrow();
    });

    it("入力: password・token などの名前のパラメーターに値を書いたワークフローを検出する", () => {
      const wf = clone("I-21");
      node(wf, "MailHog に送る（開発）").parameters.options.password = "p@ssw0rd";
      expect(() => checkNoSecretParams(wf)).toThrow();
    });

    it("入力: HTTP リクエストで Authorization ヘッダーを手で書く・資格情報なしで任意の URL を呼ぶワークフローを検出する", () => {
      const header = clone("weekly");
      Object.assign(node(header, "未割り当ての会話を取る").parameters, { sendHeaders: true, headerParameters: { parameters: [{ name: "api_access_token", value: "x" }] } });
      expect(() => checkHttpAuth(header)).toThrow();
      const noAuth = clone("ops-monitor");
      node(noAuth, "OpenSEO の health を取る").parameters.url = "http://host.docker.internal:3001/mcp";
      expect(() => checkHttpAuth(noAuth)).toThrow();
    });

    it("入力: 資格情報を名前以外（data など）ごと書き出した・表に無い資格情報を使うワークフローを検出する", () => {
      const withData = clone("weekly");
      node(withData, "未割り当ての会話を取る").credentials.httpHeaderAuth.data = { value: "token" };
      expect(() => checkCredentialRefs(withData)).toThrow();
      const unknown = clone("weekly");
      node(unknown, "未割り当ての会話を取る").credentials.httpHeaderAuth.name = "誰かの個人トークン";
      expect(() => checkCredentialRefs(unknown)).toThrow();
    });

    it("入力: Code ノードで環境変数・require を使うワークフローを検出する", () => {
      for (const code of ["const k = $env.N8N_ENCRYPTION_KEY; return [];", "const c = require('crypto'); return [];", "return [{ json: { k: process.env.X } }];"]) {
        const wf = clone("ops-monitor");
        node(wf, "期限が最も近い証明書の残り日数").parameters.jsCode = code;
        expect(() => checkCodeNodes(wf), code).toThrow();
      }
    });

    it("入力: Data Table に README に無い列（email）を書くワークフローを検出する", () => {
      const wf = clone("I-12");
      node(wf, "冪等キーを記録").parameters.columns.value.email = "={{ $json.email }}";
      expect(() => checkDataTableColumns(wf)).toThrow();
    });

    it("入力: 署名の検証より前に処理（Code）が動くワークフローを検出する", () => {
      const wf = clone("I-11");
      const hook = webhooksOf(wf)[0];
      // Webhook から直接 Code にもつなぐ（署名の検証を飛ばす経路）
      wf.connections[hook.name].main[0].push({ node: "イベント分割とキー生成", type: "main", index: 0 });
      expect(() => checkSignatureVerifiedThen200(wf, hook)).toThrow();
    });

    it("入力: 401 を返した後も処理が続くワークフローを検出する", () => {
      const wf = clone("I-12");
      const hook = webhooksOf(wf)[0];
      wf.connections["401 を返す（署名が不正）"] = { main: [[{ node: "イベントの整理とキー生成", type: "main", index: 0 }]] };
      expect(() => checkSignatureRejects(wf, hook)).toThrow();
    });

    it("入力: スイッチの IF の偽の出口に処理をつないだ・既定値が 'false' でないワークフローを検出する", () => {
      const spec = SCHEDULED["weekly-inquiry-inventory.json"];
      const falseBranch = clone("weekly");
      falseBranch.connections["棚卸しが有効か"].main[1] = [{ node: "未割り当ての会話を取る", type: "main", index: 0 }];
      expect(() => checkSwitchGate(falseBranch, spec)).toThrow();
      const defaultTrue = clone("weekly");
      const cond = node(defaultTrue, "棚卸しが有効か").parameters.conditions.conditions[0];
      cond.leftValue = cond.leftValue.replace("?? 'false'", "?? 'true'");
      expect(() => checkSwitchGate(defaultTrue, spec)).toThrow();
    });

    it("サーバ: サブワークフローの呼び出しで onError を外した・error 出力をつながずに continueErrorOutput にしたワークフローを検出する", () => {
      const removed = clone("I-11");
      delete node(removed, "I-21 通知を呼ぶ").onError;
      expect(() => checkSubworkflowOnError(removed)).toThrow();
      const unwired = clone("I-12");
      unwired.connections["I-19 突合を呼ぶ"].main = [unwired.connections["I-19 突合を呼ぶ"].main[0]];
      expect(() => checkSubworkflowOnError(unwired)).toThrow();
    });

    it("サーバ: 定期実行の取得で onError を外した（失敗で止まる）ワークフローを検出する", () => {
      const wf = clone("ops-monitor");
      delete node(wf, "sandbox-tls の証明書を読む").onError;
      expect(() => checkScheduledFetchContinues(wf)).toThrow();
    });
  });
});
