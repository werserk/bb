import type { PlacementRuntimeRootIdentity } from "../../src/types.js";

export function fixtureRootKey(identity: PlacementRuntimeRootIdentity) {
  return `fixture-root:${identity.workerId}:${identity.generation}`;
}

export function fixtureLaunchProfileId(identity: {
  workerId: string;
  generation: string;
}) {
  return `fixture-profile:${identity.workerId}:${identity.generation}`;
}
