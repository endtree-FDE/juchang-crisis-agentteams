/**
 * 注册 `@/` 别名与 JSON import 的 ESM hooks。
 * 用法：node --import ./scripts/crisis-sim/register-ts-paths.mjs <entry>
 * `.ts` 由 Node 26 原生 type-stripping 处理，本 loader 只管别名与 JSON format。
 */
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrcRoot = path.resolve(here, "../../app/src");

register(new URL("./ts-paths-hooks.mjs", import.meta.url), {
  parentURL: import.meta.url,
  data: { appSrcRoot },
});
