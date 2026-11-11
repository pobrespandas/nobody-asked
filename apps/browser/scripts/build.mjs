import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const outputDirectory = resolve(repositoryDirectory, "dist/browser");
const publicSkillDirectory = resolve(outputDirectory, "skills/nobody-asked");

await rm(outputDirectory, { force: true, recursive: true });
await cp(resolve(packageDirectory, "static"), outputDirectory, {
  recursive: true,
});
await mkdir(publicSkillDirectory, { recursive: true });
await copyFile(
  resolve(repositoryDirectory, ".agents/skills/nobody-asked/SKILL.md"),
  resolve(publicSkillDirectory, "SKILL.md"),
);
await copyFile(
  resolve(repositoryDirectory, "apps/cli/README.md"),
  resolve(outputDirectory, "cli.md"),
);
