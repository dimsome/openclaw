import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { bindUserTurnTranscriptAnnotation } from "../../sessions/user-turn-transcript-annotation.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  stageSessionPendingInput,
  prepareForeignLiveSessionPendingInputEntries,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("pending-input-mirror-replay-");
let receipt: SessionPendingInputReceipt | undefined;
afterEach(async () => {
  receipt?.finish("interrupted");
  await receipt?.settled?.();
  receipt = undefined;
  await closeOpenClawAgentDatabasesAsync();
});

it("replays a committed native prompt without duplicating the mirrored input", async () => {
  const runId = "announce:settle-workers";
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:subagent:lead",
    sessionId: "lead-session",
    storePath: fixture.storePath(),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    lifecycleRevision: "lead-lifecycle",
    activeWriterRunId: runId,
    updatedAt: 1,
  });
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: "Worker integration ready",
      display: false,
      idempotencyKey: `${runId}:user`,
      requesterOrigin: { operatorProfileId: "gateway-owner", sessionKey: scope.sessionKey },
      provenance: {
        kind: "inter_session",
        sourceTool: "subagent_settle",
        sourceSessionKey: "worker-b",
      },
    },
    target: { ...scope, sessionEntry: loadSessionEntry(scope) },
    trackInputCompletion: true,
  });
  expect(await recorder.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
  await recorder.persistApproved();
  const original = structuredClone(
    expectDefined(recorder.getPersistedMessage?.(), "admitted input"),
  );
  const annotate = expectDefined(
    bindUserTurnTranscriptAnnotation({ recorder, target: scope, runId, assertCurrent: () => {} }),
    "native annotation owner",
  );
  const upstreamUserText = "Native harness context\nWorker integration ready";
  await annotate({
    mirrorIdentity: "native-turn:prompt",
    mirrorOrigin: "codex-app-server",
    upstreamUserText,
    mirrorSourceFingerprint: createHash("sha256")
      .update(JSON.stringify({ role: "user", content: original.content, upstreamUserText }))
      .digest("hex")
      .slice(0, 32),
  });
  const committed = structuredClone(
    expectDefined(recorder.getPersistedMessage?.(), "native prompt"),
  );
  const transcript = await loadTranscriptEvents(scope);
  recorder.finishPendingInput?.("interrupted");
  await closeOpenClawAgentDatabasesAsync();
  rotateAgentEventLifecycleGeneration();
  receipt = await stageSessionPendingInput(scope, {
    runId,
    message: {
      ...original,
      provenance: { ...original.provenance, kind: "inter_session", sourceSessionKey: "worker-a" },
    },
    trackCompletion: true,
    replaySourceSessionKeys: ["worker-a", "worker-b"],
    assertCurrent: () => {},
  });
  receipt = expectDefined(receipt, "replayed input");
  expect(receipt.state).toBe("queued");
  expect(receipt.message).toEqual(committed);
  const readForeign = await prepareForeignLiveSessionPendingInputEntries(scope);
  expect(readForeign()).toEqual(new Map([[receipt.inputId, committed.idempotencyKey]]));
  expect(
    await receipt.runAsync!(async () =>
      (await prepareForeignLiveSessionPendingInputEntries(scope))(),
    ),
  ).toEqual(new Map());
  expect(receipt.run(() => "continued")).toBe("continued");
  const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
  await expect(receipt.completeAsync!(outcome)).resolves.toEqual(outcome);
  expect(await loadTranscriptEvents(scope)).toEqual(transcript);
  receipt.finish("interrupted");
  await receipt.settled?.();
  expect(readForeign()).toEqual(new Map());
});

it("still rejects changed completion content and requester facts against a native prompt", async () => {
  const { scope, original, transcript, replay } = await commitMirroredInput();
  const requesterOrigin = expectDefined(
    original["__openclaw"]?.requesterOrigin,
    "requester origin",
  );
  const changed: PersistedUserTurnMessage[] = [
    { ...original, content: "Different result" },
    {
      ...original,
      __openclaw: {
        ...original["__openclaw"],
        requesterOrigin: { ...requesterOrigin, operatorProfileId: "other" },
      },
    },
    { ...original, __openclaw: { ...original["__openclaw"], unexpected: "extra metadata" } },
  ];
  for (const message of changed) {
    await expect(replay(message)).rejects.toThrow(/conflicts|does not match/);
  }
  expect(await loadTranscriptEvents(scope)).toEqual(transcript);
});
