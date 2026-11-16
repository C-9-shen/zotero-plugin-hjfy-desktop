// Development-only loopback fixture. No upstream requests or real credentials.
import http from "node:http";
import process from "node:process";

let calls = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === "/stats") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ calls }));
    return;
  }
  if (
    request.method !== "POST" ||
    request.url !== "/v1/chat/completions" ||
    request.headers.authorization !== "Bearer hjfy-local-fixture"
  ) {
    response.writeHead(400).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  if (body.model !== "mock-latex") {
    response.writeHead(400).end();
    return;
  }
  const batch = JSON.parse(body.messages[1].content);
  const translated = JSON.stringify({
    segments: batch.segments.map(({ id, text }) => ({
      id,
      text: text
        .split(/(\[\[HJFY_\d+\]\])/)
        .map((part) =>
          part.startsWith("[[HJFY_")
            ? part
            : part.replace(/[a-zA-Z][a-zA-Z ,.!?:;'-]*/g, "中文测试"),
        )
        .join(""),
    })),
  });
  calls++;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: translated } }],
    }),
  );
});
server.listen(
  Number(process.env.HJFY_MOCK_PORT || "19086"),
  "127.0.0.1",
  () => {
    process.stdout.write(
      `Mock LaTeX API listening on ${server.address().port}\n`,
    );
  },
);
