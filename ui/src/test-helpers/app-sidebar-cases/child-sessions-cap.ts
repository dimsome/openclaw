import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionsHarness } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import { mountSidebarFixture, sessionList } from "./compact.test-support.ts";
import "../../components/app-sidebar.tsx";

const parentKey = "agent:main:parent";
const childKeys = Array.from({ length: 6 }, (_, i) => `agent:main:dashboard:child-${i + 1}`);

async function mountChildSessions(
  extraRows: GatewaySessionRow[] = [],
  childFields: (index: number) => Partial<GatewaySessionRow> = (index) => ({
    updatedAt: index + 1,
  }),
) {
  const harness = createSessionsHarness("main", [parentKey]);
  const children = childKeys.map((key, index) => ({
    key,
    spawnedBy: parentKey,
    kind: "direct" as const,
    ...childFields(index),
  }));
  harness.list.mockResolvedValue({
    ...sessionList([...children, ...extraRows], 100_000),
    count: childKeys.length,
  });
  const { sidebar, q: find } = await mountSidebarFixture(undefined, harness.sessions);
  harness.publishList({
    result: sessionList([
      { key: parentKey, kind: "direct", updatedAt: 1, childSessions: childKeys },
    ]),
  });
  await sidebar.updateComplete;
  const expanded = () =>
    expect(find("[data-child-session-toggle]")?.getAttribute("aria-expanded")).toBe("true");
  const more = () => find("[data-show-more-children]")?.textContent?.trim();
  return { sidebar, find, expanded, more };
}

it("caps visible children until requested and resets the cap after collapse", async () => {
  const { sidebar, find, expanded, more } = await mountChildSessions();
  const expectChildren = (count: number) =>
    waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(count),
    );

  const toggle = find<HTMLButtonElement>("[data-child-session-toggle]");
  expanded();
  await expectChildren(4);
  const showMore = find<HTMLButtonElement>("[data-show-more-children]");
  expect({
    text: showMore?.textContent?.trim(),
    label: showMore?.getAttribute("aria-label"),
  }).toEqual({ text: "Show 2 more", label: "Show 2 more" });

  showMore?.click();
  await expectChildren(6);
  expect(find("[data-show-more-children]")).toBeNull();

  toggle?.click();
  await sidebar.updateComplete;
  toggle?.click();
  await expectChildren(4);
  expect(more()).toBe("Show 2 more");
});

it("keeps live children visible past the cap", async () => {
  const { find, more } = await mountChildSessions([
    {
      key: "agent:main:dashboard:grandchild",
      spawnedBy: childKeys[5],
      kind: "direct",
      updatedAt: 10,
      status: "running",
      hasActiveRun: true,
    },
  ]);

  expect(find(`[data-child-session-toggle="${parentKey}"]`)?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  await waitForFast(() => expect(find(`[data-session-key="${childKeys[5]}"]`)).not.toBeNull());
  expect(find(`[data-session-key="${childKeys[4]}"]`)).toBeNull();
  expect(more()).toBe("Show 1 more");
});

it("orders capped children by the selected session sort instead of their keys", async () => {
  // Real child keys end in random ids, so key order is unrelated to activity.
  const createdAt = [3, 6, 1, 5, 2, 4];
  const updatedAt = [60, 10, 50, 20, 40, 30];
  const { sidebar, expanded, more } = await mountChildSessions([], (index) => ({
    createdAt: createdAt[index],
    updatedAt: updatedAt[index],
  }));
  const visibleChildren = () =>
    [...sidebar.querySelectorAll(".sidebar-recent-session--child[data-session-key]")].map((row) =>
      row.getAttribute("data-session-key")?.replace("agent:main:dashboard:", ""),
    );

  expanded();
  await waitForFast(() =>
    expect(visibleChildren()).toEqual(["child-2", "child-4", "child-6", "child-1"]),
  );

  sidebar.setSessionSortMode("updated");
  await waitForFast(() =>
    expect(visibleChildren()).toEqual(["child-1", "child-3", "child-5", "child-6"]),
  );
  expect(more()).toBe("Show 2 more");
});
