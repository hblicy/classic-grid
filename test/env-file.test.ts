import assert from "node:assert/strict";
import test from "node:test";
import { writeEnvFile } from "../src/envFile.js";

test("writeEnvFile atomically renames a same-directory temporary file", () => {
  const calls: string[] = [];
  const fake = {
    existsSync: () => true,
    readFileSync: () => "OLD=yes\n",
    writeFileSync: (file: string) => calls.push(`write:${file}`),
    chmodSync: (file: string) => calls.push(`chmod:${file}`),
    renameSync: (from: string, to: string) => calls.push(`rename:${from}->${to}`),
    unlinkSync: (file: string) => calls.push(`unlink:${file}`),
  };

  writeEnvFile("C:/app/.env", "NEW=yes\n", {
    fsImpl: fake as any,
    platform: "linux",
  });

  assert.match(calls[0]!, /^write:C:\/app\/\.env\.tmp-/);
  assert.ok(calls.some((call) => /rename:.*->C:\/app\/\.env$/.test(call)));
  assert.match(calls.at(-1)!, /rename:.*->C:\/app\/\.env$/);
});

test("writeEnvFile preserves the target when temporary writing fails", () => {
  let target = "OLD=yes\n";
  const files = new Map<string, string>();
  const fake = {
    existsSync: (file: string) => file === "C:/app/.env" || files.has(file),
    readFileSync: () => target,
    writeFileSync: (file: string, content: string) => {
      if (file !== "C:/app/.env") {
        files.set(file, content.slice(0, 3));
        throw new Error("disk full");
      }
      target = content;
    },
    chmodSync: () => {},
    renameSync: (from: string) => {
      target = files.get(from)!;
    },
    unlinkSync: (file: string) => {
      files.delete(file);
    },
  };

  assert.throws(
    () =>
      writeEnvFile("C:/app/.env", "NEW=yes\n", {
        fsImpl: fake as any,
        platform: "linux",
      }),
    /disk full/
  );
  assert.equal(target, "OLD=yes\n");
  assert.equal(files.size, 0);
});
