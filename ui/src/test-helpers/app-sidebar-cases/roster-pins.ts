import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { domProbe } from "../dom-probe.ts";
import { mountRoster, roster, session, sessionKeys, settleRoster } from "./roster.test-support.ts";

const thread = (id: string, name: string, at: number, extra: Partial<GatewaySessionRow> = {}) =>
  session(id, at, { key: `agent:${id}:${name}`, isMain: false, ...extra });

function mode(sidebar: Parameters<typeof settleRoster>[0], sidebarAgentsMode: "chip" | "roster") {
  sidebar.sidebarAgentsMode = sidebarAgentsMode;
  return settleRoster(sidebar);
}

function pinnedRow(sidebar: HTMLElement, key: string) {
  return sidebar.querySelector(
    `[data-session-section="pinned"] .sidebar-recent-session[data-session-key="${key}"]`,
  );
}

function pinnedKeys(sidebar: HTMLElement) {
  return [
    ...sidebar.querySelectorAll<HTMLElement>(
      '[data-session-section="pinned"] .sidebar-recent-session',
    ),
  ].map((row) => row.dataset.sessionKey);
}

describe("AppSidebar agent roster pins", () => {
  it("lists cross-agent pins in saved order in the Pinned section, not the rail", async () => {
    const parentKey = "agent:working:pinned";
    const childKey = "agent:recent:recent";
    const { sidebar, context } = await mountRoster(
      roster,
      roster.agents.flatMap((agent, index) => [
        thread(agent.id, "pinned", 10 - index, {
          pinned: true,
          icon: "⭐",
          ...(agent.id === "working" ? { childSessions: [childKey] } : {}),
        }),
        thread(agent.id, "recent", 5 - index, {
          icon: "📝",
          ...(agent.id === "recent" ? { spawnedBy: parentKey } : {}),
        }),
      ]),
    );
    const dom = domProbe(sidebar);
    const entries = [
      "route:usage",
      "session:agent:working:pinned",
      "route:plugins",
      "session:agent:main:pinned",
      "session:agent:recent:pinned",
    ];
    sidebar.sidebarEntries = entries;
    await sidebar.updateComplete;
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    await mode(sidebar, "roster");
    const rail = dom.all<HTMLElement>(".sidebar-rail [data-sidebar-entry]");
    expect([...rail].map(({ dataset }) => dataset.sidebarEntry)).toEqual([
      "route:usage",
      "route:plugins",
    ]);
    const pinned = entries.flatMap((entry) =>
      entry.startsWith("session:") ? [entry.slice("session:".length)] : [],
    );
    expect(pinnedKeys(sidebar)).toEqual(pinned);
    for (const id of ["working", "main", "recent"]) {
      const pin = pinnedRow(sidebar, `agent:${id}:pinned`)!;
      expect(pin.closest("[data-agent-group]")).toBeNull();
      expect(pin.querySelector<HTMLAnchorElement>("a")?.pathname).toBe(`/chat/${id}/pinned`);
    }
    await mode(sidebar, "chip");
    // Other agents' pins resolve through descriptors; the loaded row is listed once, first.
    const chipPins = pinnedKeys(sidebar);
    expect(chipPins).toContain("agent:main:pinned");
    expect(sessionKeys(sidebar)).toEqual([...chipPins, "agent:main:recent"]);
    expect(sidebar.sidebarEntries).toEqual(entries);
    await mode(sidebar, "roster");
    pinnedRow(sidebar, "agent:working:pinned")?.querySelector<HTMLAnchorElement>("a")?.click();
    await settleRoster(sidebar);
    expect(context.agentSelection.state.selectedId).toBe("working");
    expect(onNavigate).toHaveBeenLastCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/working/pinned" }),
    );
    expect(sidebar.sidebarEntries).toEqual(entries);
  });
});
