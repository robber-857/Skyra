import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  PRODUCT_SET,
  METAFIELDS_SET,
  MAPPING_READ,
  METAOBJECT_UPSERT,
  METAOBJECT_DEFINITION_READ,
  METAOBJECT_DEFINITION_CREATE,
  CONTENT_READ,
} from "../app/services/shopify-catalog.server";
const validator = process.env.SHOPIFY_GRAPHQL_VALIDATOR;
if (!validator)
  throw new Error(
    "Set SHOPIFY_GRAPHQL_VALIDATOR to the installed Shopify AI Toolkit validate.mjs path.",
  );
for (const [name, query] of Object.entries({
  PRODUCT_SET,
  METAFIELDS_SET,
  MAPPING_READ,
  METAOBJECT_UPSERT,
  METAOBJECT_DEFINITION_READ,
  METAOBJECT_DEFINITION_CREATE,
  CONTENT_READ,
})) {
  writeFileSync("node_modules/.cache/booking-" + name + ".graphql", query);
  const result = spawnSync(
    process.execPath,
    [
      validator,
      "--file",
      "node_modules/.cache/booking-" + name + ".graphql",
      "--model",
      "gpt-6",
      "--client-name",
      "Codex",
      "--client-version",
      "6",
      "--artifact-id",
      "skyra-booking-" + name.toLowerCase(),
      "--revision",
      "1",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
