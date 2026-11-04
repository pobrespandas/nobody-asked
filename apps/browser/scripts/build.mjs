import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const outputDirectory = resolve(repositoryDirectory, "dist/browser");
const templatePath = resolve(packageDirectory, "static/index.html");
const entryPath = resolve(packageDirectory, "src/main.ts");
const skillPath = resolve(
  repositoryDirectory,
  ".agents/skills/nobody-asked/SKILL.md",
);

assertOutputDirectory();
await rm(outputDirectory, { force: true, recursive: true });

const result = await build({
  absWorkingDir: repositoryDirectory,
  bundle: true,
  charset: "utf8",
  entryNames: "assets/browser-[hash]",
  entryPoints: [entryPath],
  format: "esm",
  legalComments: "none",
  metafile: true,
  minify: true,
  outdir: outputDirectory,
  platform: "browser",
  sourcemap: false,
  target: ["es2023"],
  treeShaking: true,
});

const scriptPath = findEntrypoint(result.metafile.outputs);
const template = await readFile(templatePath, "utf8");
const styleModule = await build({
  entryPoints: [resolve(packageDirectory, "src/styles.ts")],
  bundle: true,
  format: "esm",
  write: false,
});
const { browserStyles } = await import(
  `data:text/javascript;base64,${Buffer.from(styleModule.outputFiles[0].text).toString("base64")}`
);
const document = template
  .replace("__BROWSER_SCRIPT__", `/${scriptPath}`)
  .replace("__BROWSER_STYLES__", browserStyles);

if (document === template) {
  throw new Error("The browser script placeholder is missing.");
}

await writeFile(resolve(outputDirectory, "index.html"), document, "utf8");
const publicSkillDirectory = resolve(outputDirectory, "skills/nobody-asked");
await mkdir(publicSkillDirectory, { recursive: true });
await copyFile(skillPath, resolve(publicSkillDirectory, "SKILL.md"));

function findEntrypoint(outputs) {
  const match = Object.entries(outputs).find(
    ([, metadata]) =>
      metadata.entryPoint &&
      resolve(repositoryDirectory, metadata.entryPoint) === entryPath,
  );
  if (!match) throw new Error("The browser entrypoint was not emitted.");

  const path = relative(
    outputDirectory,
    resolve(repositoryDirectory, match[0]),
  );
  if (path.startsWith("..")) {
    throw new Error("The browser entrypoint escaped the output directory.");
  }
  return path.split("\\").join("/");
}

function assertOutputDirectory() {
  const expected = resolve(repositoryDirectory, "dist/browser");
  if (outputDirectory !== expected) {
    throw new Error("The browser output directory is invalid.");
  }
}
