// ADVERSUM: keeps the fork's translation keys in step across all locales.
//
// We maintain the `adversum` namespace by hand in en.json and de.json only.
// `npm run i18n:check` requires identical keys in all six files, so this script
// copies the English text into sk/cs/uk/es for every `adversum.*` key that is
// missing there, and drops keys that no longer exist in English. Existing
// translations in those files are kept.
//
// Usage: node scripts/adversum/i18n-sync.mjs [--overwrite]
//
// `--overwrite` replaces the whole namespace in those four files with the
// English text. Use it after changing the wording of an existing English key,
// which would otherwise keep its old copy there.
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const localesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/shared/i18n/locales",
);
const NAMESPACE = "adversum";
const FOLLOWERS = ["sk", "cs", "uk", "es"];

function read(lang) {
  return JSON.parse(readFileSync(resolve(localesDir, `${lang}.json`), "utf-8"));
}

const overwrite = process.argv.includes("--overwrite");

function syncNode(reference, current) {
  if (typeof reference !== "object" || reference === null) {
    return typeof current === "string" && !overwrite ? current : reference;
  }
  const source =
    typeof current === "object" && current !== null ? current : {};
  return Object.fromEntries(
    Object.entries(reference).map(([key, value]) => [
      key,
      syncNode(value, source[key]),
    ]),
  );
}

const reference = read("en")[NAMESPACE];
if (!reference) {
  console.error(`en.json has no "${NAMESPACE}" namespace.`);
  process.exit(1);
}

for (const lang of FOLLOWERS) {
  const data = read(lang);
  data[NAMESPACE] = syncNode(reference, data[NAMESPACE]);
  writeFileSync(
    resolve(localesDir, `${lang}.json`),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  console.log(`${lang}.json: ${NAMESPACE} namespace synced`);
}
