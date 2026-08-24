# dshpkg — Module Contracts (parallel-branch interface agreement)

All branches implement against these contracts. Do NOT change a contract here
without coordinating; contract changes land on `main` first.

## Hard constraints (every module)

- Plain ESM JavaScript (`.js`, `"type": "module"`). No TypeScript build step.
- ZERO third-party runtime dependencies. Only `node:*` builtins and, inside the
  host, `@deepseek-ai/cordis` (peer). No npm installs in this repo.
- Shared helpers come from `lib/state.js` (already on main). Import them:
  `stateRoot`, `statePath`, `readState`, `writeState`, `appendIncident`,
  `readIncidents`, `readRepos`, `writeRepos`, `resolveProfileDir`,
  `writeJsonAtomic`, `readJson`, `listSnapshots`, `dshHome`, `pkgRoot`.
- Unit tests with `node --test tests/` only. Do NOT boot a live dsh profile
  from a test. Do NOT touch `~/.dsh/profiles/web` or the `dshpkg-poc` profile.
- Write tests against temp dirs (`fs.mkdtemp`) and the fixture contracts below.
- Comments in English (ecosystem idiom); user-facing CLI strings in Chinese.

## Verified kernel facts (from Phase 0 PoC on dsh 0.1.1-rc.2, Node 24.19, pnpm 11.22)

### Boot failure is fail-loud, exit code 1, message format FIXED

`failed to apply loader entry boot-crash-fixture (dshpkg-fixture-boot-crash): boot-crash fixture: intentional boot failure`

- Outer wrapper adds one nesting level: `failed to apply loader entry include (cordis:include): <inner>`.
- Full format regex for triage:

```
failed to (import|apply|dispose|rollback) loader entry (\S+) \(([^)]*)\): (.*)
```

capturing: stage, entry id, module name, detail. The INNERMOST match is the
culprit; the outermost names the include wrapper.

### Official CLI facts

- `dsh plugin --profile <name> add <spec>` forwards to pnpm; after success it
  reconciles `dsh.profile.bundles` (a dependency whose manifest declares
  `dsh.bundle.patch` joins the bundle layer list).
- **Local path specs MUST use the `link:` prefix**, otherwise pnpm registers
  the dependency under the directory basename and the official reconciler
  warns "declares no dsh.bundle" and does not add it to bundles.
  (`dsh plugin --profile x add "C:\abs\path"` FAILS bundle detection;
  `add "link:C:\abs\path"` works.)
- `dsh web` subcommand rejects parent options (`--profile`, `--patch`).
  Launcher flags go first, app args after: `dsh --profile <name> --port 3199`.
- `dsh --profile <name> --dump-config` prints the composed entry tree WITHOUT
  booting — the pre-boot validation primitive. Exit 0 = tree composes.
- `--patch <file>` adds a repeatable overlay after the profile layer
  (temporary patch for smoke tests; do not persist to cordis.patch.yml).
- The user patch layer is `<profile>/cordis.patch.yml`, a top-level YAML array
  of loader entries; `- id: <entryId>` + `  disabled: true` disables an entry
  (verified: disables the fixture and boot proceeds).
- dsh launcher runs from `node <npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js`.

### Cordis host facts

- Plugin shape: `export const name`, `export const inject = [...]` (optional),
  `export function apply(ctx) {}`. A throw inside `apply` = the boot failure above.
- `ctx.plugin(plugin, config)` returns `Fiber & PromiseLike<Fiber>`; await it to
  settle loading (rejects on failure); `fiber.dispose()` unmounts cleanly
  (dispose-即净, verified upstream by dsh-evolve and the official
  cordis_define/run/stop toolset).
- `ctx.loader` exposes the entry tree; `entry.update({ disabled: true })` is the
  live enable/disable channel (upstream-verified by dsh-web-plugin-manager).
- `ctx.webServer.register({ kind: "prefix", path, handler })` adds HTTP routes
  (boot-guard precedent); handler style `(req, res)` per boot-guard's `json(res, code, obj)`.

## Module interfaces (one branch each; merge-safe by file isolation)

### A. `lib/triage.js` — crash log parsing + attribution

```js
export function parseLoaderErrors(text)
// -> [{ stage, entryId, entryName, detail }]  (all matches, innermost last)

export function attributeCrash({ stderrTail, incidents, state })
// -> { entryId | null, reason }  // entryId from loader error, else most
//   recently installed/active plugin, else null
```

- Tests must include the EXACT verified message string above.

### B. `lib/circuit.js` — circuit breaker state machine

```js
export const DEFAULTS = { threshold: 3, windowMs: 10 * 60 * 1000 };

export function recordCrash(state, entryId, at = Date.now())
// -> mutated state.packages[entryId] {crashCount, crashTimes[], circuitOpenAt}

export function isOpen(state, entryId, now = Date.now(), opts = DEFAULTS) // -> bool
export function closeCircuit(state, entryId) // -> mutated state
```

- Crash count decays outside windowMs; 3 crashes in window opens the circuit.
- Pure functions; no IO.

### C. `lib/recipe.js` — recipe spec

```js
export const RECIPE_SCHEMA = { /* name, kind, source, deps, harnessRange, pin, verify, patchLines */ };

export function validateRecipe(obj) // -> { ok: true, value } | { ok: false, errors: string[] }
export function recipeFromPackageJson(manifest) // -> { ok, value } // probe recipe from npm/git metadata
export function matchesHarnessRange(range, harnessVersion) // -> bool (semver-ish, no dep: own tiny impl)
```

### D. `lib/repo.js` — AUR-like recipe repositories

```js
export async function repoAdd(url, name)  // -> repos.json entry
export async function repoRemove(name)
export async function repoList()
export async function syncRepos()          // git clone/fetch each repo into
                                           // <stateRoot>/recipes/<name>/;
                                           // parse index.json + recipes/*.json
export async function loadAllRecipes()     // priority = repos.json order,
                                           // high priority wins same-name
```

- Uses `child_process.spawn` for git (never shell:true with user input).
- Network-free unit tests: fake "git" via a stub repo dir + injected command runner.

### E. `lib/indexer.js` — four-source aggregation index

```js
export async function refreshIndex({ force = false } = {})
// pulls: GitHub topic:dsh-plugin search API, npm registry search, awesome-dsh-plugin list,
// dsh.so verification index -> normalize to:
// { key, name, ownerRepo, packageName, description, topics[], stars, url,
//   latestVersion, verification: {level, label}, security: {riskLevel, status} }
// writes <stateRoot>/index/items.json (gzip optional) + index/meta.json
// 24h freshness gate; failure = negative cache (keep old index, record attempt)
export async function readIndex() // -> items[] | null
```

- All fetches: timeout (10s), `fetch` with UA header, no auth.
- Tests: inject a fake fetch (pass a fetcher arg or module-level hook).

### F. `lib/search.js` — three-layer search

```js
export async function search(query, { online = false, profile = "web" } = {})
// offline: local index weighted rank (name exact > topics > description) + stars
// online: GitHub/npm live (only when online=true)
// marks installed by state + profile package.json deps
// -> [{...item, score, installed}]
export async function searchSemantic(query) // natural-language hint via keyword extraction
```

### G. `lib/snapshot.js` — known-good snapshots

```js
export async function saveSnapshot(profileDir)
// copies package.json + cordis.patch.yml + pnpm-lock.yaml to
// <stateRoot>/snapshots/<ISO-ts>/, prunes to last 5
export async function restoreSnapshot(profileDir, ts)
export async function listSnapshots()
```

- Atomic: copy to tmp dir then rename.

### H. `lib/transaction.js` — transactional install/remove

```js
export async function install(specOrRecipe, { profile = "web", dryRun = false } = {})
export async function remove(name, { profile = "web", dryRun = false } = {})
export async function autoremove({ profile = "web", dryRun = false } = {})
export async function resolveDeps(recipe, installed) // -> [recipe names in install order] (closure)
```

- Steps: dep closure -> precheck (`dsh --profile X --dump-config` exit 0 +
  patchLines sanity) -> install via `dsh plugin --profile X add` (official
  channel; force `link:` prefix for local paths) -> smoke (dump-config) ->
  rollback (pnpm remove + managed block cleanup) on failure.
- Shell out through `child_process.spawnSync` with the dsh launcher resolved as
  `node <npm-global>\node_modules\@deepseek-ai\dsh\lib\bin.js` (or `dsh` on PATH).
- Tests: mock runner injection; never mutate real profiles.

### I. `bin/supervisor.js` + `supervisor.ps1` — L3 watchdog

```js
export async function supervise({ profile = "web", port, args = [], healthPath = "/" } = {})
// spawn dsh child (stdio pipe) -> health probe loop (HTTP GET, timeout 5s,
// grace 30s after spawn) -> on child exit: parse stderr via triage ->
// disable culprit in cordis.patch.yml (managed marker block) -> restart ->
// after 3 consecutive boot failures: restoreSnapshot
// returns when stopped by user (SIGINT)
```

- Never uses `shell: true`. Windows: spawn `node` with the launcher bin path.
- Managed marker block convention in cordis.patch.yml:

```yaml
# dshpkg:managed:start
- id: <entryId>
  disabled: true
# dshpkg:managed:end
```

### J. `lib/index.js` (+ `lib/managed.js`, `lib/rescue.js`) — host service (L2)

```js
export const name = "dshpkg";
export function apply(ctx) {}
// ctx.get("webServer") guarded (headless-safe); ctx.loader for live enable/disable
// REST under /dshpkg: GET /status, POST /managed/mount, /managed/unmount,
// POST /circuit/close, GET /incidents
```

- `lib/managed.js`: store `managed/<name>/index.mjs` + manifest.json; mount via
  `ctx.plugin(await import(path + seq))`; seq cache-buster monotonic; failed
  mount does not persist manifest/rev; autoRestore on boot.
- No live-profile E2E in tests; unit-test the store logic with fake ctx.

## CLI (`bin/dshpkg.js`) — integration branch (after merges)

Commands: search/install/remove/update/upgrade/hold/enable/disable/status/
list/info/why/doctor/audit/fix-broken/log/run/repo/sync. Wires A-J; lives on
its own integration branch and is NOT part of the parallel batch.

## Rulings (integration pass, appended after merge — history preserved above)

Cross-module mismatches found while wiring the CLI; fixed with minimal edits
on `main` and recorded here. Earlier contracts above are NOT modified.

### R1. `writeJsonAtomic` tmp name must never embed the full path

The original tmp name replaced `/`/`\\` in the full path, which put the
Windows drive-letter colon (`C:`) into the file name; `rename()` then fails
with EINVAL. Ruling: tmp name = `.` + basename + `.` + pid + `.` + timestamp +
random + `.tmp`, created in the SAME directory as the target (atomicity kept).

### R2. Test script is `node --test`, never `node --test tests/`

`node --test tests/` makes Node 24.19 (Windows) load the directory as a
module and die with MODULE_NOT_FOUND. Ruling: `"test": "node --test"` — the
runner discovers `tests/*.test.js` itself.

### R3. `listSnapshots` has ONE implementation, in state.js

Both state.js (oldest-first, no filtering) and snapshot.js (newest-first)
ship a `listSnapshots`; supervisor consumed `snapshots[length-1]` expecting
oldest-first. Ruling: state.js owns the canonical implementation — newest
FIRST, `.tmp` staging dirs skipped; snapshot.js re-exports it; supervisor
reads `snapshots[0]` for the latest. Zero test changes were needed.

### R4. Snapshot dir naming is opaque; both dot and dash forms restore

`saveSnapshot` writes sanitized ISO dirs (`:` and `.` become `-`, e.g.
`2026-08-24T00-00-00-000Z`); supervisor tests reference dot-style names
(`2026-08-24T00.00.00.000Z`). Ruling: dir names are opaque; `restoreSnapshot`
accepts both raw ISO and sanitized names. Compatible, no code change.

### R5. Recipe `source` may be `{type, spec}` or a plain string

lib/recipe.js recipes carry `source: {type, spec}`; the transaction contract
assumed a string. Ruling: `transaction.js` normalizes via an internal
`sourceOf()` — a string passes through, an object resolves to its `spec`.
Both shapes stay valid everywhere.

### R6. Supervisor tolerant recovery vs snapshot.js strict recovery coexist

supervisor keeps its own best-effort restore (skips missing optional files;
a watchdog must not fail the boot loop), snapshot.js restore stays strict
(all three files required before touching the profile). Ruling: two intents —
watchdog = degrade gracefully, explicit user restore = refuse partial state.

### R7. Host gains POST /dshpkg/managed/enable|disable

The CLI's L2 path (HTTP mode when a host answers on the probed port) needs
enable/disable endpoints; only mount/unmount existed. Ruling: two new routes
added to lib/index.js sharing the `setEntryDisabled(name, disabled)` API;
file mode (rescue.js managed blocks) remains the offline fallback.

### R8. CLI owns state.packages bookkeeping

install/remove/upgrade/hold/unhold maintain `state.packages[name]`
({source, version, kind, installedAt, held, crashCount, crashTimes,
circuitOpenAt}) in state.json so status/list/info/audit/upgrade have a single
truth even when the recipe repo is offline.

### R9. String deps in recipes install by bare name

`resolveEntries` treats string deps as plain specs (installed as the name
itself, no recipe lookup). Only object deps recurse. This is the intended
semantic: a recipe may depend on packages that have no recipe.

### R10. status/doctor read the official loader first; two upstream follow-ups

`GET /dshpkg/status` now merges live `loader.entries()` (id / module /
disabled / phase) with `state.packages` into `officialEntries`. Entries the
official tree owns get `source: "official-loader"` (with the official
phase/disabled); `crashCount`/`circuitOpen` still come from the state
bookkeeping, and state-only entries get `source: "dshpkg-state"`. Without a
loader (or when `entries()` throws) `officialEntries` is null and the plain
state/managed path stays intact. Upstream follow-ups:

- The official fail-loud boot error has NO structured exit channel (errors
  are stderr text only); dshpkg's triage text parsing is a patch over that
  official gap. If upstream adds a pre-mount hook / loader error events,
  triage and the install precheck should move to the official channel.
- The official plugin-inventory service is read-only (cannot
  enable/disable/add/remove), so enable/disable persistence has exactly one
  official path: the patch layer (cordis.patch.yml). If upstream extends the
  inventory with mutation APIs, dshpkg should migrate to them.
