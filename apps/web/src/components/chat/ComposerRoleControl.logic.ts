import type { AgentRole, ProviderInstanceId } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";

type RoleModelEntry = Pick<
  ProviderInstanceEntry,
  "instanceId" | "driverKind" | "enabled" | "isAvailable" | "isDefault" | "models"
>;

/**
 * The provider instance and model a role names, when an available instance offers that model.
 * `provider` matches an instance id before a driver kind, and the default instance breaks ties.
 * `model` matches a slug or alias.
 */
export function resolveAgentRoleModelSelection(
  role: Pick<AgentRole, "provider" | "model">,
  entries: ReadonlyArray<RoleModelEntry>,
): { readonly instanceId: ProviderInstanceId; readonly model: string } | null {
  const model = role.model?.trim();
  if (!model) return null;
  const provider = role.provider?.trim();
  const rank = (entry: RoleModelEntry) =>
    (entry.instanceId === provider ? 2 : 0) + (entry.isDefault ? 1 : 0);
  const ordered = entries
    .filter(
      (entry) =>
        entry.enabled &&
        entry.isAvailable &&
        (!provider || entry.instanceId === provider || entry.driverKind === provider),
    )
    .toSorted((a, b) => rank(b) - rank(a));
  for (const entry of ordered) {
    const match = entry.models.find(
      (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
    );
    if (match) return { instanceId: entry.instanceId, model: match.slug };
  }
  return null;
}
