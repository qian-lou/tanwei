import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Export the same catalog consumed by TypeScript tests. Unsupported Zod checks
// fail the build instead of silently dropping a Host validation rule.
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "tanwei-contracts-"));
try {
  const modulePath = path.join(temporary, "catalog.mjs");
  await build({entryPoints:[path.join(root,"apps/desktop/src/shared/action-catalog.ts")],bundle:true,platform:"node",format:"esm",outfile:modulePath});
  const { ACTION_CONTRACT_CATALOG } = await import(pathToFileURL(modulePath).href);
  const contracts = Object.fromEntries([...ACTION_CONTRACT_CATALOG].map(([actionId, contract]) => [actionId, {
    actionId, contractVersion: "1.0", riskLevel: contract.riskLevel,
    requiredCapability: contract.requiredCapability,
    parameters: schema(contract.parameters, actionId, ""),
  }]));
  const output = path.join(root, "apps/desktop/src-tauri/src/action-contracts.json");
  const content = JSON.stringify(contracts, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (await readFile(output,"utf8") !== content) throw new Error("Rust Action contracts are stale; run npm run contracts:sync");
  } else await writeFile(output,content);
  console.log(`Verified ${Object.keys(contracts).length} Rust Action contracts.`);
  const reportModule = path.join(temporary,"report.mjs");
  await build({stdin:{contents:'export * from "./profile-report-adapter.ts"; export * from "./app-fonts.ts";',resolveDir:path.join(root,"apps/desktop/src/shared"),loader:"ts"},bundle:true,platform:"node",format:"esm",outfile:reportModule});
  const report = await import(pathToFileURL(reportModule).href);
  const template = report.profileReportAdapterScript("__TANWEI_TITLE__","__TANWEI_NAME__").replaceAll(report.getAppFontStack("SYSTEM"),"__TANWEI_FONT__");
  const reportAssets = JSON.stringify({template,fonts:Object.fromEntries(report.APP_FONT_FAMILY_VALUES.map(font=>[font,report.getAppFontStack(font)]))},null,2)+"\n";
  const reportOutput = path.join(root,"apps/desktop/src-tauri/src/report-assets.json");
  if (process.argv.includes("--check")) {
    if (await readFile(reportOutput,"utf8") !== reportAssets) throw new Error("Rust report assets are stale");
  } else await writeFile(reportOutput,reportAssets);
} finally { await rm(temporary,{recursive:true,force:true}); }

function schema(value, action, field) {
  const definition = value._zod.def;
  if (definition.type === "optional") return {...schema(definition.innerType,action,field), optional:true};
  if (definition.type === "pipe") return schema(definition.in,action,field);
  if (definition.type === "union") return {type:"union",options:definition.options.map(option=>schema(option,action,field))};
  if (definition.type === "enum") return {type:"string",values:Object.values(definition.entries)};
  if (definition.type === "literal") return {type:"string",values:definition.values};
  if (!["object","string"].includes(definition.type)) throw new Error(`Unsupported schema type ${definition.type}`);
  const result = {type:definition.type,checks:[]};
  if (definition.type === "object") result.properties = Object.fromEntries(Object.entries(value.shape).map(([key,child])=>[key,schema(child,action,key)]));
  for (const check of definition.checks ?? []) {
    const def = check._zod.def;
    if (def.check === "min_length") result.checks.push({kind:"min",value:def.minimum});
    else if (def.check === "max_length") result.checks.push({kind:"max",value:def.maximum});
    else if (def.check === "string_format" && def.pattern) result.checks.push({kind:"pattern",value:def.pattern.source});
    else if (def.check === "overwrite") {
      if (def.tx(" x ") !== "x" || def.tx("a b") !== "a b") throw new Error("Unsupported string normalization");
      result.checks.push({kind:"trim"});
    } else if (def.check === "custom") {
      if (!def.fn) {
        if (definition.type === "object") result.checks.push({kind:"action",value:action});
        else if (["includeRules","excludeRules"].includes(field)) result.checks.push({kind:"traceRules"});
        else if (action === "perfcounter.snapshot") result.checks.push({kind:"counterNames"});
        else throw new Error(`Unmapped refinement ${action}.${field}`);
      } else {
        const message = def.error?.({}) ?? "";
        const range = /^值必须介于 (\d+) 与 (\d+) 之间$/.exec(message);
        if (range) result.checks.push({kind:"integer",minimum:Number(range[1]),maximum:Number(range[2])});
        else if (message.includes("不能包含换行符")) result.checks.push({kind:"singleLine"});
        else if (message.includes("不能包含控制字符")) result.checks.push({kind:"noControl"});
        else if (message.includes("不能包含空字符")) result.checks.push({kind:"noNul"});
        else {
          const rules = {
            "不允许追踪 JDK 包":"nonJdkScope",
            "Profiler 过滤器仅支持最多 8 个首尾通配模式":"profilerRules",
            "资源名必须是无路径穿越的 ClassLoader 相对名称":"resourceName",
            "不支持的观测条件表达式":"observationCondition",
            "至少选择一个有效的观测时机":"phases",
          };
          if (!rules[message]) throw new Error(`Unmapped refinement ${action}.${field}: ${message}`);
          result.checks.push({kind:rules[message]});
        }
      }
    } else throw new Error(`Unsupported Zod check ${def.check}`);
  }
  return result;
}
