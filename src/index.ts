export type * from "./types.js";
export { listAgentTrees, spawnContainedAgent, killAgentTree } from "./manager.js";
export { getAcceleratorSnapshot } from "./accelerators.js";
export type { AcceleratorProvider, RawEngineSample } from "./accelerators.js";
export { resolveGitWorktree } from "./git.js";
export { probeLemonade } from "./backend.js";
export { startDaemon } from "./daemon.js";
export { ROLE_ORDER, ROLE_INFO, roleCatalog, classifyTreeRoles } from "./roles.js";
