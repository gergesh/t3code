import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("../lib/runtime", async () => {
  const Layer = await import("effect/Layer");
  return {
    runtime: { runPromise: vi.fn() },
    layer: Layer.empty,
  };
});

import { createMobilePreferencesState } from "./preferences";
import * as MobilePreferences from "../persistence/mobile-preferences";
import * as MobileDatabase from "../persistence/mobile-database";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => {
    resolve = resume;
  });
  return { promise, resolve } as const;
}

function makePreferencesState(
  service: Omit<MobilePreferences.MobilePreferencesStore["Service"], "update"> &
    Partial<Pick<MobilePreferences.MobilePreferencesStore["Service"], "update">>,
) {
  const completeService = MobilePreferences.MobilePreferencesStore.of({
    ...service,
    update:
      service.update ??
      ((transform) =>
        service.load.pipe(
          Effect.flatMap((current) => service.savePatch(transform(current))),
          Effect.mapError((cause) =>
            cause._tag === "MobilePreferencesSaveError"
              ? cause
              : new MobilePreferences.MobilePreferencesSaveError({ cause }),
          ),
        )),
  });
  return createMobilePreferencesState(
    Atom.runtime(Layer.succeed(MobilePreferences.MobilePreferencesStore, completeService)),
  );
}

describe("mobile preferences state", () => {
  it.effect("persists repository fallback dismissals across preference-state remounts", () =>
    Effect.gen(function* () {
      const repository = JSON.stringify(["environment", "/repo"]);
      const fingerprint = JSON.stringify(["Using Git.", null]);
      let saved: MobileDatabase.StoredPreferencesJson = {
        payload: JSON.stringify({ baseFontSize: 17 }),
        updatedAt: 1,
      };
      const unexpectedCacheOperation = Effect.die("Unexpected cache operation");
      const database = MobileDatabase.MobileDatabase.of({
        loadCache: () => unexpectedCacheOperation,
        listCache: () => unexpectedCacheOperation,
        saveCache: () => unexpectedCacheOperation,
        removeCache: () => unexpectedCacheOperation,
        clearCacheKind: () => unexpectedCacheOperation,
        clearEnvironmentCache: () => unexpectedCacheOperation,
        clearAllCaches: unexpectedCacheOperation,
        inspectCaches: unexpectedCacheOperation,
        loadPreferencesJson: Effect.sync(() => Option.some(saved)),
        savePreferencesJson: (payload, updatedAt) =>
          Effect.sync(() => {
            saved = { payload, updatedAt };
          }),
      });
      const secureItems = new Map<string, string>();
      const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
        getItem: (key) => Effect.sync(() => secureItems.get(key) ?? null),
        setItem: (key, value) =>
          Effect.sync(() => {
            secureItems.set(key, value);
          }),
        removeItem: (key) =>
          Effect.sync(() => {
            secureItems.delete(key);
          }),
      });
      const makeState = MobilePreferences.make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, database),
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, secureStorage),
        Effect.map((store) => makePreferencesState(store)),
      );
      const state = yield* makeState;
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);
      try {
        yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });
        registry.set(state.updatePreferencesAtom, {
          transform: (current) => ({
            dismissedVcsNotices: { ...current.dismissedVcsNotices, [repository]: fingerprint },
          }),
        });
        yield* AtomRegistry.getResult(registry, state.updatePreferencesAtom, {
          suspendOnWaiting: true,
        });
        expect(JSON.parse(saved.payload)).toEqual({
          baseFontSize: 17,
          dismissedVcsNotices: { [repository]: fingerprint },
        });
      } finally {
        unmountUpdate();
        unmountPreferences();
        registry.dispose();
      }
      const remounted = yield* makeState;
      const freshRegistry = AtomRegistry.make();
      const unmount = freshRegistry.mount(remounted.preferencesAtom);
      try {
        const reloaded = yield* AtomRegistry.getResult(freshRegistry, remounted.preferencesAtom, {
          suspendOnWaiting: true,
        });
        expect(reloaded.dismissedVcsNotices?.[repository]).toBe(fingerprint);
        expect(
          reloaded.dismissedVcsNotices?.[JSON.stringify(["environment", "/other"])],
        ).toBeUndefined();
      } finally {
        unmount();
        freshRegistry.dispose();
      }
    }),
  );

  it.effect("preserves an optimistic patch when the initial load finishes later", () =>
    Effect.gen(function* () {
      const pendingLoad = deferred<MobilePreferences.Preferences>();
      const savePatch = vi.fn((patch: Partial<MobilePreferences.Preferences>) =>
        Effect.succeed(patch),
      );
      const state = makePreferencesState({
        load: Effect.promise(() => pendingLoad.promise),
        savePatch,
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);

      registry.set(state.updatePreferencesAtom, {
        collapsedProjectGroups: ["project:new"],
      });
      pendingLoad.resolve({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:old"],
      });

      const preferences = yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      expect(preferences).toEqual({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:new"],
      });
      expect(savePatch).toHaveBeenCalledWith({
        collapsedProjectGroups: ["project:new"],
      });
      expect(AsyncResult.isFailure(registry.get(state.updatePreferencesAtom))).toBe(false);

      unmountUpdate();
      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("keeps both favorites when the React setter sends updates before a render", () =>
    Effect.gen(function* () {
      let persisted: MobilePreferences.Preferences = { modelFavorites: [] };
      const state = makePreferencesState({
        load: Effect.succeed(persisted),
        savePatch: (patch) =>
          Effect.sync(() => {
            persisted = { ...persisted, ...patch };
            return persisted;
          }),
        update: (transform) =>
          Effect.sync(() => {
            persisted = { ...persisted, ...transform(persisted) };
            return persisted;
          }),
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      const unmountUpdate = registry.mount(state.updatePreferencesAtom);
      yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });

      function useSavePreferences() {
        return useAtomSet(state.updatePreferencesAtom);
      }
      const setters: Array<ReturnType<typeof useSavePreferences>> = [];
      function CaptureSetter() {
        setters.push(useSavePreferences());
        return null;
      }
      // Use the React setter; registry.set bypasses bare-function update semantics.
      renderToString(
        createElement(RegistryContext.Provider, { value: registry }, createElement(CaptureSetter)),
      );
      const savePreferences = setters[0]!;
      const provider = ProviderInstanceId.make("codex");
      savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "astra" }],
        }),
      });
      savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "sol" }],
        }),
      });
      yield* AtomRegistry.getResult(registry, state.updatePreferencesAtom, {
        suspendOnWaiting: true,
      });

      expect(persisted.modelFavorites).toEqual([
        { provider, model: "astra" },
        { provider, model: "sol" },
      ]);

      savePreferences({
        transform: (current) => ({
          modelFavorites: (current.modelFavorites ?? []).filter(
            (favorite) => favorite.model !== "astra",
          ),
        }),
      });
      yield* AtomRegistry.getResult(registry, state.updatePreferencesAtom, {
        suspendOnWaiting: true,
      });
      expect(persisted.modelFavorites).toEqual([{ provider, model: "sol" }]);

      unmountUpdate();
      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("falls back to empty preferences when secure storage cannot be read", () =>
    Effect.gen(function* () {
      const state = makePreferencesState({
        load: Effect.fail(
          new MobilePreferences.MobilePreferencesLoadError({
            cause: new Error("secure storage unavailable"),
          }),
        ),
        savePatch: (patch) => Effect.succeed(patch),
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(state.preferencesAtom);

      expect(
        yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
          suspendOnWaiting: true,
        }),
      ).toEqual({});

      unmount();
      registry.dispose();
    }),
  );
});
