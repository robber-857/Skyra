import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import db from "../app/db.server";
import { DomainError } from "../app/lib/errors.server";
import { importMindbody } from "../app/services/mindbody-import.server";
import { PRODUCTION_BOOKING_SHOP } from "../app/services/commerce-capabilities.server";

try {
  const args = process.argv.slice(2);
  const allowed = new Set([
    "--file",
    "--shop",
    "--actor",
    "--backup-reference",
    "--apply",
    "--dry-run",
    "--cutoff-approved",
  ]);
  const flags = new Set(["--apply", "--dry-run", "--cutoff-approved"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag) || values.has(flag))
      throw new Error("INVALID_ARGUMENTS");
    const value = flags.has(flag) ? "true" : args[++i];
    if (!value || value.startsWith("--")) throw new Error("INVALID_ARGUMENTS");
    values.set(flag, value);
  }
  if (
    values.get("--shop") !== PRODUCTION_BOOKING_SHOP ||
    !values.get("--file") ||
    !values.get("--actor") ||
    (values.has("--apply") && values.has("--dry-run"))
  )
    throw new Error("EXPLICIT_PRODUCTION_TARGET_REQUIRED");
  const path = await realpath(resolve(values.get("--file")!));
  const repo = await realpath(resolve(import.meta.dirname, "../.."));
  const inside = relative(repo, path);
  if (!inside.startsWith("..") && !isAbsolute(inside))
    throw new Error("PRIVATE_INPUT_MUST_BE_OUTSIDE_REPOSITORY");
  const result = await importMindbody(
    JSON.parse(await readFile(path, "utf8")),
    {
      apply: values.has("--apply"),
      actorId: values.get("--actor")!,
      backupReference: values.get("--backup-reference"),
      cutoffApproved: values.has("--cutoff-approved"),
    },
  );
  console.log(JSON.stringify(result));
} catch (error) {
  // Never print Prisma messages, Zod issues, raw input or customer identifiers.
  console.error(
    JSON.stringify({
      status: "FAILED",
      code:
        error instanceof DomainError
          ? error.code
          : "MIGRATION_INPUT_OR_COMMAND_INVALID",
    }),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
