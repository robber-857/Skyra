import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";
import { describe, beforeAll, test, expect } from "vitest";
import { buildFunction, getFunctionInfo, loadSchema, loadInputQuery, loadFixture, validateTestAssets, runFunction } from "@shopify/shopify-function-test-helpers";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

describe("Monthly Pass checkout validation", () => {
  let schema;
  let functionDir;
  let functionInfo;
  let schemaPath;
  let targeting;
  let functionRunnerPath;
  let wasmPath;

  beforeAll(async () => {
    functionDir = path.dirname(testsDir);
    await buildFunction(functionDir);
    functionInfo = await getFunctionInfo(functionDir);
    ({ schemaPath, functionRunnerPath, wasmPath, targeting } = functionInfo);
    schema = await loadSchema(schemaPath);
  }, 180000);

  const fixturesDir = path.join(testsDir, "fixtures");
  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => path.join(fixturesDir, file));

  fixtureFiles.forEach((fixtureFile) => {
    test(`runs ${path.relative(fixturesDir, fixtureFile)}`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const rawInputPath = path.join(testsDir, "inputs", path.basename(fixtureFile));
      expect(fs.existsSync(rawInputPath)).toBe(true);
      const payload = JSON.parse(fs.readFileSync(fixtureFile, "utf8")).payload;
      expect(JSON.parse(fs.readFileSync(rawInputPath, "utf8"))).toEqual(payload.input);
      const targetInputQueryPath = targeting[fixture.target].inputQueryPath;
      const inputQueryAST = await loadInputQuery(targetInputQueryPath);

      const validationResult = await validateTestAssets({ schema, fixture, inputQueryAST });
      expect(validationResult.inputQuery.errors).toEqual([]);
      expect(validationResult.inputFixture.errors).toEqual([]);
      expect(validationResult.outputFixture.errors).toEqual([]);

      const runResult = await runFunction(fixture, functionRunnerPath, wasmPath, targetInputQueryPath, schemaPath);
      expect(runResult.error).toBeNull();
      expect(runResult.result.output).toEqual(fixture.expectedOutput);
    }, 10000);
  });
});
