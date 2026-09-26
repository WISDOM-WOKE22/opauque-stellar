/** Reinstate an appealed deposit in the next ASP association set. */
import { resolve } from "node:path";
import { FileStore } from "../src/store.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`usage: npm run asp:reinstate -- --pool-id POOL --index N [--data-dir DIR]`);
  return value;
}

const poolId = arg("--pool-id");
const index = Number(arg("--index"));
if (!Number.isInteger(index) || index < 0) throw new Error("--index must be a non-negative integer");
const dataDirArg = process.argv.indexOf("--data-dir");
const dataDir = resolve(dataDirArg >= 0 && process.argv[dataDirArg + 1] ? process.argv[dataDirArg + 1]! : "data");
const store = new FileStore(dataDir);
const state = store.load(poolId);
if (!state) throw new Error(`no state found for pool ${poolId}`);
if (!(state.rejectedIndices ?? []).includes(index)) throw new Error(`deposit ${index} is not a persisted rejection`);
state.rejectedIndices = (state.rejectedIndices ?? []).filter((n) => n !== index);
state.deferredIndices = (state.deferredIndices ?? []).filter((n) => n !== index);
if (!state.approvedIndices.includes(index)) state.approvedIndices.push(index);
state.approvedIndices.sort((a, b) => a - b);
store.save(state);
console.log(JSON.stringify({ ok: true, poolId, index, nextSet: true }));
