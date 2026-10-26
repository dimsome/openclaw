import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  createComposerContainer,
  createComposerProps,
  disposeComposer,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { resetChatComposerState } from "./components/chat-composer.tsx";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import "../../styles.css";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-progress.css";

function isPainted(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    [rect.left + 1, rect.right - 1].every((x) =>
      element.contains(document.elementFromPoint(x, rect.top + rect.height / 2)),
    )
  );
}

it.each([
  [1280, 720, "clipped"],
  [667, 375, "landscape"],
  [320, 568, "attachment"],
  [375, 812, "panned"],
] as const)("paints context within %sx%s (%s)", async (width, height, mode) => {
  const viewport = [window.innerWidth, window.innerHeight] as const;
  const container = document.body.appendChild(createComposerContainer());
  const releaseDismissal = installChatComposerPickerDismissal(document);
  onTestFinished(async () => {
    disposeComposer(container);
    container.remove();
    resetChatComposerState();
    releaseDismissal();
    vi.unstubAllGlobals();
    await page.viewport(...viewport);
  });
  await page.viewport(width, height);
  const clipped = mode === "clipped",
    panned = mode === "panned";
  if (panned) {
    const actual = window.visualViewport!;
    vi.stubGlobal("visualViewport", {
      width: 375,
      height: 400,
      offsetTop: 300,
      offsetLeft: 0,
      scale: 1,
      addEventListener: actual.addEventListener.bind(actual),
      removeEventListener: actual.removeEventListener.bind(actual),
    });
  }
  container.style.cssText = clipped
    ? "position:fixed;left:772px;top:48px;width:508px;height:312px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end"
    : panned
      ? "position:fixed;top:600px;left:16px;right:16px"
      : "position:fixed;bottom:16px;left:16px;right:16px";
  renderComposerInto(
    container,
    createComposerProps({
      goalDraftMode: clipped ? { action: "start" } : null,
      attachments:
        mode === "attachment"
          ? [{ id: "context-proof", mimeType: "text/plain", fileName: "proof.txt" }]
          : [],
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        totalTokens: 20_300,
        contextTokens: 200_000,
        inputTokens: 19_600,
        outputTokens: 126,
      },
    }),
  );
  const query = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  const composer = query(".agent-chat__input"),
    trigger = query(".context-ring");
  const popover = query(".context-usage [data-anchored-overlay]");
  const open = () => page.elementLocator(trigger).click();
  await open();
  if (clipped) {
    const readout = () => [
      ...popover.querySelectorAll<HTMLElement>(".context-usage__title, strong, dt, dd"),
    ];
    expect(readout().map((element) => element.textContent?.trim())).toEqual(
      "Context window|20.3k / 200k · 10%|In|19.6k|Out|126".split("|"),
    );
    const painted = () => readout().length === 6 && readout().every(isPainted);
    await expect.poll(painted).toBe(true);
    const box = popover.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => popover.checkVisibility()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await open();
    await expect.poll(painted).toBe(true);
    await page
      .elementLocator(container)
      .click({ position: { x: container.clientWidth - 2, y: 2 } });
    await expect.poll(() => popover.checkVisibility()).toBe(false);
  } else {
    await expect
      .poll(() => {
        const box = popover.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.top >= (panned ? 300 : 0) &&
          (panned
            ? Math.abs(box.bottom - (composer.getBoundingClientRect().top - 6)) <= 1
            : box.left >= 0 &&
              box.right <= width + 1 &&
              box.bottom <= composer.getBoundingClientRect().top + 1)
        );
      })
      .toBe(true);
    if (!panned) {
      expect(trigger.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
    }
  }
});
