import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const docsDir = resolve(root, "docs");
const stateDir = resolve(root, ".tmp");
const pidFile = join(stateDir, "docs-server.pid");
const host = "127.0.0.1";
const port = 5173;

await mkdir(stateDir, { recursive: true });
await stopPreviousServer();
await ensureDocsBuildExists();
await startServer();

async function startServer() {
  const server = createServer((request, response) => {
    void serveRequest(request, response);
  });

  server.on("error", async (error) => {
    if (error && error.code === "EADDRINUSE") {
      const killed = await stopPortOwners();
      if (killed) {
        server.listen(port, host);
        return;
      }
    }
    throw error;
  });

  server.listen(port, host, async () => {
    await writeFile(pidFile, String(process.pid));
    console.log(`Serving docs/ at http://${host}:${port}/`);
  });

  const cleanup = async () => {
    await rm(pidFile, { force: true });
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
}

async function serveRequest(request, response) {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(docsDir, `.${requestedPath}`);

  if (!isInsideDocs(filePath)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    sendText(response, 404, "Not found");
    return;
  }

  if (fileStats.isDirectory()) {
    await serveFile(join(filePath, "index.html"), response);
    return;
  }
  await serveFile(filePath, response, fileStats);
}

async function serveFile(filePath, response, existingStats = null) {
  let fileStats = existingStats;
  try {
    fileStats ??= await stat(filePath);
    if (!fileStats.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }
  } catch {
    sendText(response, 404, "Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": fileStats.size,
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(response);
}

function isInsideDocs(filePath) {
  const rel = relative(docsDir, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sendText(response, status, message) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(message);
}

function contentType(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function ensureDocsBuildExists() {
  try {
    const indexStats = await stat(join(docsDir, "index.html"));
    if (indexStats.isFile()) {
      return;
    }
  } catch {
    // Fall through to a clear startup error.
  }
  throw new Error("docs/index.html is missing. Run npm run build before npm run dev.");
}

async function stopPreviousServer() {
  const pid = await readPidFile();
  if (!pid || pid === process.pid) {
    return;
  }
  if (!(await stopProcess(pid))) {
    await rm(pidFile, { force: true });
    return;
  }
  await waitForProcessExit(pid, 2000);
  await rm(pidFile, { force: true });
}

async function readPidFile() {
  try {
    const value = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function stopPortOwners() {
  const pids = (await listeningPids(port)).filter((pid) => pid !== process.pid);
  if (pids.length === 0) {
    return false;
  }
  await Promise.all(pids.map((pid) => stopProcess(pid)));
  await Promise.all(pids.map((pid) => waitForProcessExit(pid, 2000)));
  return true;
}

async function stopProcess(pid) {
  if (!isProcessRunning(pid)) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (isProcessRunning(pid) && Date.now() - startedAt < timeoutMs) {
    await delay(100);
  }
}

async function listeningPids(targetPort) {
  if (process.platform === "win32") {
    return listeningPidsWindows(targetPort);
  }
  return listeningPidsUnix(targetPort);
}

async function listeningPidsWindows(targetPort) {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { windowsHide: true });
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") {
        continue;
      }
      const localAddress = columns[1];
      const pid = Number.parseInt(columns[4], 10);
      if (localAddress.endsWith(`:${targetPort}`) && Number.isFinite(pid)) {
        pids.add(pid);
      }
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

async function listeningPidsUnix(targetPort) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN", "-t"]);
    return stdout
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
