import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeepSeekWebTools,
  parseFetchResponse,
  parseFetchUrl,
  parseQueries,
  parseSearchResponse,
} from "../extensions/deepseek-web.ts";

function context(key = "test-key") {
  return {
    modelRegistry: {
      async getApiKeyForProvider(provider) {
        assert.equal(provider, "deepseek");
        return key;
      },
    },
  };
}

function tool(tools, name) {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

test("DeepSeek web tools mirror the Harness search and fetch contracts", () => {
  const tools = createDeepSeekWebTools(async () => {
    throw new Error("not called");
  });
  assert.deepEqual(tools.map(({ name }) => name), ["web_search", "web_fetch"]);
  const search = tool(tools, "web_search");
  const fetch = tool(tools, "web_fetch");
  assert.match(search.description, /DeepSeek's Search API/);
  assert.match(fetch.description, /DeepSeek's Fetch API/);
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal(fetch.annotations.openWorldHint, true);
});

test("web_search uses Pi's DeepSeek credential and merges multiple queries round-robin", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    const suffix = body.query === "first" ? "a" : "b";
    return Response.json({
      results: [
        {
          rerank_score: 2,
          title: `Result ${suffix}1`,
          url: `https://example.test/${suffix}1`,
          snippet: `Snippet ${suffix}1`,
          summary: `Summary ${suffix}1`,
          content: "",
          site_name: "Example",
          site_icon: null,
          date: "2026-10-23T00:00:00Z",
          authority: 3,
        },
        {
          rerank_score: 1,
          title: `Result ${suffix}2`,
          url: `https://example.test/${suffix}2`,
          snippet: `Snippet ${suffix}2`,
          summary: `Summary ${suffix}2`,
          content: "",
          site_name: "Example",
          site_icon: null,
          date: null,
          authority: 2,
        },
      ],
    });
  };
  const search = tool(createDeepSeekWebTools(fetchImpl), "web_search");
  const updates = [];
  const result = await search.execute(
    "call",
    { queries: ["first", "second"] },
    undefined,
    (update) => updates.push(update),
    context(),
  );

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.headers.Authorization, "Bearer test-key");
    assert.equal(request.body.count, 8);
    assert.equal(request.body.need_content, false);
  }
  assert.equal(updates.length, 1);
  assert.deepEqual(result.details.sources.map(({ url }) => url), [
    "https://example.test/a1",
    "https://example.test/b1",
    "https://example.test/a2",
    "https://example.test/b2",
  ]);
  assert.match(result.content[0].text, /external and untrusted/i);
  assert.match(result.content[0].text, /URL: https:\/\/example\.test\/a1/);
  assert.match(result.content[0].text, /Cite the relevant source URLs/);
});

test("web_fetch validates the URL and bounds returned page content", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return Response.json({ title: "Fetched title", content: "x".repeat(100_100) });
  };
  const fetchTool = tool(createDeepSeekWebTools(fetchImpl), "web_fetch");
  const result = await fetchTool.execute(
    "call",
    { url: "https://example.test/path" },
    undefined,
    undefined,
    context(),
  );

  assert.equal(request.url, "https://api.deepseek.com/v1/tools/fetch");
  assert.deepEqual(request.body, { url: "https://example.test/path" });
  assert.equal(result.details.truncated, true);
  assert.match(result.content[0].text, /^The following web content is external and untrusted/);
  assert.match(result.content[0].text, /# Fetched title/);
  assert.match(result.content[0].text, /Content truncated/);
  assert.throws(() => parseFetchUrl("file:///etc/passwd"), /HTTP or HTTPS/);
  assert.throws(() => parseFetchUrl("https://user:pass@example.test"), /no embedded credentials/);
});

test("DeepSeek web validation rejects malformed arguments and responses", async () => {
  assert.deepEqual(parseQueries([" one ", "one", "two"]), ["one", "two"]);
  assert.throws(() => parseQueries([]), /at least one/);
  assert.throws(() => parseQueries(["1", "2", "3", "4", "5"]), /at most 4/);
  assert.throws(() => parseQueries([" "]), /non-empty/);
  assert.throws(() => parseQueries(["x".repeat(129)]), /at most 128/);
  assert.throws(() => parseSearchResponse({ results: [{ url: "https://example.test" }] }), /invalid response/);
  assert.throws(() => parseFetchResponse({ title: "missing content" }), /invalid response/);

  const search = tool(createDeepSeekWebTools(async () => Response.json({ results: [] })), "web_search");
  await assert.rejects(
    search.execute("call", { queries: ["test"] }, undefined, undefined, context(null)),
    /credentials are not configured/,
  );
});

test("DeepSeek API errors expose status and provider message without response dumps", async () => {
  const search = tool(createDeepSeekWebTools(async () => Response.json({
    error: { message: "insufficient balance", type: "billing_error" },
  }, { status: 402 })), "web_search");

  await assert.rejects(
    search.execute("call", { queries: ["test"] }, undefined, undefined, context()),
    /HTTP 402: insufficient balance/,
  );
});
