/** @vitest-environment node */
import { getEventListeners } from "node:events";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";

type MockSocketEvent = { code?: number; data?: unknown; reason?: string };

const sockets: MockWebSocket[] = [];
const eventTypes = ["open", "message", "close", "error"] as const;

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly close = vi.fn((code?: number, _reason?: string) => {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
  });
  readyState = 0;

  constructor(_url: string) {
    super();
    sockets.push(this);
  }

  send(_data: string) {}

  emit(type: string, event: MockSocketEvent = {}) {
    this.dispatchEvent(Object.assign(new Event(type), event));
  }
}

describe("createBrowserGatewaySocket", () => {
  let socket: MockWebSocket;
  const handlers = { open: vi.fn(), message: vi.fn(), close: vi.fn(), error: vi.fn() };
  let socketAdapter: ReturnType<typeof createBrowserGatewaySocket>;
  const timeoutReason = `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`;
  const expectRetiredListeners = () =>
    expect(eventTypes.flatMap((type) => getEventListeners(socket, type))).toEqual([]);
  function emitLateEvents() {
    socket.emit("close", { code: 1006, reason: "late close" });
    socket.emit("message", { data: "late message" });
    socket.emit("error");
    socket.emit("open");
    expect(handlers.close).toHaveBeenCalledOnce();
    expect(handlers.open).not.toHaveBeenCalled();
    expect(handlers.message).not.toHaveBeenCalled();
  }
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    Object.values(handlers).forEach((handler) => handler.mockReset());
    socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);
    const created = sockets[0];
    if (!created) {
      throw new Error("expected a websocket instance");
    }
    socket = created;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a websocket that never finishes opening", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledExactlyOnceWith(new Error(timeoutReason));
    expect(socket.close).toHaveBeenCalledOnce();
    expect(handlers.close).toHaveBeenCalledExactlyOnceWith(1006, timeoutReason);

    emitLateEvents();
    expect(handlers.error).toHaveBeenCalledOnce();
  });

  it("preserves a remote native close code and reason", async () => {
    handlers.close.mockImplementation(expectRetiredListeners);
    socket.emit("close", { code: 1006, reason: "gateway supplied a close reason" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.close).toHaveBeenCalledExactlyOnceWith(1006, "gateway supplied a close reason");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it.each(["open", "error"])("clears the opening deadline after %s", async (cause) => {
    if (cause === "open") {
      socket.readyState = MockWebSocket.OPEN;
      socket.emit("open");
    } else {
      socket.emit("error");
      socket.emit("close", { code: 1006, reason: "" });
    }
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    expect(handlers.error.mock.calls).toEqual(
      cause === "error" ? [[new Error("websocket error")]] : [],
    );
    if (cause === "error") {
      expect(handlers.close).toHaveBeenCalledWith(1006, "");
    }
    expect(socket.close).not.toHaveBeenCalled();
    if (cause === "open") {
      expect(handlers.open).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { code: 1000, nativeCode: 1000, reason: "stopped" },
    { code: 4000, nativeCode: 4000, reason: "reconnect" },
    { code: 1008, nativeCode: 4008, reason: "connect failed" },
    { code: undefined, nativeCode: undefined, reason: undefined },
  ])(
    "retires a local close immediately and exactly once ($code)",
    async ({ code, nativeCode, reason }) => {
      if (code !== 1000) {
        socket.readyState = MockWebSocket.OPEN;
        socket.emit("open");
        handlers.open.mockClear();
      }
      handlers.close.mockImplementation(() => {
        expectRetiredListeners();
        // A terminal callback may synchronously ask to close the abandoned adapter again.
        socketAdapter.close(4000, "again");
      });

      socketAdapter.close(code, reason);

      expect(socket.close).toHaveBeenCalledExactlyOnceWith(nativeCode, reason);
      expect(handlers.close).toHaveBeenCalledExactlyOnceWith(code ?? 1000, reason ?? "");
      expect(socketAdapter.isOpen()).toBe(false);

      await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
      emitLateEvents();
      expect(handlers.error).not.toHaveBeenCalled();
    },
  );
});
