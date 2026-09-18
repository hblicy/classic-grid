import fs from "node:fs";

export type EnvFileSystem = Pick<
  typeof fs,
  "existsSync" | "readFileSync" | "writeFileSync" | "chmodSync"
>;

export function writeEnvFile(
  envFile: string,
  content: string,
  options: { fsImpl?: EnvFileSystem; platform?: NodeJS.Platform } = {}
): void {
  const fsImpl = options.fsImpl ?? fs;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && fsImpl.existsSync(envFile)) {
    fsImpl.chmodSync(envFile, 0o600);
  }
  fsImpl.writeFileSync(envFile, content, { encoding: "utf8", mode: 0o600 });
  if (platform !== "win32") fsImpl.chmodSync(envFile, 0o600);
}
