/**
 * ESM resolve/load hooks：让 node 直跑 app/src 下的 TS 源码时可解析 `@/` 别名
 * 与「无 with 属性的 JSON import」。仅服务 scripts/crisis-sim 的测试与实证脚本。
 *
 * 通过 register-ts-paths.mjs 注册；appSrcRoot 由注册方以 data 传入。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let appSrcRoot = null;

export async function initialize(data) {
  appSrcRoot = data?.appSrcRoot ?? null;
}

function aliasCandidates(specifier) {
  const rel = specifier.slice(2); // 去掉 "@/"
  const base = path.join(appSrcRoot, rel);
  if (path.extname(rel)) return [base];
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.json`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.json"),
  ];
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json") || context.format === "json") {
    // 绕过 ERR_IMPORT_ATTRIBUTE_MISSING：自行读文件并按 JSON 模块返回
    const source = readFileSync(fileURLToPath(url), "utf8");
    return { format: "json", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  if (appSrcRoot && specifier.startsWith("@/")) {
    for (const candidate of aliasCandidates(specifier)) {
      if (!existsSync(candidate)) continue;
      const url = pathToFileURL(candidate).href;
      if (candidate.endsWith(".json")) {
        // 显式声明 format: "json"，使无 with 属性的 JSON import 可用
        return { url, format: "json", shortCircuit: true };
      }
      return { url, shortCircuit: true };
    }
    throw new Error(`crisis-sim ts-paths: 无法解析别名 ${specifier}（root=${appSrcRoot}）`);
  }
  return nextResolve(specifier, context);
}
