import { beforeEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

const sessionFixture = vi.hoisted(() => ({ updatedAt: 50 }));

// mock-isolation: Session owners are synthetic; the fixture must not load operator configuration.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({ agents: { entries: { main: {}, delivery: {} } } }),
}));

beforeEach(() => {
  resetAgentEventsForTest();
  sessionFixture.updatedAt = 50;
});

async function withReceiver(
  runId: string,
  context: Parameters<typeof registerAgentRunContext>[1],
  toolCallId = "finished",
) {
  const broadcast = vi.fn();
  const broadcastToConnIds = vi.fn();
  const nodeSendToSession = vi.fn();
  const chatRunState = createChatRunState();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
  sessionMessageSubscribers.subscribe("selected", "agent:delivery:late");
  const entry = {
    sessionId: "session",
    verboseLevel: "off" as const,
    updatedAt: sessionFixture.updatedAt,
  };
  const projection = createSessionRowProjectionFixture({
    cfg: getRuntimeConfig(),
    agentId: "delivery",
    store: { global: entry, "agent:delivery:late": entry },
  });
  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds,
    nodeHasSessionSubscribers: () => true,
    nodeSendToSession,
    chatRunState,
    agentRunSeq: new Map(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionMessageSubscribers,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    clearAgentRunContext,
    resolveSessionKeyForRun: () => {
      throw new Error("Event lost its producer route");
    },
    loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
    persistGatewaySessionLifecycleEventForEvent: async () => {},
    getSessionRowProjection: () => projection,
  });
  const unsubscribe = subscribeAgentEvents(handler);
  try {
    withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => {
      registerAgentRunContext(runId, {
        agentId: "delivery",
        verboseLevel: "full",
        registeredAt: 100,
        ...context,
      });
      clearAgentRunContext(runId);
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "result", name: "read", toolCallId, result: { value: "retained" } },
      });
    });
  } finally {
    try {
      await unsubscribe();
    } finally {
      await handler.dispose();
      projection.dispose();
    }
  }
  return { broadcast, broadcastToConnIds, nodeSendToSession };
}

it("preserves tool results for hidden session subscribers after cleanup", async () => {
  const receiver = await withReceiver("late", {
    sessionKey: "agent:delivery:late",
    sessionId: "session",
    isControlUiVisible: false,
    projectSessionMessages: true,
  });
  const delivered = receiver.broadcastToConnIds.mock.calls.filter(([name]) => name === "agent");
  expect(delivered).toHaveLength(1);
  expect(receiver.broadcast).not.toHaveBeenCalled();
});

it("preserves run verbosity until a newer session preference replaces it", async () => {
  const receiver = await withReceiver("verbose", {
    sessionKey: "agent:delivery:late",
    sessionId: "session",
  });
  const delivered = receiver.nodeSendToSession.mock.calls.filter(([, name]) => name === "agent");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.[2]).toMatchObject({ data: { result: { value: "retained" } } });
});

it("uses the selected agent for newer global-session verbosity", async () => {
  sessionFixture.updatedAt = 200;
  const receiver = await withReceiver("global-run", { sessionKey: "global" }, "late");
  expect(receiver.nodeSendToSession.mock.calls.filter(([, name]) => name === "agent")).toEqual([]);
});
