import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as lifetime from "../session-utils-read-lifetime.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import {
  prepareSubscriptionFixture,
  proveSubscriptionDoesNotWaitForDisplayRows,
} from "./sessions.messages-subscribe-wait.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("subscribes during an active turn among 8,000 sessions", ({ signal }) =>
  proveSubscriptionDoesNotWaitForDisplayRows(8_000, signal));

it("measures subscription dispatch with a 160k-token transcript", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { cfg, client, subscribers, runtime } = await prepareSubscriptionFixture(state, "perf");
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subscribe-perf",
      sessionId: "subscribe-perf",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared",
    });
    const context = await createHistoryReadContext({
      getRuntimeConfig: () => cfg,
      subscribeSessionMessageEvents: subscribers.subscribe,
      listSessionPendingApprovals: runtime.replay,
    });
    const projection = getSessionRowProjection(context)!;
    let currencyReads = 0;
    const retain = lifetime.retainGatewaySessionEntryReadOnly;
    vi.spyOn(lifetime, "retainGatewaySessionEntryReadOnly").mockImplementation(async (...args) => {
      const read = await retain(...args);
      const assert = read.isCurrentAtResponse;
      return {
        ...read,
        isCurrentAtResponse: () => {
          currencyReads++;
          return assert();
        },
      };
    });
    try {
      for (const events of [0, 2000]) {
        if (events) {
          await persistSessionTranscriptTurn(scope, {
            messages: Array.from({ length: events }, (_, index) => ({
              eventId: `message-${index}`,
              message: {
                role: "user",
                content: [{ type: "text", text: "word ".repeat(80) }],
                timestamp: index + 1,
              },
            })),
            updateMode: "none",
          });
          await projection.ensureMaterialized();
        }
        for (const includeApprovals of [false, true]) {
          const samples: number[] = [];
          currencyReads = 0;
          for (let index = 0; index < 50; index++) {
            const respond = vi.fn();
            const start = performance.now();
            await handleGatewayRequest({
              req: gatewayRequest(`${index}`, "sessions.messages.subscribe", {
                key: scope.sessionKey,
                ...(includeApprovals ? { includeApprovals: true } : {}),
              }),
              client,
              context,
              respond,
              isWebchatConnect: () => false,
              extraHandlers: sessionSubscriptionHandlers,
            });
            samples.push(performance.now() - start);
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              expect.objectContaining({ subscribed: true, key: scope.sessionKey, agentId: "main" }),
              undefined,
            );
          }
          samples.sort((a, b) => a - b);
          console.log(
            JSON.stringify({
              events,
              includeApprovals,
              estimatedTokens: events * 80,
              samples: samples.length,
              meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
              p50Ms: samples[25],
              p99Ms: samples[49],
              currencyReadsPerSubscribe: currencyReads / samples.length,
            }),
          );
          // Capture validates once; recheck only after replay and before committing the observer.
          expect(currencyReads).toBeLessThanOrEqual(samples.length * (includeApprovals ? 3 : 2));
        }
      }
    } finally {
      await disposeSessionReadContexts();
    }
  });
});
