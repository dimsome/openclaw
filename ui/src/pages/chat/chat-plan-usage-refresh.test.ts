/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { refreshChatModelAuthStatus } from "./chat-state-refresh.ts";
import { createSessionEventState } from "./chat-state.test-support.ts";

it("refreshes the open usage popover after a terminal event without idle polling", async () => {
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const key = "agent:main:plan-usage";
  let usedPercent = 1;
  const auth = vi.fn((): ModelAuthStatusResult => ({
    ts: Date.now(),
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [{ profileId: "openai:test", type: "oauth", status: "ok" }],
        usage: { providerId: "openai", plan: "Plus", windows: [{ label: "5h", usedPercent }] },
      },
    ],
  }));
  const fixture = createMountedPanes(
    [
      {
        key,
        agentId: "main",
        kind: "direct",
        sessionId: "plan-usage",
        updatedAt: 1,
        modelProvider: "openai",
        model: "test-model",
      },
    ],
    "main",
    undefined,
    { "models.authStatus": auth },
  );
  await fixture.sessions.refresh({ agentId: "main", force: true });
  const pane = fixture.mount(key);
  document.body.append(pane.element);
  onTestFinished(() => pane.element.remove());
  await refreshPane(pane);
  await refreshChatModelAuthStatus(pane.state);
  const query = (selector: string) => pane.element.querySelector<HTMLElement>(selector);
  const expectUsage = (percent: number) =>
    waitForSolid(() =>
      expect(query(".context-usage__limit")?.textContent).toContain(`${percent}%`),
    );
  await waitForSolid(() => expect(query(".context-usage summary")).not.toBeNull());
  query(".context-usage summary")!.click();
  await expectUsage(1);
  expect(auth).toHaveBeenCalledTimes(1);
  // Cache deadlines and cross-pane sharing belong to model-auth.test.ts.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  usedPercent = 18;
  fixture.emitGatewayEvent("chat", {
    sessionKey: key,
    agentId: "main",
    runId: "usage-run",
    seq: 1,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  });
  await expectUsage(18);
  expect(pane.element.querySelector<HTMLDetailsElement>(".context-usage details")?.open).toBe(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(auth.mock.calls).toHaveLength(2);
});
it.each(["failure", "session"] as const)(
  "keeps displayed usage when a post-run read retires through %s",
  async (retirement) => {
    const response = createDeferred<ModelAuthStatusResult>();
    const current: ModelAuthStatusResult = { ts: 1, providers: [] };
    const request = vi.fn(() => response.promise);
    const { state } = createSessionEventState({
      client: createTestGatewayClient(request),
      connected: true,
      modelAuthStatusResult: current,
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const pending = refreshChatModelAuthStatus(state, "retiring-run");
    if (retirement === "failure") {
      response.reject(new Error("Usage refresh failed"));
    } else {
      state.sessionKey = "agent:main:other";
      response.resolve({ ts: 2, providers: [] });
    }
    await pending;
    expect(state.modelAuthStatusResult).toBe(current);
    expect(request).toHaveBeenCalledOnce();
  },
);
