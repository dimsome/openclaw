// Native client observation shared by the Gateway store fixtures.
import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import * as browserGateway from "../api/gateway.ts";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayEventFrame,
  GatewayHelloOk,
} from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

export const GATEWAY_STORE_TEST_HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

export function createGatewayEvent(
  event = "chat",
  payload: unknown = {},
  seq = 1,
): GatewayEventFrame {
  return { type: "event", event, payload, seq, stateVersion: { presence: seq, health: seq } };
}

const NativeGatewayBrowserClient = browserGateway.GatewayBrowserClient;
const constructedOptions = new WeakMap<GatewayBrowserClient, GatewayBrowserClientOptions>();

function captureGatewayClients(): void {
  const constructor = vi.spyOn(browserGateway, "GatewayBrowserClient").mockImplementation(
    class extends NativeGatewayBrowserClient {
      constructor(options: GatewayBrowserClientOptions) {
        super(options);
        constructedOptions.set(this, options);
      }
    },
  );
  onTestFinished(() => constructor.mockRestore());
}

function observeGatewayClient(client: GatewayBrowserClient) {
  const testOptions = expectDefined(
    constructedOptions.get(client),
    "native Gateway fixture client",
  );
  // These fixtures drive admission callbacks, not the socket recovery handshake.
  Object.defineProperties(client, {
    recoveryScope: { configurable: true, writable: true, value: undefined },
    recoveryScopeReady: { configurable: true, writable: true, value: undefined },
    connectSent: { configurable: true, value: Promise.resolve(true) },
  });
  const observed = Object.assign(client, {
    testOptions,
    started: 0,
    stopped: 0,
    request: vi.spyOn(client, "request").mockRejectedValue(new Error("unexpected gateway request")),
  });
  vi.spyOn(observed, "start").mockImplementation(() => {
    observed.started += 1;
  });
  const stop = observed.stop.bind(observed);
  vi.spyOn(observed, "stop").mockImplementation(() => {
    observed.stopped += 1;
    stop();
  });
  return observed;
}

export function createGatewayStoreTestStore(
  params: {
    settings?: ReturnType<typeof loadSettings>;
    configureClient?: (client: ReturnType<typeof observeGatewayClient>) => void;
    persistDefaultConnectionSettings?: boolean;
    ownsWarmBoot?: boolean;
    resourceBasePath?: string;
    getModelCatalogTarget?: () => GatewayBrowserClientOptions["modelCatalog"];
    clientOptions?: Pick<
      GatewayBrowserClientOptions,
      "clientName" | "mode" | "platform" | "deviceFamily" | "instanceId" | "scopes"
    >;
  } = {},
) {
  captureGatewayClients();
  const clients: ReturnType<typeof observeGatewayClient>[] = [];
  const observedClients = new WeakSet<GatewayBrowserClient>();
  const { settings = loadSettings(), configureClient, ...options } = params;
  const gateway = createApplicationGateway(settings, "", "", options);
  onTestFinished(
    gateway.subscribe((snapshot) => {
      const client = snapshot.client;
      if (client && !observedClients.has(client)) {
        observedClients.add(client);
        const observed = observeGatewayClient(client);
        clients.push(observed);
        configureClient?.(observed);
      }
    }),
  );
  return { gateway, clients, current: () => expectDefined(clients.at(-1), "gateway client") };
}

export function stubGatewayStoreTestGlobals() {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  vi.stubGlobal("location", new URL("http://127.0.0.1:18789/"));
}
