import fs from "node:fs";

export type EnvFileSystem = Pick<
  typeof fs,
  | "existsSync"
  | "readFileSync"
  | "writeFileSync"
  | "chmodSync"
  | "renameSync"
  | "unlinkSync"
>;

export function writeEnvFile(
  envFile: string,
  content: string,
  options: { fsImpl?: EnvFileSystem; platform?: NodeJS.Platform } = {}
): void {
  const fsImpl = options.fsImpl ?? fs;
  const platform = options.platform ?? process.platform;
  const tempFile = `${envFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsImpl.writeFileSync(tempFile, content, { encoding: "utf8", mode: 0o600 });
    if (platform !== "win32") fsImpl.chmodSync(tempFile, 0o600);
    fsImpl.renameSync(tempFile, envFile);
  } catch (error) {
    try {
      if (fsImpl.existsSync(tempFile)) fsImpl.unlinkSync(tempFile);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "写入 .env 失败且临时文件清理失败"
      );
    }
    throw error;
  }
}
