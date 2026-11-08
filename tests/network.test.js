import test from "node:test";
import assert from "node:assert/strict";
import handler, { fetchJson, searchWeb, searchQuery } from "../api/index.js";

function setup(t, fetch) {
  const logs = [];
  t.mock.method(globalThis, "fetch", fetch);
  t.mock.method(console, "warn", line => logs.push(JSON.parse(line)));
  const old = { ...process.env };
  process.env.SERPER_API_KEY = "test-serper-secret";
  process.env.GEMINI_API_KEY = "test-gemini-secret";
  t.after(() => { process.env = old; });
  return logs;
}

async function post(command, history = []) {
  let result;
  await handler({ method: "POST", body: { request: { command }, state: { session: { history } } } }, {
    status(code) { assert.equal(code, 200); return this; },
    json(value) { result = value; }
  });
  assert.equal(result.version, "1.0");
  assert.equal(result.response.end_session, false);
  return result;
}

const answer = () => Response.json({ candidates: [{ content: { parts: [{ text: "Ответ по найденному источнику." }] } }] });

test("search slower than old 600ms deadline reaches Gemini and preserves history", async t => {
  const requests = [];
  const logs = setup(t, async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.includes("serper")) {
      await new Promise(resolve => setTimeout(resolve, 750));
      return Response.json({ organic: [null, { title: "Источник", snippet: "Проверенные события", link: "https://example.org" }] });
    }
    return answer();
  });
  const result = await post("Найди новости сегодня");
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.contents.at(-1).parts[0].text, /Проверенные события/);
  assert.equal(result.session_state.history.length, 2);
  assert.equal(logs[0].event, "success");
});

test("DNS failure is distinct from timeout and secrets never reach logs", async t => {
  const logs = setup(t, async () => { throw new TypeError("test-serper-secret", { cause: { code: "ENOTFOUND" } }); });
  const result = await post("Новости сегодня");
  assert.match(result.response.text, /Не удалось получить актуальные/);
  assert.deepEqual(logs.map(x => [x.event, x.code]), [["network_error", "ENOTFOUND"]]);
  assert.doesNotMatch(JSON.stringify(logs), /test-serper-secret/);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

for (const status of [401, 403, 429, 500]) {
  test(`Serper HTTP ${status} returns honest fallback without calling Gemini`, async t => {
    const logs = setup(t, async () => new Response("test-serper-secret", { status }));
    const result = await post("Найди новости");
    assert.match(result.response.text, /Не удалось получить актуальные/);
    assert.equal(logs[0].event, "http_error");
    assert.equal(logs[0].status, status);
    assert.equal(globalThis.fetch.mock.callCount(), 1);
    assert.doesNotMatch(JSON.stringify(logs), /test-serper-secret/);
  });
}

test("malformed JSON is logged accurately", async t => {
  const logs = setup(t, async () => new Response("invalid-json-test-secret"));
  assert.equal(await searchWeb("query", 1000), "");
  assert.equal(logs[0].event, "invalid_json");
  assert.doesNotMatch(JSON.stringify(logs), /invalid-json-test-secret/);
});

test("empty search results do not cause an ungrounded current-events answer", async t => {
  const logs = setup(t, async () => Response.json({ organic: [] }));
  const result = await post("Новости сегодня");
  assert.match(result.response.text, /Не удалось/);
  assert.equal(logs[0].event, "empty_results");
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test("deadline covers stalled response bodies even when abort is ignored", async t => {
  let signal;
  setup(t, async (_, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; });
  const start = performance.now();
  await assert.rejects(fetchJson("https://example.org", {}, 40), { code: "REQUEST_TIMEOUT" });
  assert.ok(performance.now() - start < 500);
  assert.equal(signal.aborted, true);
});

test("slow search plus hung Gemini stays within handler budget", async t => {
  const logs = setup(t, async url => {
    if (url.includes("serper")) {
      await new Promise(resolve => setTimeout(resolve, 1250));
      return Response.json({ answerBox: { answer: "Найденный факт" } });
    }
    return new Promise(() => {});
  });
  const start = performance.now();
  const result = await post("Новости сегодня");
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 3500 && elapsed < 4000, `elapsed=${elapsed}`);
  assert.match(result.response.text, /Не успела/);
  assert.ok(logs.some(x => x.provider === "gemini" && x.event === "timeout"));
});

test("ordinary request skips search and keeps dialogue history", async t => {
  setup(t, async () => answer());
  const result = await post("Расскажи сказку", [{ role: "user", text: "Привет" }, { role: "model", text: "Привет!" }]);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  assert.equal(result.session_state.history.length, 4);
});

test("short follow-up search retains previous subject", () => {
  assert.match(searchQuery("А что сегодня?", [{ role: "user", text: "Заседание Конгресса" }]), /Заседание Конгресса А что сегодня/);
});
