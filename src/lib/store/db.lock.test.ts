import "../__tests__/setup";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __resetConfig } from "../config";
import { __resetDb, db, migrate } from "./db";

/**
 * Regression for the Nov 6 production 500s: another process (the workers) holding the SQLite
 * write lock made the app's writes fail at once with SQLITE_BUSY. A child process holds the lock
 * for ~700 ms; with the busy timeout our write waits and succeeds, without it it fails.
 */
function holdLock(file: string, ms: number): Promise<{ released: Promise<void> }> {
  const script = `
    const { createClient } = require("@libsql/client");
    const c = createClient({ url: "file:" + process.argv[1] });
    (async () => {
      await c.execute("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
      const tx = await c.transaction("write");
      await tx.execute("INSERT INTO t VALUES (1)");
      process.stdout.write("locked\\n");
      await new Promise((r) => setTimeout(r, Number(process.argv[2])));
      await tx.commit();
      c.close();
    })();`;
  const child = spawn(process.execPath, ["-e", script, file, String(ms)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  const released = new Promise<void>((r) => child.on("exit", () => r()));
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("locked")) resolve({ released }); });
    child.on("error", reject);
  });
}

function useFile(timeoutMs: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "complir-lock-")), "lock.db");
  process.env.DATABASE_URL = `file:${file}`;
  process.env.DB_BUSY_TIMEOUT_MS = timeoutMs;
  __resetConfig(); __resetDb();
  return file;
}

afterEach(() => {
  process.env.DATABASE_URL = ":memory:";
  delete process.env.DB_BUSY_TIMEOUT_MS;
  __resetConfig(); __resetDb();
});

describe("SQLite shared by several processes", () => {
  it("waits for another process's write lock instead of failing (busy timeout)", async () => {
    const file = useFile("5000");
    await migrate();
    await db().execute("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
    const { released } = await holdLock(file, 700);
    const t0 = Date.now();
    await db().execute("INSERT INTO t VALUES (2)");
    expect(Date.now() - t0).toBeGreaterThan(300); // it waited for the lock
    await released;
    const r = await db().execute("SELECT COUNT(*) AS n FROM t");
    expect(Number((r.rows[0] as Record<string, unknown>).n)).toBe(2);
  }, 20_000);

  it("fails at once with SQLITE_BUSY when the timeout is 0 (the old behaviour)", async () => {
    const file = useFile("0");
    await db().execute("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
    const { released } = await holdLock(file, 700);
    await expect(db().execute("INSERT INTO t VALUES (2)")).rejects.toThrow(/SQLITE_BUSY|database is locked/);
    await released;
  }, 20_000);

  it("switches a file database to WAL on migrate", async () => {
    useFile("5000");
    await migrate();
    const r = await db().execute("PRAGMA journal_mode");
    expect(String(Object.values(r.rows[0] as Record<string, unknown>)[0]).toLowerCase()).toBe("wal");
  });
});
