import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawHubSourceError } from "../../claws/clawhub-source.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { clawsHandlers } from "./claws.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const listClawHubClaws = vi.hoisted(() => vi.fn());
const readClawHubClawDetail = vi.hoisted(() => vi.fn());
const readClawHubClawPreview = vi.hoisted(() => vi.fn());
vi.mock("../../claws/clawhub-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../claws/clawhub-source.js")>()),
  listClawHubClaws,
  readClawHubClawDetail,
  readClawHubClawPreview,
}));

afterEach(() => vi.clearAllMocks());

const enabled = { gateway: { controlUi: { experimental: { claws: true } } } };

async function catalogRequest(
  method: string,
  params: Record<string, unknown>,
  getRuntimeConfig: () => unknown = () => enabled,
) {
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(clawsHandlers[method], `${method} handler`);
  await handler({
    req: { type: "req", id: "catalog", method },
    params,
    respond,
    context: { getRuntimeConfig } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond.mock.calls;
}

function expectError(replies: Parameters<RespondFn>[], code: string, message?: string) {
  expect(replies).toHaveLength(1);
  expect(replies[0]?.[2]).toMatchObject({ code, ...(message ? { message } : {}) });
}

it("does not expose installed-Claw status as a Gateway method", () => {
  expect(coreGatewayHandlers["claws.status"]).toBeUndefined();
});

describe("ClawHub Claw catalog Gateway methods", () => {
  const entry = { packageName: "@openclaw/workflow-operator" };
  const release = { packageName: entry.packageName, version: "1.0.0" };
  const previewParams = { ...release, kind: "instruction", name: "AGENTS.md" };

  it("registers read-scoped catalog methods but rejects discovery with Labs off", async () => {
    for (const method of [
      "claws.catalog.search",
      "claws.catalog.detail",
      "claws.catalog.preview",
    ] as const) {
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: true,
      });
    }
    expectError(await catalogRequest("claws.catalog.search", {}, () => ({})), "FORBIDDEN");
    expect(listClawHubClaws).not.toHaveBeenCalled();
  });

  it("lists starters and reads one exact official release with Labs on", async () => {
    listClawHubClaws.mockResolvedValue([entry]);
    readClawHubClawDetail.mockResolvedValue({ ...entry, version: "1.0.0" });
    expect((await catalogRequest("claws.catalog.search", {}))[0]?.[1]).toEqual({
      entries: [entry],
    });

    const detail = await catalogRequest("claws.catalog.detail", release);
    expect(readClawHubClawDetail).toHaveBeenCalledWith(release);
    expect(detail[0]?.[1]).toMatchObject({ detail: { ...entry, version: "1.0.0" } });
  });

  it("returns the requested preview only for an exact official release", async () => {
    const preview = { kind: "instruction", name: "AGENTS.md", content: "# Instructions" };
    readClawHubClawPreview.mockResolvedValue(preview);
    const replies = await catalogRequest("claws.catalog.preview", previewParams);
    expect(readClawHubClawPreview).toHaveBeenCalledWith(previewParams);
    expect(replies[0]?.[1]).toEqual({ preview });
  });

  it.each([
    ["claws.catalog.search", listClawHubClaws, {}, [entry]],
    ["claws.catalog.detail", readClawHubClawDetail, release, { ...entry, version: "1.0.0" }],
    ["claws.catalog.preview", readClawHubClawPreview, previewParams, { content: "# Instructions" }],
  ] as const)(
    "drops %s when Labs turns off during the ClawHub request",
    async (method, sourceMock, params, result) => {
      const source = createDeferredCore<unknown>();
      sourceMock.mockReturnValue(source.promise);
      let labsEnabled = true;
      const pending = catalogRequest(method, params, () => (labsEnabled ? enabled : {}));

      labsEnabled = false;
      source.resolve(result);
      expectError(await pending, "FORBIDDEN");
    },
  );

  it.each([
    ["claws.catalog.search", { query: 42 }],
    ["claws.catalog.detail", { packageName: 42 }],
    ["claws.catalog.preview", { ...release, kind: "unknown", name: "AGENTS.md" }],
  ])("rejects malformed %s before catalog I/O", async (method, params) => {
    expectError(await catalogRequest(method, params), "INVALID_REQUEST");
    expect(listClawHubClaws).not.toHaveBeenCalled();
    expect(readClawHubClawDetail).not.toHaveBeenCalled();
    expect(readClawHubClawPreview).not.toHaveBeenCalled();
  });

  it.each([
    [new ClawHubSourceError("unavailable", "Release is unavailable."), "Release is unavailable."],
    [new Error("upstream internal detail"), "ClawHub catalog is unavailable."],
  ])("preserves the public catalog failure for %s", async (failure, message) => {
    readClawHubClawDetail.mockRejectedValue(failure);
    expectError(await catalogRequest("claws.catalog.detail", release), "UNAVAILABLE", message);
  });
});
