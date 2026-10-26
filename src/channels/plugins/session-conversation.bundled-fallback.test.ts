import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ChannelMessagingAdapter } from "./types.core.js";

type ResolveSessionConversation = NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
>;
const sessionKey = "agent:main:mock-threaded:group:room:topic:42";

const fallbackState = vi.hoisted(() => ({
  activeDirName: null as string | null,
  loadCalls: 0,
  resolveSessionConversation: null as ResolveSessionConversation | null,
}));

vi.mock("../../plugin-sdk/facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugin-sdk/facade-runtime.js")>(
    "../../plugin-sdk/facade-runtime.js",
  );
  return {
    ...actual,
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync: ({ dirName }: { dirName: string }) => {
      fallbackState.loadCalls += 1;
      return dirName === fallbackState.activeDirName && fallbackState.resolveSessionConversation
        ? { resolveSessionConversation: fallbackState.resolveSessionConversation }
        : null;
    },
  };
});

import { resolveSessionConversationRef } from "./session-conversation.js";

function enableBundledFallback(
  dirName: string,
  resolveSessionConversation: ResolveSessionConversation,
) {
  fallbackState.activeDirName = dirName;
  fallbackState.resolveSessionConversation = resolveSessionConversation;
  setRuntimeConfigSnapshot({ plugins: { entries: { [dirName]: { enabled: true } } } });
}

function conversationRef(
  rawId: string,
  id: string,
  threadId: string | undefined,
  parents: string[],
  channel = "mock-threaded",
) {
  return {
    channel,
    kind: "group",
    rawId,
    id,
    threadId,
    baseSessionKey: `agent:main:${channel}:group:${id}`,
    baseConversationId: parents.at(-1) ?? id,
    parentConversationCandidates: parents,
  };
}

function enableThreadedFallback() {
  enableBundledFallback("mock-threaded", ({ rawId }) => {
    const [rawConversationId, threadId] = rawId.split(":topic:");
    const conversationId = expectDefined(rawConversationId, "conversation id");
    return {
      id: conversationId,
      threadId,
      baseConversationId: conversationId,
      parentConversationCandidates: [conversationId],
    };
  });
}

beforeEach(() => {
  fallbackState.activeDirName = null;
  fallbackState.loadCalls = 0;
  fallbackState.resolveSessionConversation = null;
  resetPluginRuntimeStateForTest();
});

afterEach(clearRuntimeConfigSnapshot);

it("delegates pre-bootstrap thread parsing on repeated calls to the public-surface loader", () => {
  enableThreadedFallback();

  expect(resolveSessionConversationRef(sessionKey)).toEqual(
    conversationRef("room:topic:42", "room", "42", ["room"]),
  );
  expect(resolveSessionConversationRef("agent:main:mock-threaded:group:room:topic:43")).toEqual(
    conversationRef("room:topic:43", "room", "43", ["room"]),
  );
  expect(fallbackState.loadCalls).toBe(2);
});

it("keeps a loaded plugin without messaging on generic thread grammar", () => {
  enableThreadedFallback();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "mock-threaded",
        source: "test",
        plugin: createChannelTestPluginBase({ id: "mock-threaded" }),
      },
    ]),
  );

  expect(resolveSessionConversationRef(`${sessionKey}:thread:leaf`)).toEqual(
    conversationRef("room:topic:42:thread:leaf", "room:topic:42", "leaf", ["room:topic:42"]),
  );
  expect(fallbackState.loadCalls).toBe(0);
});

it("can skip bundled fallback probing for hot generic-only callers", () => {
  enableThreadedFallback();

  expect(resolveSessionConversationRef(sessionKey, { bundledFallback: false })).toEqual(
    conversationRef("room:topic:42", "room:topic:42", undefined, []),
  );
});

it("uses explicit bundled parent candidates before registry bootstrap", () => {
  const inputId = "room:topic:root:sender:user";
  enableBundledFallback("mock-parent", ({ rawId }) => ({
    id: rawId,
    baseConversationId: "room",
    parentConversationCandidates: ["room:topic:root", "room"],
  }));

  expect(resolveSessionConversationRef(`agent:main:mock-parent:group:${inputId}`)).toEqual(
    conversationRef(inputId, inputId, undefined, ["room:topic:root", "room"], "mock-parent"),
  );
});
