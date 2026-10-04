import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import {
  classifyTestCliFailure,
  createTestCliGraphql,
  TEST_SYNC_HANDLE_READ,
  TEST_SYNC_IDENTITY,
} from "../scripts/membership-sync-test-pass";
import {
  MAPPING_READ,
  PRODUCT_SET,
} from "../app/services/shopify-catalog.server";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execMock }));
// These tests never open a database connection or create/clean a DB fixture.
vi.mock("../app/db.server", () => ({ default: {} }));

beforeEach(() => {
  execMock.mockReset();
});

test.each([
  [{ code: "EPERM" }, "EXECUTE", "", "CLI_OS_PERMISSION"],
  [
    { code: 1 },
    "EXECUTE",
    "Error: EPERM: operation not permitted, realpath",
    "CLI_OS_PERMISSION",
  ],
  [
    { killed: true, signal: "SIGTERM", code: null },
    "EXECUTE",
    "",
    "CLI_TIMEOUT",
  ],
  [
    { killed: true, signal: "SIGKILL" },
    "EXECUTE",
    "",
    "CLI_PROCESS_TERMINATED",
  ],
  [
    { name: "AbortError", code: "ABORT_ERR", killed: true },
    "EXECUTE",
    "",
    "CLI_ABORTED",
  ],
  [{ code: "ENOENT" }, "EXECUTE", "", "CLI_RUNTIME_MISSING"],
  [{ code: "ENOENT" }, "READ_RESPONSE", "", "CLI_RESPONSE_MISSING"],
  [{ name: "SyntaxError" }, "READ_RESPONSE", "", "CLI_RESPONSE_INVALID_JSON"],
  [{}, "VALIDATE_RESPONSE", "", "CLI_RESPONSE_REJECTED_OR_INCOMPLETE"],
  [{ code: 2 }, "EXECUTE", "", "CLI_EXIT_NONZERO"],
] as const)(
  "classifies bounded CLI failure metadata %j / %s",
  (error, phase, stderr, category) => {
    expect(classifyTestCliFailure(error, phase, stderr).category).toBe(
      category,
    );
  },
);

test("failure metadata excludes error messages, commands, stack traces, and unsafe codes", () => {
  const metadata = classifyTestCliFailure(
    {
      message: "private-token-should-not-be-retained",
      command: "private-command",
      stack: "private-stack",
      code: "unsafe private code",
      signal: "unsafe signal",
    },
    "EXECUTE",
    "",
  );
  expect(metadata).toEqual({
    category: "CLI_OPERATION_FAILED",
    phase: "EXECUTE",
    errorCode: null,
    killed: false,
    signal: null,
  });
  expect(JSON.stringify(metadata)).not.toContain("private");
});

test.each([
  [TEST_SYNC_IDENTITY, 30000, {}],
  [TEST_SYNC_HANDLE_READ, 30000, {}],
  [MAPPING_READ, 12000, {}],
  [PRODUCT_SET, 12000, { input: { status: "DRAFT" } }],
])(
  "uses a bounded preparation-read timeout without extending transaction operations",
  async (query, timeoutMs, variables) => {
    const directory = resolve(
      "D:/Skyra/output/membership-sync-cli-error-evidence",
      randomUUID(),
    );
    execMock.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(new Error("unretained sensitive exception message"), {
          killed: true,
          signal: "SIGTERM",
          code: null,
        }),
        "",
        "",
      );
      return {};
    });
    const graphql = createTestCliGraphql(directory, async () => {});
    await expect(
      graphql(query as string, { variables, tries: 9 }),
    ).rejects.toThrow("No automatic retry");
    expect(execMock).toHaveBeenCalledOnce();
    expect(execMock.mock.calls[0][2].timeout).toBe(timeoutMs);
    const raw = await fs.readFile(
      resolve(directory, "01.failure.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toMatchObject({
      category: "CLI_TIMEOUT",
      phase: "EXECUTE",
      killed: true,
      signal: "SIGTERM",
      timeoutMs,
      automaticRetry: false,
      elapsedMs: expect.any(Number),
    });
    expect(raw).not.toContain("sensitive");
  },
);
