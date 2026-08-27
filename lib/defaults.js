// dshpkg — built-in recommended recipe repositories (R5, design §3.1).
// `dshpkg repo init` adds these on first use. The community repo URL is a
// placeholder until the final URL is fixed; DSH_DEFAULT_REPOS (a JSON array
// of {url, name, format}) overrides it for tests and custom installs.

const PLACEHOLDER = [
  {
    url: "https://github.com/OWNER/dsh-community",
    name: "dsh-community",
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
