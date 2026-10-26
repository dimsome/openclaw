import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";

// Discovery is mocked; only root identity crosses the boundary under test.
const rootA = "/synthetic/root-a/dist/extensions";
const rootB = "/synthetic/root-b/dist/extensions";

function plugin(id: string, label: string) {
  return { id, meta: { id, label }, capabilities: {}, config: {} };
}

function loadBootstrap(scope: string) {
  return importFreshModule<typeof import("./bootstrap-registry.js")>(
    import.meta.url,
    `./bootstrap-registry.js?scope=${scope}`,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("../../plugins/channel-catalog-registry.js");
  vi.doUnmock("./bundled.js");
});

it("reads bundled channel ids from the active bundled root without re-importing", async () => {
  // mock-isolation: Synthetic catalog rows isolate root-cache invalidation from plugin discovery.
  vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
    listChannelCatalogEntries: (params?: { env?: NodeJS.ProcessEnv }) => {
      const ids: Record<string, string> = { [rootA]: "alpha", [rootB]: "beta" };
      const id = ids[params?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR ?? ""];
      return id ? [{ pluginId: id, channel: { id: `${id}-chat` } }] : [];
    },
  }));

  const bundledIds = await importFreshModule<typeof import("./bundled-ids.js")>(
    import.meta.url,
    "./bundled-ids.js?scope=root-aware-id-cache",
  );

  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootA);
  expect(bundledIds.listBundledChannelIds()).toEqual(["alpha-chat"]);

  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootB);
  expect(bundledIds.listBundledChannelIds()).toEqual(["beta-chat"]);
});

it("reads bootstrap plugins from the active bundled root without re-importing", async () => {
  const suffix = () => {
    const activeRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    return activeRoot === rootA ? "A" : activeRoot === rootB ? "B" : "unknown";
  };

  // mock-isolation: Synthetic bundled plugins isolate cache invalidation from runtime loading.
  vi.doMock("./bundled.js", () => ({
    getBundledChannelPlugin: (id: string) => plugin(id, `runtime-${id}`),
    getBundledChannelSetupPlugin: (id: string) => plugin(id, `setup-${suffix()}`),
    getBundledChannelSecrets: (id: string) => ({
      secretTargetRegistryEntries: [{ id: `runtime-${id}`, targetType: "channel" }],
    }),
    getBundledChannelSetupSecrets: (id: string) => ({
      secretTargetRegistryEntries: [{ id: `setup-${id}-${suffix()}`, targetType: "channel" }],
    }),
  }));

  const bootstrapRegistry = await loadBootstrap("root-aware-bootstrap-cache");

  for (const [root, id, expectedSuffix] of [
    [rootA, "alpha", "A"],
    [rootB, "beta", "B"],
  ]) {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
    expect(bootstrapRegistry.getBootstrapChannelPlugin(id)?.meta.label).toBe(
      `setup-${expectedSuffix}`,
    );
    expect(
      bootstrapRegistry.getBootstrapChannelSecrets(id)?.secretTargetRegistryEntries?.[0]?.id,
    ).toBe(`setup-${id}-${expectedSuffix}`);
  }
});

it.each(["plugin", "secrets"] as const)(
  "retries %s errors without poisoning the other lookup",
  async (failing) => {
    const unavailable = () => {
      throw new Error("Cannot find module 'fixture-dependency'");
    };
    const getPlugin = vi.fn(() =>
      failing === "plugin" ? unavailable() : plugin("alpha", "Alpha"),
    );
    const getSecrets = vi.fn(unavailable);
    // mock-isolation: Synthetic bundled plugins isolate cache invalidation from runtime loading.
    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: getPlugin,
      getBundledChannelSetupPlugin: vi.fn(() => undefined),
      getBundledChannelSecrets: getSecrets,
      getBundledChannelSetupSecrets: vi.fn(() => undefined),
    }));
    const registry = await loadBootstrap(`bootstrap-${failing}-load-guard`);
    const failingLookup =
      failing === "plugin"
        ? registry.getBootstrapChannelPlugin
        : registry.getBootstrapChannelSecrets;
    expect(failingLookup("alpha")).toBeUndefined();
    expect(failingLookup("alpha")).toBeUndefined();
    if (failing === "plugin") {
      expect(registry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    } else {
      expect(registry.getBootstrapChannelPlugin("alpha")).toEqual(plugin("alpha", "Alpha"));
    }
    expect(getPlugin).toHaveBeenCalledTimes(failing === "plugin" ? 2 : 1);
    expect(getSecrets).toHaveBeenCalledTimes(failing === "plugin" ? 1 : 2);
  },
);
