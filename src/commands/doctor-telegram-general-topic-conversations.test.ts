import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listConversations } from "../config/sessions/conversation-registry.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import { runDoctorHealthRepairs } from "../flows/doctor-repair-flow.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

const CHECK_ID = "core/doctor/telegram-general-topic-conversations";

describe("doctor Telegram General-topic conversation repair", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const root of tempDirs.dirs) {
        await cleanupSessionStateForTest({ stateDir: path.join(root, "state"), rootPath: root });
      }
      cleanup();
    }),
  );
  let cfg: OpenClawConfig;
  let env: NodeJS.ProcessEnv;
  let scope: Parameters<typeof upsertSessionEntryCore>[0];
  const target = "telegram:-1001234567890";
  async function repair() {
    const check = (await resolveDoctorContributionHealthChecks()).find(
      (candidate) => candidate.id === CHECK_ID,
    );
    expect(check).toBeDefined();
    return runDoctorHealthRepairs(
      { mode: "fix", runtime: { log() {}, error() {}, exit() {} }, cfg, env },
      { checks: [check!] },
    );
  }

  const write = (to: string, updatedAt = 100) =>
    upsertSessionEntryCore(scope, {
      sessionId: "topic-1-session",
      updatedAt,
      chatType: "group",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", accountId: "default", to, threadId: "1" },
      }),
    });
  const expectCanonical = async (extra: { conversationRef?: string } = {}) =>
    expect(await listConversations(scope, { channel: "telegram" })).toEqual([
      expect.objectContaining({
        target,
        threadId: "1",
        role: "primary",
        sessionId: "topic-1-session",
        ...extra,
      }),
    ]);

  beforeEach(() => {
    const root = tempDirs.make("openclaw-doctor-telegram-topic-");
    const storePath = path.join(root, "sessions.json");
    cfg = { session: { store: storePath } };
    env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(root, "missing-openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    scope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:1",
      storePath,
    };
  });

  it("merges an upgraded General-topic related binding exactly once", async () => {
    await write(`${target}:topic:1`);
    await write(target, 200);

    const before = await listConversations(scope, { channel: "telegram" });
    const legacy = before.find((row) => row.role === "related");
    const canonical = before.find((row) => row.role === "primary");

    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
    database.db
      .prepare(`INSERT INTO conversation_deliveries
      (operation_id, operation_kind, conversation_id, source_session_key, message_hash,
       status, platform_message_id, reply_thread_id, created_at, updated_at)
      VALUES ('legacy-delivery', 'send', ?, ?, 'hash', 'sent', 'message-1', '1', 100, 100)`)
      .run(legacy!.conversationRef, scope.sessionKey);

    const repaired = await repair();
    expect(repaired).toMatchObject({
      remainingFindings: [],
      changes: ["Merged 1 stale Telegram General-topic conversation identity row(s)."],
    });

    await expectCanonical({ conversationRef: canonical!.conversationRef });
    expect(
      database.db
        .prepare("SELECT conversation_id FROM conversation_deliveries WHERE operation_id = ?")
        .all("legacy-delivery"),
    ).toEqual([{ conversation_id: canonical!.conversationRef }]);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });

    const repeated = await repair();
    expect(repeated).toMatchObject({ findings: [], changes: [] });
    expect(await listConversations(scope, { channel: "telegram" })).toHaveLength(1);
  });

  it("canonicalizes a legacy-only current entry before later session writes", async () => {
    await write(`${target}:topic:1`);

    const repaired = await repair();
    expect(repaired.remainingFindings).toEqual([]);
    await expectCanonical();

    await patchSessionEntryCore(scope, () => ({ displayName: "harmless later write" }));
    await expectCanonical();
  });
});
