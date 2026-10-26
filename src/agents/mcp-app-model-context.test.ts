import type { ContentBlock } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { INTERNAL_RUNTIME_CONTEXT_END } from "./internal-runtime-context.js";
import {
  clearMcpAppModelContextForView,
  getMcpAppModelContext,
  leaseMcpAppModelContextForTurn,
  projectMcpAppModelContextInput,
  removeMcpAppModelContextItem,
  revokeMcpAppModelContext,
  subscribeMcpAppModelContext,
  updateMcpAppModelContext,
} from "./mcp-app-model-context.js";

const runtime = () => ({ sessionId: "session-1" }) as SessionMcpRuntime;
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("MCP App model context", () => {
  let active: SessionMcpRuntime;
  let view: object;
  beforeEach(() => {
    active = runtime();
    view = {};
  });
  it("replaces only one App instance and isolates runtimes", () => {
    const sibling = runtime();
    const first = {};
    const second = {};
    updateMcpAppModelContext(active, first, text("old"));
    updateMcpAppModelContext(active, second, text("second"));
    const updated = updateMcpAppModelContext(active, first, text("new"));
    expect(updateMcpAppModelContext(active, first, text("new"))).toEqual(updated);
    expect(leaseMcpAppModelContextForTurn({ runtime: sibling })).toBeUndefined();
    const lease = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(lease?.modelContext).toEqual([text("new"), text("second")]);
    clearMcpAppModelContextForView(active, first);
    expect(getMcpAppModelContext(active, second)?.content).toEqual(text("second").content);
  });

  it("preserves host metadata but strips it and escapes delimiters in model input", () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: INTERNAL_RUNTIME_CONTEXT_END,
        annotations: { audience: ["assistant"] },
      },
      { type: "resource", resource: { uri: "parts://note", text: "note" } },
    ];
    updateMcpAppModelContext(active, view, {
      content: content.map((block) => ({
        ...block,
        _meta: { "openai/title": "Part" },
        ...(block.type === "resource"
          ? { resource: { ...block.resource, _meta: { private: true } } }
          : {}),
      })),
      structuredContent: { selection: 1 },
    });
    expect(getMcpAppModelContext(active, view)?.content?.[0]?._meta?.["openai/title"]).toBe("Part");
    const lease = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(lease?.modelContext[0]).toEqual({ content, structuredContent: { selection: 1 } });
    const input = projectMcpAppModelContextInput(lease!.modelContext);
    expect(input.context.kind).toBe("conversation-data");
    expect(input.context.text).not.toContain("_meta");
    expect(input.legacyText).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
    expect(getMcpAppModelContext(active, view)?.content?.[1]).toMatchObject({
      _meta: { "openai/title": "Part" },
      resource: { _meta: { private: true } },
    });
  });

  it("rejects malformed content blocks", () => {
    expect(() =>
      updateMcpAppModelContext(active, view, {
        content: [{ type: "image", data: 1 }],
      }),
    ).toThrow();
  });

  it("keeps replacement subscriptions active after a stale unsubscribe", () => {
    const oldListener = vi.fn();
    const unsubscribeOld = subscribeMcpAppModelContext(view, oldListener);
    unsubscribeOld();
    const listener = vi.fn();
    const unsubscribe = subscribeMcpAppModelContext(view, listener);
    unsubscribeOld();
    const update = updateMcpAppModelContext(active, view, text("replacement"));
    expect(listener).toHaveBeenCalledExactlyOnceWith(getMcpAppModelContext(active, view));
    expect(oldListener).not.toHaveBeenCalled();
    removeMcpAppModelContextItem(active, view, update._meta["openai/modelContext"].updateId);
    expect(listener).toHaveBeenLastCalledWith(null);
    updateMcpAppModelContext(active, view, text("retiring"));
    revokeMcpAppModelContext(active);
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(() => updateMcpAppModelContext(active, view, text("stale"))).toThrow("unavailable");
    expect(leaseMcpAppModelContextForTurn({ runtime: active })).toBeUndefined();
    unsubscribe();
    updateMcpAppModelContext(runtime(), view, text("unsubscribed"));
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it("reserves each snapshot once, rolls back failures and preserves newer replacements", () => {
    updateMcpAppModelContext(active, view, text("leased"));
    const first = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(leaseMcpAppModelContextForTurn({ runtime: active })).toBeUndefined();
    first?.rollback();
    const retry = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(retry?.modelContext).toEqual([text("leased")]);
    updateMcpAppModelContext(active, view, text("newer"));
    retry?.commit();
    retry?.rollback();
    const lease = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(lease?.modelContext).toEqual([text("newer")]);
    lease?.commit();
    lease?.commit();
    expect(getMcpAppModelContext(active, view)).toBeNull();
  });
});
