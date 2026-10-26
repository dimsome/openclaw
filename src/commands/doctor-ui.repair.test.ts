import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "../gateway/control-ui-root-assets.js";
import * as assets from "../infra/control-ui-assets.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as exec from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import * as version from "../version.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairUiProtocolFreshness } from "./doctor-ui.js";
import {
  createTestRuntime,
  MACOS_APP_INSTALL_OWNER_MARKER,
} from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();
const prompter = createDoctorPrompter({ runtime, options: { yes: true, force: true } });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const note = vi.fn();
const expectNote = (message: unknown, heading: unknown = "UI") =>
  expect(note).toHaveBeenCalledWith(message, heading);
const buildId = "doctor-runtime-build";
let root: string;
let build: MockInstance<typeof assets.ensureControlUiAssetsBuilt>;
let git: MockInstance<typeof exec.runCommandWithTimeout>;
const repair = () => maybeRepairUiProtocolFreshness(runtime, prompter);

async function writeIndex(html: string) {
  const index = path.join(root, "dist/control-ui/index.html");
  await fs.mkdir(path.dirname(index), { recursive: true });
  await fs.writeFile(index, html);
  return index;
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.realpath(tempDirs.make("openclaw-doctor-ui-repair-"));
  vi.spyOn(notes, "note").mockImplementation(note);
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  vi.spyOn(packageRoot, "resolveOpenClawPackageRootSync").mockReturnValue(root);
  vi.spyOn(version, "resolveRuntimeServiceBuildId").mockReturnValue(buildId);
  vi.spyOn(prompter, "confirmAutoFix").mockResolvedValue(true);
  vi.spyOn(prompter, "confirmAggressiveAutoFix").mockResolvedValue(true);
  await fs.mkdir(path.join(root, "ui"));
  await fs.writeFile(path.join(root, "ui/package.json"), "{}");
  build = vi
    .spyOn(assets, "ensureControlUiAssetsBuilt")
    .mockImplementation(async (_runtime, opts) => {
      opts?.onBuildStart?.();
      return { ok: true };
    });
  git = vi
    .spyOn(exec, "runCommandWithTimeout")
    .mockResolvedValue(createCommandResult({ stdout: "abc123 protocol schema changed\n" }));
});

afterEach(() => vi.restoreAllMocks());

it("routes missing app-owned assets to the host without package or git commands", async () => {
  await fs.writeFile(
    path.join(root, "openclaw-install-owner.json"),
    MACOS_APP_INSTALL_OWNER_MARKER,
  );
  await repair();
  expectNote(
    expect.stringContaining("Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway."),
  );
  for (const fn of [prompter.confirmAutoFix, prompter.confirmAggressiveAutoFix, build, git]) {
    expect(fn).not.toHaveBeenCalled();
  }
});

it.each([false, true])("repairs source assets (protocol changed=%s)", async (force) => {
  await writeIndex(
    force
      ? `<html ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${buildId}-${"a".repeat(64)}"></html>`
      : '<script src="./assets/startup.js"></script>',
  );
  await repair();
  expect(prompter[force ? "confirmAggressiveAutoFix" : "confirmAutoFix"]).toHaveBeenCalledOnce();
  expect(build).toHaveBeenCalledWith(runtime, {
    root,
    expectedBuildId: buildId,
    force,
    onBuildStart: expect.any(Function),
  });
  expect(git).toHaveBeenCalledTimes(force ? 1 : 0);
  if (force) {
    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expectNote("UI rebuild complete.");
    expectNote(expect.stringContaining("ui:build"), "UI Freshness");
  }
});

it.each([false, true])("leaves packaged assets untouched (dev build=%s)", async (dev) => {
  const html = dev
    ? `<html ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="dev-${"a".repeat(64)}"></html>`
    : '<script src="./assets/startup.js"></script>';
  const index = await writeIndex(html);
  await fs.rm(path.join(root, "ui/package.json"));
  await repair();
  if (dev) {
    expect(note).not.toHaveBeenCalled();
  } else {
    expectNote(
      expect.stringContaining("Reinstall OpenClaw to restore bundled Control UI assets."),
      expect.any(String),
    );
  }
  expect(build).not.toHaveBeenCalled();
  expect(git).not.toHaveBeenCalled();
  expect(await fs.readFile(index, "utf8")).toBe(html);
});

it("reports owner-normalized build failures instead of claiming repair success", async () => {
  build.mockResolvedValueOnce({
    ok: false,
    message: "Control UI build failed: spawn ENOENT",
  });
  await repair();
  expectNote("Control UI build failed: spawn ENOENT");
  expect(note).not.toHaveBeenCalledWith("UI build complete.", "UI");
});
