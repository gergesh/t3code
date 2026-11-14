import type { EnvironmentId } from "@t3tools/contracts";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import {
  appendOrchestrationProtocol,
  Connectivity,
  ConnectionDriver,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  Wakeups,
  mapRemoteEnvironmentError,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { RpcSessionFactory, rpcSessionLayer } from "@t3tools/client-runtime/rpc";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Socket from "effect/socket/Socket";

export interface TuiServer {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}

interface IdentifiedServer extends TuiServer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

// One route and no relay means there is nothing to check before connecting.
const uncheckedResult = Effect.succeed("unchecked" as const);
const unchecked = () => uncheckedResult;

const CLIENT_METADATA = { label: "t3 tui", deviceType: "desktop" } as const;

/**
 * Connects to one server with a bearer token the CLI minted. The shared driver
 * also resolves relay, SSH and DPoP routes, none of which a local TUI has.
 * Each attempt mints a fresh socket ticket because tickets expire in minutes.
 */
const driverLayer = (server: IdentifiedServer) =>
  Layer.effect(
    ConnectionDriver,
    Effect.gen(function* () {
      const sessions = yield* RpcSessionFactory;
      const httpClient = yield* HttpClient.HttpClient;
      const wsBaseUrl = server.httpBaseUrl.replace(/^http/, "ws");
      return ConnectionDriver.of({
        connect: Effect.fn("TuiConnectionDriver.connect")(function* (entry, reportProgress) {
          yield* reportProgress({ stage: "preparing" });
          const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
            wsBaseUrl,
            httpBaseUrl: server.httpBaseUrl,
            bearerToken: server.bearerToken,
            clientMetadata: CLIENT_METADATA,
            connectionMethod: "direct",
          }).pipe(
            Effect.mapError((error) => mapRemoteEnvironmentError(error)),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
          const prepared: PreparedConnection = {
            environmentId: server.environmentId,
            label: server.label,
            httpBaseUrl: server.httpBaseUrl,
            socketUrl: appendOrchestrationProtocol(socketUrl),
            httpAuthorization: { _tag: "Bearer", token: server.bearerToken },
            target: entry.target,
          };
          yield* reportProgress({ stage: "opening", prepared });
          const session = yield* sessions.connect(prepared);
          yield* reportProgress({ stage: "synchronizing", prepared });
          yield* session.ready;
          return { prepared, session, refusedRouteIds: [] };
        }),
        preflight: unchecked,
        checkHost: unchecked,
      });
    }),
  );

// The TUI holds one thread for one sitting, so there is nothing worth caching across runs.
const nothing = Effect.succeedNone;
const ignored = () => Effect.void;
const missing = () => nothing;
const noCache = Layer.succeed(
  Persistence.EnvironmentCacheStore,
  Persistence.EnvironmentCacheStore.of({
    loadShell: missing,
    saveShell: ignored,
    loadThread: missing,
    saveThread: ignored,
    removeThread: ignored,
    loadServerConfig: missing,
    saveServerConfig: ignored,
    loadVcsRefs: missing,
    saveVcsRefs: ignored,
    removeVcsRefs: ignored,
    clearVcsRefs: ignored,
    clear: ignored,
  }),
);

/** The services the client-runtime operations and thread state need for one environment. */
export const environmentLayer = (server: IdentifiedServer) => {
  const supervisor = Layer.effect(
    EnvironmentSupervisor.EnvironmentSupervisor,
    EnvironmentSupervisor.make(
      {
        target: new PrimaryConnectionTarget({
          environmentId: server.environmentId,
          label: server.label,
          httpBaseUrl: server.httpBaseUrl,
          wsBaseUrl: server.httpBaseUrl.replace(/^http/, "ws"),
        }),
        profile: Option.none(),
        enabled: true,
      },
      { initiallyDesired: true },
    ),
  ).pipe(
    Layer.provide(driverLayer(server)),
    Layer.provide(rpcSessionLayer({})),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never })),
    Layer.provide(Wakeups.layer({ changes: Stream.never })),
  );
  return Layer.mergeAll(
    supervisor,
    noCache,
    BoundedThreadSnapshotLoader.layer,
    ThreadHistoryController.layer,
    SecureRandom.layerWebCrypto,
  ).pipe(Layer.provideMerge(FetchHttpClient.layer));
};
