import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const docsDir = path.join(root, "docs");
const assetsDir = path.join(docsDir, "assets");
const dataDir = path.join(docsDir, "data");

await mkdir(assetsDir, { recursive: true });
await rm(assetsDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });
const dataScriptTags = await writeDataBundle();
const appVersion = await hashAppSources();

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  outfile: path.join(assetsDir, "app.js"),
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: {
    __SICHERE_KNOTEN_APP_VERSION__: JSON.stringify(appVersion)
  }
});

const sourceHtml = await readFile(path.join(root, "index.html"), "utf8");
const docsHtml = sourceHtml
  .replace("  </head>", '    <link rel="stylesheet" href="./assets/app.css" />\n  </head>')
  .replace(
    '    <script type="module" src="/src/main.ts"></script>',
    `${dataScriptTags.map((fileName) => `    <script src="./assets/${fileName}"></script>`).join("\n")}\n    <script src="./assets/app.js"></script>`
  );

await writeFile(path.join(docsDir, "index.html"), docsHtml);
await copyFile(path.join(root, "favicon.svg"), path.join(docsDir, "favicon.svg"));

async function writeDataBundle() {
  const files = await csvFiles();
  const scriptFileNames = ["data-manifest.js"];
  const dataVersion = await hashFiles(files);

  await writeFile(
    path.join(assetsDir, "data-manifest.js"),
    `globalThis.__SICHERE_KNOTEN_DATA__={version:${JSON.stringify(dataVersion)},files:[]};\n`
  );
  for (const file of files) {
    const bytes = await readFile(file.sourcePath);
    const compressed = gzipSync(bytes, { level: 9 });
    const bundledFile = {
      path: file.publicPath,
      name: path.basename(file.publicPath),
      type: file.type,
      encoding: "gzip-base64",
      size: bytes.byteLength,
      compressedSize: compressed.byteLength,
      chunks: chunkString(compressed.toString("base64"), 256 * 1024)
    };
    const scriptFileName = `data-${scriptFileNames.length}.js`;
    const script = `globalThis.__SICHERE_KNOTEN_DATA__=globalThis.__SICHERE_KNOTEN_DATA__||{version:${JSON.stringify(dataVersion)},files:[]};globalThis.__SICHERE_KNOTEN_DATA__.files.push(${JSON.stringify(bundledFile)});\n`;
    await writeFile(path.join(assetsDir, scriptFileName), script);
    scriptFileNames.push(scriptFileName);
  }

  return scriptFileNames;
}

async function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file.sourcePath);
    hash.update(file.publicPath);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function hashAppSources() {
  const files = [
    ...(await sourceFiles(path.join(root, "src"))),
    path.join(root, "index.html"),
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
    path.join(root, "scripts/build-docs.mjs")
  ].sort();
  const hash = createHash("sha256");

  for (const file of files) {
    const bytes = await readFile(file);
    hash.update(path.relative(root, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function csvFiles() {
  const csvDir = path.join(dataDir, "csv");
  const entries = await readdir(csvDir);
  const files = [];

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".csv")) {
      continue;
    }
    const sourcePath = path.join(csvDir, entry);
    if (!(await stat(sourcePath)).isFile()) {
      continue;
    }
    files.push({
      sourcePath,
      publicPath: `data/csv/${entry}`,
      type: "text/csv"
    });
  }

  return files;
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}
