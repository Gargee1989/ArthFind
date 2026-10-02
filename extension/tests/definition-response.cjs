const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../definition-response.js");

function streamResponse(text, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("handles split UTF-8 and CRLF events and keeps final answer", async () => {
  const result = { status: "success", meaning: 'A café beside the "river".', tone: "", synonym: "riverside", example: "", simplified_passage: "" };
  const seen = [];
  const response = streamResponse(`: keep-alive\r\n\r\nevent: meaning\r\ndata: ${JSON.stringify({ meaning: result.meaning })}\r\n\r\nevent: result\r\ndata: ${JSON.stringify(result)}\r\n\r\n`);
  assert.deepEqual(await ContentCoreDefinition.read(response, text => seen.push(text)), result);
  assert.deepEqual(seen, [result.meaning]);
});

test("delivers meaning while the remaining response is still pending", async () => {
  let controller;
  const response = new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "content-type": "text/event-stream" } });
  let preview;
  const shown = new Promise(resolve => { preview = resolve; });
  let finished = false;
  const answer = ContentCoreDefinition.read(response, preview).then(value => { finished = true; return value; });
  controller.enqueue(new TextEncoder().encode('event: meaning\ndata: {"meaning":"Early meaning"}\n\n'));
  assert.equal(await shown, "Early meaning");
  assert.equal(finished, false);
  controller.enqueue(new TextEncoder().encode('event: result\ndata: {"meaning":"Final meaning"}\n\n'));
  controller.close();
  assert.equal((await answer).meaning, "Final meaning");
});

test("does not treat a truncated preview as a successful response", async () => {
  await assert.rejects(ContentCoreDefinition.read(streamResponse('event: meaning\ndata: {"meaning":"Preview"}\n\n')), /interrupted/);
});

test("propagates provider errors after a preview", async () => {
  await assert.rejects(ContentCoreDefinition.read(streamResponse('event: meaning\ndata: {"meaning":"Preview"}\n\nevent: error\ndata: {"message":"Rate limit exceeded"}\n\n')), /Rate limit/);
});

test("supports older JSON backends", async () => {
  const response = new Response('{"meaning":"Normal answer"}', { headers: { "content-type": "application/json" } });
  assert.deepEqual(await ContentCoreDefinition.read(response), { meaning: "Normal answer" });
});
