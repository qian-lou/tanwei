import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const referenceRoot = path.join(projectRoot, "arthas");
const status = execFileSync("git", ["-C", referenceRoot, "status", "--porcelain"], {
  encoding: "utf8",
});

if (status.trim()) {
  throw new Error(
    `只读参考仓库存在改动，拒绝通过验证：\n${status.trim()}`,
  );
}

console.log("Reference repository is clean.");
