import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SkillWorkshopChangeNotice } from "../../../../../src/shared/skill-workshop-change-notice.js";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createContext } from "../../skill-workshop/skill-workshop-page.test-support.ts";
import { ChatSkillLearnedNotice } from "./chat-skill-learned-notice.tsx";

const notice: SkillWorkshopChangeNotice = {
  kind: "skill-workshop-change",
  agentId: "main",
  runId: "skill-workshop-review:r1",
  skills: [
    { name: "deploy-staging", action: "updated", summary: "tightened the rollback step" },
    { name: "release-notes", action: "created" },
  ],
};

function mount(request: Parameters<typeof createContext>[0], scopes?: string[]) {
  const context = createContext(request, { methods: ["skills.workshop.undo"], scopes });
  const [current, setCurrent] = createSignal(notice);
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <ChatSkillLearnedNotice notice={current()} />, {
    wrapper: provider.wrapper,
  });
  return { element: view.container, context, setCurrent };
}

const undoButton = (element: HTMLElement) =>
  element.querySelector<HTMLButtonElement>(".chat-skill-notice__undo");
const expectError = (element: HTMLElement, message: string) =>
  waitForSolid(() =>
    expect(element.querySelector("[role='alert']")?.textContent).toContain(message),
  );

describe("skill review notice", () => {
  it.each(["success", "failure"])(
    "settles one admitted Undo after duplicate clicks: %s",
    async (outcome) => {
      const response = createDeferred<unknown>();
      const request = vi.fn(() => response.promise);
      const { element } = mount(request);
      const button = undoButton(element)!;
      button.click();
      button.click();
      expect(request).toHaveBeenCalledExactlyOnceWith("skills.workshop.undo", {
        agentId: "main",
        runId: notice.runId,
      });
      if (outcome === "success") {
        response.resolve({ status: "undone", changes: [] });
        await waitForSolid(() => expect(element.textContent).toContain("Undone"));
        expect(undoButton(element)).toBeNull();
      } else {
        response.reject(new Error("Unable to revert this review."));
        await expectError(element, "Unable to revert this review.");
        expect(button.disabled).toBe(false);
      }
    },
  );

  it("keeps Undo available with the error when the revert fails", async () => {
    const request = vi.fn((): Promise<unknown> => {
      throw new Error("Learning is off.");
    });
    const { element } = mount(request);

    undoButton(element)?.click();

    await expectError(element, "Learning is off.");
    expect(undoButton(element)?.disabled).toBe(false);
    const retry = createDeferred<{ status: "undone"; changes: [] }>();
    request.mockReturnValueOnce(retry.promise);
    const button = undoButton(element)!;
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    expect(undoButton(element)).toBe(button);
    expect(element.querySelector("[role='alert']")).toBeNull();
    expect(element.textContent).toContain("Undoing");
    retry.resolve({ status: "undone", changes: [] });
    await waitForSolid(() => expect(element.textContent).toContain("Undone"));
  });

  it("retires pending Undo feedback when a different review replaces the notice", async () => {
    const response = createDeferred<{ status: "undone"; changes: [] }>();
    const request = vi.fn(() => response.promise);
    const { element, setCurrent } = mount(request);

    undoButton(element)!.click();
    flush();
    expect(undoButton(element)?.disabled).toBe(true);
    expect(element.textContent).toContain("Undoing");

    setCurrent({ ...notice, runId: "skill-workshop-review:r2" });
    flush();
    expect(undoButton(element)?.disabled).toBe(false);
    response.resolve({ status: "undone", changes: [] });
    await response.promise;
    await Promise.resolve();
    flush();

    expect(element.textContent).not.toContain("Undone");
    expect(undoButton(element)?.disabled).toBe(false);
    expect(request).toHaveBeenCalledExactlyOnceWith("skills.workshop.undo", {
      agentId: "main",
      runId: notice.runId,
    });
  });

  it("offers no Undo to an operator without admin scope", async () => {
    const { element } = mount(vi.fn(), ["operator.read"]);
    expect(element.textContent).toContain("deploy-staging");
    expect(undoButton(element)).toBeNull();
  });

  it("opens a skill under the notice's agent, not the agent selected elsewhere", async () => {
    // The fixture's sidebar selection is "research"; the notice belongs to "main".
    const { element, context } = mount(vi.fn());

    element.querySelector<HTMLButtonElement>("button[aria-label*='deploy-staging']")?.click();

    const select = vi.mocked(context.agentSelection.set);
    const navigate = vi.mocked(context.navigate);
    expect(select).toHaveBeenCalledWith("main");
    expect(navigate).toHaveBeenCalledWith("skill-workshop", { search: "?skill=deploy-staging" });
    // Selecting first means the Workshop resolves the notice's agent when it loads.
    expect(select.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });
});
