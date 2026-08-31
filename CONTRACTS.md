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

### R11. Source installs: recipe build field, git cache, allowBuilds (feat/aur-wip)

- **build field semantics.** RECIPE_SCHEMA gains an optional
  `build: { commands: string[], cwd?: string }`. Commands run sequentially
  AFTER a successful install, INSIDE the installed package directory —
  resolved through `fs.realpath(<profile>/node_modules/<name>)` so pnpm
  junctions point at the real source — with a relative `build.cwd` joined on
  top. Every command spawns with `shell: false` and whitespace tokenization
  (first token = executable; NO quoting/pipes — deliberate, recipes must
  stay simple and shell-injection-free); the executor is injectable
  (`opts.execBuild`, default `spawnSync`) so tests never run a real build.
  Any failing command rolls the whole transaction back with a Chinese error.
- **git cache path convention.** Git-backed specs (`github:owner/repo`,
  `git+https://…`, `git@…`, `….git`) cache under
  `<stateRoot>/cache/git/<sanitized-url>/` (scheme stripped, unsafe chars to
  `-`): `clone --depth 1` on first use, `fetch --depth 1` + `reset --hard
  origin/HEAD` after. The install is a `link:` to the cache dir (or to the
  `#path:subdir` fragment's subdirectory; a MISSING subdir aborts — pnpm
  would not understand the fragment). Non-`path:` fragments (#branch/#tag/
  #commit) bypass the cache and go to pnpm unchanged (pnpm resolves refs
  natively).
- **The real name rule.** A `link:` install registers the pulled manifest's
  name with pnpm, so rollback and bookkeeping must use THAT name when
  readable (`<target>/package.json`.name). Otherwise the recipe's declared
  name stays authoritative; only a url-shaped pkgNameOf leftover (contains
  `:`, e.g. "github:owner") is replaced by the repo url basename. dryRun
  pulls nothing and keeps the declared/derived name.
- **Cache failure falls back.** A failed cache pull (no git, network,
  corrupted cache, …) does NOT abort: the ORIGINAL spec goes to the official
  pnpm channel and the result carries `usedCache: false` (`true` when the
  cache was used; the field is absent when no git spec was involved).
- **allowBuilds auto-handling.** pnpm's allowBuilds rejection (output naming
  BOTH "allowBuilds" and "pnpm-workspace.yaml", captured by a piped install
  runner) is auto-handled: extract keys (inline list / YAML block /
  package-name-looking tokens — hyphen, slash or @ required, file names and
  ERR_PNPM codes rejected), merge them into `<profile>/pnpm-workspace.yaml`
  deduplicated (existing keys, comments and unrelated lines preserved; block
  form appends after the last list item), then retry the add ONCE.
- **SSH hint.** Git/network failures (Failed to connect to github.com /
  Could not connect / ERR_PNPM_GIT_RESOLVE_FAILED / could not resolve host /
  …) surface a Chinese error with the SSH `insteadOf` switching hint
  (`git config --global url."git@github.com:".insteadOf "https://github.com/"`).

### R12. Bundles ordering: kernel -> guardians -> stable topology (module M)

The kernel composes the entry tree by applying each bundle's patch layer in
`dsh.profile.bundles` ORDER (dsh-app-boot verified fact), while the official
`dsh plugin add` reconciler only APPENDS new bundles at the end. Ordering is
therefore a dshpkg responsibility:

- **New module `lib/order-bundles.js`.** `orderBundles(bundles, deps,
  depGraph, opts)` is pure and never throws: kernel bundles
  (`@deepseek-ai/*`) first (relative order kept, EXEMPT from the dependency
  filter because in-box template bundles are never profile dependencies),
  then the guardian layer (`DEFAULT_GUARDIANS = ["@sentencemang/dshpkg",
  "dsh-boot-guard"]`, intersection with the list, declared order), then the
  rest in stable Kahn topological order over the bundle dependency graph
  (edges = installed manifests' `dependencies` intersected with the bundles
  list); cycle members keep their original relative order and are reported
  via the `guard` output — ordering must never block boot. Non-kernel
  entries absent from `deps` are dropped (`deps: null` disables filtering).
  A bundles list whose kernel layer is ENTIRELY missing is completed from
  the profile's shipped template (`KERNEL_TEMPLATES`: web -> dsh-base +
  dsh-web-app, headless -> dsh-base + dsh-headless, anything else ->
  dsh-base only; the profile name is the directory basename). A PARTIAL
  kernel layer is never completed (adding a single kernel to a custom
  profile could break it).
- **Install wiring.** `install()` re-layers AFTER the final smoke passes;
  a re-layered config that fails `--dump-config` is rolled back to the
  pre-reorder manifest text and the install STILL succeeds (best-effort by
  design — a re-layering failure never rolls the packages back). Writes are
  atomic (tmp + rename) with 2-space JSON + trailing newline (kernel
  writeProfileManifest parity, the reorder is the only visible change).
  `opts.skipReorder` opts out; `dryRun` prints the intent and never writes.
- **R2 bootstrap.** `ensureDshpkgBundle(profileDir)` registers dshpkg
  itself (name read from `pkgRoot()`'s manifest, never hardcoded) into the
  bundles list, then re-layers so it lands right after the kernel. Exposed
  as the `dshpkg bootstrap` CLI command — the ONE intentional write to a
  real profile outside install transactions. `dshpkg doctor` reports a
  missing registration / a guardian layer loading after plain plugins
  (read-only, exit 1, hints `dshpkg bootstrap`).
- **Upgrade rollback.** `dshpkg upgrade` saves a snapshot BEFORE the first
  transaction; an upgrade whose transaction rollback itself failed
  (`rolledBack === false`) restores that snapshot and stops the run. Note:
  a failing FIRST add yields `rolledBack: true` (nothing was installed yet,
  nothing to roll back), so the snapshot path covers partial-install
  failures, not no-op failures.
- **Test isolation.** Ordering tests use `mkdtemp` profile dirs; the
  transaction/CLI suites point `DSH_HOME`/`DSH_PKG_HOME` at temp dirs, so
  the re-layering never touches `~/.dsh/profiles`.

### R13. Test script pins `--test-concurrency=1` (runner IPC corruption)

On Node v24.19.0 / Windows, running the full suite with the runner's
default parallel file execution reproduces, DETERMINISTICALLY, a parent-
runner crash: child files (cli / source-install first) fail with
`uncaughtException: Unable to deserialize cloned data due to invalid or
unsupported version` at `#processRawBuffer`, then the parent dies without
a summary. The same suite passes 523/523 serially, every two-to-five file
subset passes in parallel, and no code path in this repo speaks the
runner's structured channel — the corruption happens in the runner's own
child-IPC parsing under parallel spawn load. Ruling: `"test": "node --test
--test-concurrency=1"` until a Node upgrade proves parallel mode reliable
again; ad-hoc `node --test` invocations may add `--test-concurrency=N` at
their own risk. This amends R2 only in the flag set, not the rule (never
`node --test tests/`).

### R14. Crash rescue entry, harness gate, conflict diagnostics, AI channel

Verification pass over the crash/dependency/AI surface (all four gaps
found during the audit are closed here):

- **`dshpkg restore [快照id]`** — one-shot crash rescue WITHOUT the
  watchdog: no argument restores the NEWEST snapshot (`listSnapshots` is
  newest-first, R3), an explicit id restores that one; `restoreSnapshot`
  stays strict (incomplete snapshot refuses without touching the profile).
  `dshpkg audit` prints the rescue hint when snapshots exist. The
  watchdog (`dshpkg run`) stays the automatic path; it is never
  auto-started by the system (R6 boundary).
- **harnessRange gate.** `cmdInstall` checks `matchesHarnessRange(
  recipe.harnessRange, harnessVersion)` before the trust gate; the
  harness version comes from the global `@deepseek-ai/dsh` manifest
  (`resolveHarnessVersion`: npm prefix probe + static prefixes, both
  injectable). An UNREADABLE harness version SKIPS the check with a note
  (never blocks on missing metadata); a real mismatch refuses with a
  Chinese error; `--force` (new global flag) overrides.
- **Version-conflict diagnostics.** `classifyVersionConflict` maps pnpm
  failure signatures to `no-matching-version` / `peer-conflict` /
  `resolution-conflict`; `addStep` answers with actionable Chinese
  guidance (`dshpkg info` / `dshpkg why` / hold) instead of the raw
  dump. allowBuilds (R11) and the git SSH hint keep their precedence.
- **AI install channel.** The host's `plugin_install` / `/dshpkg install`
  go through `hostInstall` (lib/index.js): a successful install records
  `state.packages` + the managed ledger (dangerous keys refused) and
  snapshots the known-good profile — both best-effort, never failing an
  already-successful install. No interactive trust gate exists inside the
  host (no terminal); the channel behaves like an explicit bare-spec
  install, the install-guard prompt section keeps the model on dshpkg.

### R15. Active dependency handling (installed face = single source of truth)

dshpkg no longer trusts external bookkeeping (the official reconciler's
bundles list, pnpm's dep materialization) — both have proven failure modes
(missed bundle registration, missing deps). Ruling:

- **`collectDeclaredBundles(profileDir)`** scans the profile's installed
  deps and returns every manifest declaring `dsh.bundle.patch` (kernel
  exportsPatch semantics, reimplemented locally). `computeReorder` /
  `planReorder` / `reorderProfileBundles` now RECONCILE registrations
  first: an installed bundle missing from `dsh.profile.bundles` is added,
  then the union is re-layered; the result carries `registered[]`. The
  `changed` baseline compares against the on-disk list, so a pure
  registration add always counts as a change.
- **`verifyAndFillDeps` (transaction).** After the target installs, its
  manifest's declared deps must EXIST in the profile node_modules; missing
  ones are actively installed one by one through the official channel (max
  8, a single failure does not stop the rest); deps still missing fail the
  transaction with a Chinese error and full rollback. An unreadable target
  manifest skips the check with a warning (never fails the install).
- **`dshpkg reconcile [--fix]`** — one-shot repair for broken environments:
  reports unregistered bundles / missing deps / order drift (read-only,
  exit 1 with problems); `--fix` fills missing deps through the
  transaction channel, then registers + re-layers.
- **doctor installed-face check.** The dependency graph check gains an
  installed-integrity scan (every installed package's declared deps must
  exist on disk); it counts into the exit code and `doctor --fix` fills
  them, then re-layers.
- **Boot-time self-healing.** `bootReconcile()` (lib/index.js) runs
  fire-and-forget inside `apply()`: register + re-layer for the NEXT boot
  (never fills deps at boot — no pnpm at boot time), records a
  `type: "reconcile"` incident on change, degrades silently on any error.

### R16. In-process boot guardian (no watchdog, no dsh code changes)

Root cause found by controlled reproduction: dshpkg's own loader entry
declared `name: dshpkg` while the package is `@sentencemang/dshpkg` — the
loader's Node resolution failed with ERR_MODULE_NOT_FOUND and EVERY boot
crashed. Fixed the patch file (`name: "@sentencemang/dshpkg"`). The deeper
gap: the kernel turns any boot failure into a controlled `process.exit(1)`
(profile-boot verified), so nothing attributes the crash and the next boot
hits the same culprit — and the out-of-process watchdog only helps when
manually started. Ruling — dshpkg protects boot FROM INSIDE the process:

- **Position.** dshpkg is the first non-kernel bundle (re-layering
  guarantee); its `apply()` runs before any third-party entry applies.
- **Boot fingerprint.** `state.boot = { startedAt, pid }` written
  synchronously in `armBootGuard`'s sync core; a stale marker at the next
  boot means the previous boot crashed → `bootFailures += 1` + a
  `boot-crash-detected` incident.
- **Escalation (`decideBootDisables`, pure).** Level 1: disable the last
  attributed culprit; level 2: + the newest installed candidate; level 3
  (`SAFE_MODE_FAILURES`): disable every non-core entry + restore the
  newest snapshot files for the next boot. Proven attribution overrides
  protection EXCEPT the `NEVER_DISABLE` kernel-core set (loader / include /
  cordis-host-runner / web-startup / web-runtime / api-gateway); dshpkg
  itself may be sacrificially disabled when proven to be the culprit.
  Candidates unknown to the loader are dropped. Disables go out on two
  channels: persistent managed blocks in cordis.patch.yml (guaranteed next
  boot) + best-effort live `entry.update({ disabled: true })` (may stop a
  later entry in the current boot).
- **Exit attribution.** `createCrashCapture` wraps `process.stderr.write`
  at runtime (dshpkg's own plugin code, restore-safe; NO dsh code touched)
  collecting the kernel's fail-loud loader-error lines — a controlled boot
  failure never triggers uncaughtException. The synchronous `process.on`
  ('exit') hook (`handleExitSync`) parses the innermost culprit,
  sync-writes its managed disable block + a `boot-crash` incident + the
  attribution into state BEFORE the process dies. Clean exit (code 0)
  clears the marker quietly. Convergence: any boot crash reproduces at
  most once.
- **Confirmation.** 45s (`BOOT_CONFIRM_MS`) after arming, a still-alive
  process is a successful boot: marker cleared, `bootFailures = 0`,
  `lastBootOkAt` stamped, `boot-confirmed` incident, best-effort
  known-good snapshot. Timer `.unref()`s; delay/setTimeout injectable.
- **Guard invariants.** The guardian's sync core runs before any await in
  `apply()` (before later entries can crash the boot); every guardian
  failure degrades silently — it must never disturb boot itself; one
  arming per process (`resetBootGuardForTests` for isolated tests).
- **Operator surface.** `dshpkg doctor` reports marker / bootFailures /
  last attribution; `dshpkg fix-broken` removes guardian disable blocks
  (same managed-block format) once the culprit is repaired.
- **Host-service wiring fixes found during live verification** (all three
  were silent failures — the boot looked healthy while dshpkg stayed dark):
  1. The loader's `unwrapExports` prefers `module.default` over named
     exports (`exports.default ?? exports`); the default export `{ name,
     apply }` silently LOST the `inject` declaration, producing "cannot
     get property webServer without inject". The default export MUST carry
     `inject` too: `export default { name, inject, apply }`.
  2. Service registration must use the reactive `ctx.effect(() =>
     ctx.webServer.register(...))` pattern (dsh-boot-guard precedent):
     services can be provided AFTER this bundle's apply runs, and a
     synchronous probe at apply time sees null and skips forever.
     effectImpl records an `effect-error` incident on registration
     failure and falls back to the inline attempt.
  3. The dsh-tools registry rejects output-schema type ARRAYS ("type must
     be a single type string"); textOutput declares `{ type: "object" }`.
     Same-name tools already registered by another plugin (e.g.
     dsh-web-plugin-manager's plugin_search/install/toggle) are yielded to
     with ONE summary info line, not treated as failures.

### R17. Test driver runs each file in a fresh runner (R13 supersedes)

Characterization evidence (this environment, Node v24.19): every test file
ALWAYS passes in isolation (3/3 repeated runs), while the multi-file runner
fails a RANDOM file each full run ("Unable to deserialize cloned data" in
the runner's child-IPC parsing; a different file every time, file-level
crash, counts truncated). Ruling: `npm test` runs `scripts/run-tests.js`,
which executes each `tests/*.test.js` in its own FRESH `node --test`
process sequentially (stdio inherit, spawnSync shell:false, zero deps),
printing one Chinese summary line and exiting non-zero on any failing
file. `npm run test:native` keeps the plain multi-file runner available.
Acceptance met: two consecutive `npm test` runs fully green (24/24 files).

## R18 (2026-08-31): port-contention auto-resolution

EADDRINUSE boot crashes happen in the dsh-web-app layer (bundle #2), BEFORE dshpkg (bundle #3) loads: the in-process guardian is structurally blind. Ruling: the watchdog owns resolution. (1) lib/portcheck.js arbitrates BEFORE every spawn: a stale dsh instance holding the port is evicted (command-line match only; non-dsh holders never killed; max 3 attempts; Chinese reason on refusal); (2) supervisor attribution exempts EADDRINUSE entirely: no entry disabled, no crash counter climb, no snapshot restore — the loop restarts and pre-spawn arbitration settles the port; (3) defense in depth: webserver joins CORE_PROTECT_LIST and handleExitSync refuses disable blocks for protected entries. Tests: tests/portcheck.test.js (12) + extensions in protect/bootguard/supervisor tests. npm test twice green (25 files).

## R19 (2026-09-01): risk-audit gap fixes (signals, locks, integrity, metrics)

A user-supplied risk checklist was audited against the code; roughly half the items were ALREADY covered (all atomic writes are same-directory tmp+rename, so EXDEV is structurally impossible; restoreSnapshot pre-checks completeness; state.json corruption is quarantined on read; verifyAndFillDeps is bounded and non-recursive; the 45s confirmation only requires liveness; incidents rotate; R12-R18 tests exist). Four REAL gaps were fixed:

1. Clean-shutdown signals: armBootGuard registers SIGINT/SIGTERM listeners that run cleanShutdownSync (clear boot marker + clean-shutdown incident) then process.exit(0) - a deliberate stop must never escalate disables on the next boot. SIGKILL remains uncatchable by design; the stale-marker escalation chain (R16) already converges that case, only losing attribution. DSHPKG_NO_SIGNAL_GUARD=off disables registration for test runners emitting synthetic signals (run-tests.js sets it).
2. Shared-surface serialization: withSyncLock (state.js) wraps writeManagedDisable / removeManagedBlock / copySnapshotIntoProfile / resetToFactoryBaseline / restoreSnapshot / reorderProfileBundles / CLI enable-disable-remove patch writes. Non-reentrant; nested callers use the *Impl internals. Contention degrades (one retry, lock-busy incident, then run unlocked) - never blocks.
3. doctor state integrity: state.json shape, incidents.jsonl line parsing, snapshot completeness; --fix quarantines (state via readState self-heal, snapshots renamed .corrupt-<ts>; listSnapshots skips quarantined dirs) and records doctor-repair.
4. Zero-dependency observability: GET /dshpkg/metrics aggregates bootFailures / circuitOpen / event counters from state+incidents. Prometheus clients are REJECTED (zero third-party dependency contract).

Tests: withSyncLock x4 (state), lock-contention managed write (supervisor), cleanShutdownSync x3 (bootguard), doctor integrity x3 (cli), routeMetrics x2 (index). npm test 25 files green twice.

## R20 (2026-09-01): zombie boots and name drift (the genui incident)

Real incident: a link:-installed plugin was registered under a FOREIGN key (@omdsh-dev/dsh-genui) while its package/cordis entry uses the REAL name (@changfenhuang/dsh-genui). dsh's runtime import failed, the plugin tree died, but the process SURVIVED as a zombie (no port, no CPU) and the guardian certified it as a healthy boot. Four blind spots, four fixes:

1. uncaughtException channel was record-only: dsh wraps loader failures and re-throws them; with a listener registered the process lives on, so the exit hook never attributed. New handleUncaughtLoaderSync parses the exception text (parseLoaderErrors) and, while the boot marker is pending, disables the culprit IMMEDIATELY (protected-list gated) + persists lastCulprit + records boot-tree-crash. A hard-killed zombie now converges on next boot.
2. Confirmation only checked liveness: zombies were certified. The confirm timer is now SERVICE-AWARE: the /dshpkg route registration sets a module-level readiness flag (dshpkgRoutesReady); alive-but-not-registered at window end -> degradeBootSync (marker KEPT, bootFailures+1, boot-degraded incident) so the next boot escalates with the stored culprit. isReadyImpl injectable for tests.
3. Name drift was invisible to every audit: new detectNameDrift(profileDir) compares each dependency key against the installed package.json name; repairNameDrift rewrites the dependency key AND the bundles entry to the real name (spec kept, never clobbers an existing real-name dep) and dsh re-links on next boot. Wired into doctor (report + --fix) and reconcile --fix, both under withSyncLock, recording drift-repaired.
4. Watchdog absence remains the structural boundary for direct dsh web boots (documented).

Tests: handleUncaughtLoaderSync x3 + degradeBootSync x2 (bootguard), zombie-degrade + immediate-disable wiring (index), detect/repair x4 (order-bundles), doctor drift report/--fix (cli). npm test green twice.
