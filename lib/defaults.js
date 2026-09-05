// dshpkg — built-in recommended recipe repositories (R5, design §3.1).
// `dshpkg repo init` adds these on first use. The default source is dshpkg's
// OWN repository (serverless, no extra infra): its `recipes/*.json` files are
// the recipe payload, so the package self-bootstraps once pushed to origin.
// DSH_DEFAULT_REPOS (a JSON array of {url, name, format}) overrides it for
// tests and custom installs.

const PLACEHOLDER = [
  {
    url: "https://github.com/sentence-mang/dshpkg",
    name: "dshpkg",
    format: "git",
  },
];

/** Default repos for `dshpkg repo init` (env-overridable, read per call so
 * tests can inject without import-order tricks). */
export function defaultRepos() {
  const raw = process.env.DSH_DEFAULT_REPOS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // malformed env falls through to the placeholder
    }
  }
  return PLACEHOLDER;
}
