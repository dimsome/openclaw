import { createRouter } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { RouteId } from "../app-routes.ts";
import { CHAT_ROUTE_READY_EVENT } from "../pages/chat/chat-history-events.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { navigateWithRouteTransition } from "./route-transition.ts";

const location = (pathname: string, search = "") => ({ pathname, search, hash: "" });
const chatReady = () => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
function testDocumentWithOutlet(
  animate = vi.fn(() => ({ finished: Promise.resolve() }) as Animation),
) {
  const router = createRouter<RouteId>({
    routes: [
      { id: "chat", path: "/chat", component: () => ({}) },
      { id: "about", path: "/about", component: () => ({}) },
    ],
  });
  void router.navigate("chat", undefined);
  const outlet = Object.assign(document.createElement("openclaw-router-outlet"), {
    presentationSettled: true,
    settlePresentation: async () => true,
  }) satisfies ControlUiReadinessOutlet;
  outlet.animate = animate;
  document.body.append(outlet);
  const navigate = vi.fn(async () => {});
  return {
    animate,
    navigate,
    router,
    document,
    getOutlet: () => outlet,
    from: "new-session" as const,
    to: "chat" as const,
    prefersReducedMotion: false,
  };
}
afterEach(() => document.body.replaceChildren());

it.each([false, true])(
  "waits for Chat without freezing navigation (reduced motion: %s)",
  async (prefersReducedMotion) => {
    const test = testDocumentWithOutlet();
    const navigation = createDeferredCore();
    test.navigate.mockReturnValue(navigation.promise);
    const transition = navigateWithRouteTransition({ ...test, prefersReducedMotion });
    expect(test.navigate).toHaveBeenCalledOnce();
    expect(test.animate).not.toHaveBeenCalled();
    navigation.resolve();
    chatReady();
    await transition;
    expect(test.navigate).toHaveBeenCalledOnce();
    expect(test.animate).toHaveBeenCalledTimes(prefersReducedMotion ? 0 : 1);
  },
);

it("propagates navigation failure without animating", async () => {
  const test = testDocumentWithOutlet();
  const failure = new Error("Chat route failed to load");
  test.navigate.mockRejectedValue(failure);
  await expect(navigateWithRouteTransition(test)).rejects.toBe(failure);
  expect(test.animate).not.toHaveBeenCalled();
});

it.each([
  { from: "about", to: "chat" },
  { from: "new-session", to: "about" },
] as const)("navigates directly for $from to $to", async (options) => {
  const test = testDocumentWithOutlet();
  await navigateWithRouteTransition({ ...test, ...options });
  expect(test.navigate).toHaveBeenCalledOnce();
  expect(test.animate).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps focus cleanup but retires replaced Chat (animating: %s)",
  async (animating) => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel }) as Animation);
    const test = testDocumentWithOutlet(animate);
    const visit = (path: string, search = "", history: "push" | "replace" = "push") =>
      test.router.navigate("chat", undefined, { history }, location(path, search));
    const navigation = visit("/chat/main/first", "?focusComposer=1");
    const transition = navigateWithRouteTransition({ ...test, navigate: () => navigation });
    await navigation;
    let settled = false;
    void transition.then(() => {
      settled = true;
    });
    await visit("/chat/main/first", "", "replace");
    expect(settled).toBe(false);
    if (animating) {
      chatReady();
      await vi.waitFor(() => expect(animate).toHaveBeenCalledOnce());
      await test.router.navigate("about", undefined);
    } else {
      await visit("/chat/main/second");
      expect(animate).not.toHaveBeenCalled();
    }
    await transition;
    expect(cancel).toHaveBeenCalledTimes(animating ? 1 : 0);
    chatReady();
    expect(animate).toHaveBeenCalledTimes(animating ? 1 : 0);
  },
);
