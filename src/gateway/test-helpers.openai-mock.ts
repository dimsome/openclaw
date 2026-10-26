function extractLastUserText(input: unknown[]): string {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as Record<string, unknown> | undefined;
    if (!item || item.role !== "user") {
      continue;
    }
    const content = item.content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (c): c is { type: "input_text"; text: string } =>
            Boolean(c) &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "input_text" &&
            typeof (c as { text?: unknown }).text === "string",
        )
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function buildOpenAIResponsesSse(input: unknown[]): Response {
  const output = input.find(
    (entry) => (entry as Record<string, unknown> | undefined)?.type === "function_call_output",
  ) as Record<string, unknown> | undefined;
  const toolOutput = typeof output?.output === "string" ? output.output : "";
  const respond = (added: object, done: object, deltas: object[] = []) =>
    buildSseResponse([
      { type: "response.output_item.added", item: added },
      ...deltas,
      { type: "response.output_item.done", item: done },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      },
    ]);

  if (!toolOutput) {
    const argsJson = JSON.stringify({
      path: /"([^"]+)"/.exec(extractLastUserText(input))?.[1] ?? "package.json",
    });
    const item = {
      type: "function_call",
      id: "fc_test_1",
      call_id: "call_test_1",
      name: "read",
    };

    return respond({ ...item, arguments: "" }, { ...item, arguments: argsJson }, [
      { type: "response.function_call_arguments.delta", delta: argsJson },
    ]);
  }

  const nonceA = /nonceA=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  const nonceB = /nonceB=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  const reply = `${nonceA} ${nonceB}`.trim();
  const item = { type: "message", id: "msg_test_1", role: "assistant" };

  return respond(
    { ...item, content: [], status: "in_progress" },
    {
      ...item,
      status: "completed",
      content: [{ type: "output_text", text: reply, annotations: [] }],
    },
  );
}

function decodeBodyText(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(body)).toString("utf8");
  }
  return "";
}

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(sse, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function installOpenAiResponsesMock(params?: { baseUrl?: string }) {
  const originalFetch = globalThis.fetch;
  const baseUrl = params?.baseUrl ?? "https://api.openai.com/v1";
  const responsesUrl = `${baseUrl}/responses`;
  const isResponsesRequest = (url: string) =>
    url === responsesUrl ||
    url.startsWith(`${responsesUrl}/`) ||
    url.startsWith(`${responsesUrl}?`);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (isResponsesRequest(url)) {
      const bodyText =
        init?.body !== undefined
          ? decodeBodyText(init.body)
          : input instanceof Request
            ? await input.clone().text()
            : "";

      const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      const inputItems = Array.isArray(parsed.input) ? parsed.input : [];
      return buildOpenAIResponsesSse(inputItems);
    }
    if (url.startsWith(baseUrl)) {
      throw new Error(`unexpected OpenAI request in mock test: ${url}`);
    }

    if (!originalFetch) {
      throw new Error(`fetch is not available (url=${url})`);
    }
    return await originalFetch(input, init);
  };
  (globalThis as unknown as { fetch: unknown }).fetch = fetchImpl;
  return {
    baseUrl,
    restore: () => {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    },
  };
}
