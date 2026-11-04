import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "./errors.js";

export interface IdentityState {
  formatVersion: 1;
  origin: string;
  agentId: string | null;
  credential: string | null;
  privateKey: string;
  handle: string;
  displayName: string;
  description: string | null;
  nextPrivateKey?: string;
}
export class IdentityStore {
  readonly directory: string;
  readonly file: string;
  constructor(
    readonly origin: string,
    profile = "default",
    directory?: string,
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile))
      throw new CliError("invalid_input", "Invalid profile name.");
    const root =
      directory ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "nobodyasked",
      );
    this.directory = resolve(
      root,
      createHash("sha256").update(origin).digest("hex").slice(0, 24),
      profile,
    );
    this.file = join(this.directory, "identity.json");
  }
  async read(): Promise<IdentityState | null> {
    try {
      await this.check(this.directory, true);
      await this.check(this.file, false);
      const state = JSON.parse(
        await readFile(this.file, "utf8"),
      ) as IdentityState;
      if (
        state.formatVersion !== 1 ||
        state.origin !== this.origin ||
        typeof state.privateKey !== "string" ||
        typeof state.handle !== "string" ||
        !(state.agentId === null || typeof state.agentId === "string") ||
        !(state.credential === null || typeof state.credential === "string")
      )
        throw new CliError(
          "invalid_state",
          "The identity state is not valid for this origin.",
          4,
        );
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof CliError) throw error;
      throw new CliError(
        "storage_error",
        "Could not read the identity state.",
        4,
      );
    }
  }
  async write(state: IdentityState): Promise<void> {
    await this.check(this.directory, true);
    const temp = join(this.directory, `.identity-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.file);
    } catch {
      throw new CliError(
        "storage_error",
        "Could not save identity state. Keep the profile directory for recovery.",
        4,
      );
    } finally {
      await rm(temp, { force: true });
    }
  }
  async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.check(this.directory, true);
    const lock = join(this.directory, ".lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new CliError(
        "state_locked",
        "Another process owns this profile. If it stopped, inspect and remove only this profile's .lock directory.",
        4,
      );
    }
    try {
      return await work();
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  private async check(path: string, directory: boolean) {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile())
    )
      throw new CliError(
        "unsafe_storage",
        "Identity storage must use regular files and directories.",
        4,
      );
    if (
      process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()))
    )
      throw new CliError(
        "unsafe_storage",
        "Identity storage must be owned by this user and accessible only to this user.",
        4,
      );
  }
}
