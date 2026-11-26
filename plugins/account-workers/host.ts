import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { accountWorkersHostContract } from "./contract.js";
import {
  diffOp,
  editOp,
  execOp,
  globOp,
  grepOp,
  guarded,
  killAllGroups,
  readOp,
  resolveRoot,
  writeOp,
} from "./ops.js";
import { prepareScratch } from "./scratch.js";

export default experimental_defineHostEntry({
  contract: accountWorkersHostContract,
  handlers: {
    resolveRoot: (input) => guarded(() => resolveRoot(input)),
    prepareScratch: (input) => guarded(() => prepareScratch(input)),
    read: (input) => guarded(() => readOp(input)),
    write: (input) => guarded(() => writeOp(input)),
    edit: (input) => guarded(() => editOp(input)),
    glob: (input) => guarded(() => globOp(input)),
    grep: (input, ctx) => guarded(() => grepOp(input, ctx.signal)),
    diff: (input, ctx) => guarded(() => diffOp(input, ctx.signal)),
    exec: (input, ctx) => guarded(() => execOp(input, ctx.signal)),
  },
  dispose: killAllGroups,
});
