vi.mock("../media-generation-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-generation-activity.js")>();
  return {
    ...actual,
    listMediaGenerationOperations: listOperations,
  };
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaGenerationOperation } from "../media-generation-activity.js";
import { MUSIC_GENERATION_TASK_KIND } from "../media-generation-task-status.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";

const { listOperations } = vi.hoisted(() => ({ listOperations: vi.fn() }));
const sessionKey = "agent:main:discord:direct:123";

function musicStatusOperation(overrides: Partial<MediaGenerationOperation> = {}) {
  return {
    taskId: "task-active",
    taskKind: MUSIC_GENERATION_TASK_KIND,
    sourceId: "music_generate:google",
    requesterSessionKey: sessionKey,
    runId: "tool:music_generate:active",
    task: "night-drive synthwave",
    status: "running",
    progressSummary: "Generating music",
    ...overrides,
  };
}

describe("createMusicGenerateTool status actions", () => {
  beforeEach(() => {
    listOperations.mockReset().mockReturnValue([]);
  });

  it.each([
    ["running", "google", "Generating music"],
    ["queued", "minimax", "Queued music generation"],
  ] as const)(
    "reports %s tasks through duplicate/status actions",
    async (status, provider, progressSummary) => {
      listOperations.mockReturnValue([
        musicStatusOperation({ sourceId: `music_generate:${provider}`, status, progressSummary }),
      ]);
      const result =
        status === "running"
          ? await createMusicGenerateDuplicateGuardResult(sessionKey, {
              prompt: "night-drive synthwave",
            })
          : await createMusicGenerateStatusActionResult(sessionKey);
      expect(result?.details).toMatchObject({
        action: "status",
        active: true,
        existingTask: true,
        status,
        taskKind: MUSIC_GENERATION_TASK_KIND,
        provider,
        task: { taskId: "task-active" },
        progressSummary,
      });
      if (status === "running") {
        expect(result?.content).toStrictEqual([
          {
            type: "text",
            text: "Music generation task task-active is already running with google.\nProgress: Generating music.\nDo not call music_generate again for this request. Do not wait, poll, or yield for it: end this turn; the completion arrives as a later turn and sends the finished music here.",
          },
        ]);
        expect(result?.details).toMatchObject({
          duplicateGuard: true,
          task: { runId: "tool:music_generate:active" },
        });
      } else {
        expect(result?.content[0]).toMatchObject({
          text: expect.stringContaining(
            "Music generation task task-active is already queued with minimax.",
          ),
        });
      }
    },
  );

  it("returns recent succeeded music status instead of starting a duplicate generation", async () => {
    listOperations.mockReturnValue([
      musicStatusOperation({
        taskId: "task-recent-music",
        requestKey: "music-request:night-drive",
        runId: "tool:music_generate:recent",
        status: "succeeded",
        endedAt: Date.now() - 10_000,
        progressSummary: "Generated 1 track",
      }),
    ]);

    const result = await createMusicGenerateDuplicateGuardResult(sessionKey, {
      requestKey: "music-request:night-drive",
    });
    for (const text of [
      "Music generation task task-recent-music recently succeeded",
      "Do not call music_generate again for the same request; this recent music generation already completed.",
    ]) {
      expect(result?.content[0]).toMatchObject({ text: expect.stringContaining(text) });
    }
    expect(result?.details).toMatchObject({ duplicateGuard: true, active: false });
  });
});
