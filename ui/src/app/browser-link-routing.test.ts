/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";

function appendLink(href: string, attributes: Record<string, string> = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }
  document.body.append(anchor);
  return anchor;
}

function startBrowserLinkRouting(available = true) {
  const routing = startNativeLinkRouting({
    shouldOpenInControlUiBrowser: () => available,
  });
  onTestFinished(() => routing.dispose());
  const requests: unknown[] = [];
  const listener = (event: Event) => {
    requests.push((event as CustomEvent).detail);
  };
  window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
  onTestFinished(() => window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener));
  return requests;
}

function dispatchLink(href: string, init: MouseEventInit = {}, attributes = {}, middle = false) {
  const event = new MouseEvent(middle ? "auxclick" : "click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: middle ? 1 : 0,
    ...init,
  });
  appendLink(href, attributes).dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "webkit");
  vi.unstubAllGlobals();
});

it("preserves existing browser behavior by default", () => {
  startBrowserLinkRouting(false);
  expect(dispatchLink("https://example.com/report").defaultPrevented).toBe(false);
});

it("routes browser-tab clicks but leaves cancelled navigation alone", () => {
  const requests = startBrowserLinkRouting();
  const cases: Array<[string, MouseEventInit?, Record<string, string>?, boolean?]> = [
    ["primary"],
    ["meta", { metaKey: true }],
    ["control", { ctrlKey: true }],
    ["middle", {}, {}, true],
    ["new-window", {}, { target: "_blank" }],
  ];
  for (const [name, init, attributes, middle] of cases) {
    expect(
      dispatchLink(`https://example.com/${name}`, init, attributes, middle).defaultPrevented,
    ).toBe(true);
  }
  const routed = cases.map(([name]) => ({ open: true, url: `https://example.com/${name}` }));
  expect(requests).toEqual(routed);
  const anchor = appendLink("https://example.com/handled");
  anchor.addEventListener("click", (event) => event.preventDefault());
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });

  anchor.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(requests).toEqual(routed);
});

it.each([false, true])(
  "native links take precedence when the remote preference is %s",
  (enabled) => {
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", {
      messageHandlers: {
        openclawLink: { postMessage },
        openclawBrowser: { postMessage: vi.fn() },
      },
    });
    const requests = startBrowserLinkRouting(enabled);
    expect(dispatchLink("https://example.com/report").defaultPrevented).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    expect(requests).toEqual([{ open: true, url: "https://example.com/report", native: true }]);
  },
);

it("ignores local, download, file, non-web, Shift/Alt, and right-click targets", () => {
  const requests = startBrowserLinkRouting();
  const cases: Array<[string, MouseEventInit?, Record<string, string>?, boolean?]> = [
    [`${location.origin}/usage`],
    ["https://example.com/archive.zip", {}, { download: "archive.zip" }],
    ["https://example.com/file", {}, { "data-file-path": "README.md" }],
    ["mailto:hello@example.com"],
    ["tel:+15555550123"],
    ["https://example.com/shift", { shiftKey: true }],
    ["https://example.com/alt", { altKey: true }],
    ["https://example.com/context", { button: 2 }, {}, true],
  ];
  for (const args of cases) {
    expect(dispatchLink(...args).defaultPrevented).toBe(false);
  }
  expect(requests).toEqual([]);
});
