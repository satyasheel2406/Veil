import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "apps", "server");
const venvWin = path.join(serverDir, ".venv", "Scripts", "python.exe");
const venvNix = path.join(serverDir, ".venv", "bin", "python");
const venvPython = existsSync(venvWin) ? venvWin : existsSync(venvNix) ? venvNix : null;

function run(cmd, args, { cwd = serverDir, stdio = "inherit" } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function ensureVenv() {
  if (venvPython) return venvPython;
  console.log("[server] creating .venv ...");
  run("python", ["-m", "venv", path.join(serverDir, ".venv")], { cwd: root });
  if (!existsSync(venvWin) && !existsSync(venvNix)) {
    console.error("[server] venv created but python not found — is 'python' on PATH?");
    process.exit(1);
  }
  return existsSync(venvWin) ? venvWin : venvNix;
}

function install() {
  const py = ensureVenv();
  console.log("[server] installing requirements ...");
  run(py, ["-m", "pip", "install", "-r", path.join(serverDir, "requirements.txt")]);
  console.log("[server] ready. Start it with: npm run server:dev");
}

function dev() {
  const py = venvPython ?? ensureVenv();
  installDepsOnce(py);
  console.log("[server] uvicorn on ws://localhost:8765/ws  (Ctrl+C to stop)");
  const child = spawn(py, ["-m", "uvicorn", "app.main:app", "--reload", "--port", "8765"], {
    cwd: serverDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

let depsChecked = false;
function installDepsOnce(py) {
  if (depsChecked) return;
  depsChecked = true;
  const r = spawnSync(py, ["-c", "import fastapi, uvicorn, httpx"], {
    cwd: serverDir,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.log("[server] dependencies missing — installing ...");
    run(py, ["-m", "pip", "install", "-r", path.join(serverDir, "requirements.txt")]);
  }
}

function test() {
  const py = venvPython ?? ensureVenv();
  installDepsOnce(py);
  run(py, ["-m", "pytest", "tests", "-q"]);
}

const [, , cmd] = process.argv;
switch (cmd) {
  case "install":
    install();
    break;
  case "dev":
    dev();
    break;
  case "test":
    test();
    break;
  default:
    console.error("usage: node scripts/server.mjs <install|dev|test>");
    process.exit(1);
}
