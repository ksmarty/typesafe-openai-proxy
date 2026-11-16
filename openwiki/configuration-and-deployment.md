---
type: "Reference"
title: "Configuration and deployment"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-54b0e10a2c896a35d9cacf06
    resource: repo://.github/workflows/auto-increment.yml
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-f4927fdbd3f1f0d083362c6d
    resource: repo://.github/workflows/docker-publish.yml
  - id: openwiki-source-b79fbbd921df689b4bbdc82f
    resource: repo://docker-compose.yml
  - id: openwiki-source-bb1ebe868e35e9e500714501
    resource: repo://Dockerfile
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-fc514c46479a691784dc5d9c
    resource: repo://src/catalog.ts
  - id: openwiki-source-2b68006c6421e01c95988dcc
    resource: repo://src/config.ts
  - id: openwiki-source-32df914360d92c28e9283cc8
    resource: repo://src/decidecache.ts
  - id: openwiki-source-8c630d0655d2170e7b1bb86c
    resource: repo://src/history.ts
  - id: openwiki-source-04b8caafc10c8220af48f716
    resource: repo://src/schema.ts
  - id: openwiki-source-d9b845a7425932c3767a237e
    resource: repo://src/server.ts
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# Configuration and deployment

The proxy is one Node process with a JSON settings file, a small set of environment overrides, and a React dashboard compiled into static assets. This page covers how configuration is layered and saved, what is stored in the data directory, which HTTP endpoints exist, and how the container image and workflows ship a build.

<!-- openwiki: broken internal link [../quickstart.md] file "../quickstart.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [state-and-persistence.md] file "state-and-persistence.md" does not exist. Fix the href or restore the target, then delete this comment. -->
Everything starts from the Quick start in [Quickstart](../quickstart.md); the code behind the settings UI is described in [State and persistence](state-and-persistence.md).

## Configuration precedence

Three layers, weakest to strongest:

1. **Defaults** — `defaultConfig()` at `src/config.ts:377-438`. Every field has a value, including `server.port` from `Number(process.env.PORT) || 8080`.
2. **`config.json`** — `CONFIG_PATH` at `src/config.ts:440`, resolved as `resolve(process.env.DATA_DIR || 'data', 'config.json')`.
3. **Environment** — `applyEnv(config)` at `src/config.ts:477-...`, applied last and to every load.

`loadConfig(force = false)` at `src/config.ts:459-475` returns a cached config unless forced. It reads the file, deep-merges it onto the defaults with `merge` at `:443-457` (a shallow object merge by key, arrays and primitives replaced), and falls back to the defaults if the file is missing or unparsable. A partial file is therefore always valid.

`saveConfig(patch)` at `src/config.ts:588-611` works in the opposite direction and is more careful than a plain write:

- every password field whose submitted value is still the mask is restored from the current config (`isMaskedValue` at `src/schema.ts:779` and `SECRET_MASK`), so the form echoing its own preview cannot overwrite a real key with bullets;
- `pruneInvalid(incoming)` drops values the schema cannot read — a typo in a select, a non-numeric number — leaving the previous value in place;
- `merge` then `clampSettings(next)` keep numbers inside their declared range;
- the file is written with `mkdirSync(dirname, {recursive: true})`, pretty-printed with a trailing newline, and the cache is replaced.

`resetConfigPaths(paths)` at `src/config.ts:638-655` resets only the named paths. The comment explains the reason: wiping a Home Assistant token or a decision URL because someone wanted one tab's look back is data loss, not a reset. `resetConfig()` writes the whole default config.

`configPath()` and `publicConfig()` close the module. `publicConfig()` clones the active config and runs `maskSecrets` over every password field, keeping only a prefix and the mask (`maskSecret` in `src/schema.ts`).

## Environment variables

`applyEnv` reads the environment on every load, so a container can be configured without a volume. Booleans accept `1|true|yes|on`. The variables the proxy honours:

| Variable | Effect |
| --- | --- |
| `PORT`, `HOST` | listen address; `server.host` defaults to `0.0.0.0` |
| `DATA_DIR` | where `config.json`, `catalog.json`, `decision-cache.json` and `history.json` live |
| `PROXY_API_KEY` | bearer key clients must present |
| `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, `UPSTREAM_MODEL` | forwarded-request target |
| `UPSTREAM_API_KEY_FROM_DECISION` | reuse the decision key when no upstream key is set |
| `SYSTEMONE_BASE_URL`, `SYSTEMONE_API_KEY`, `SYSTEMONE_MODEL`, `DECISION_BACKEND`, `AUTO_START` | the decision model |
| `LISTENING`, `LISTENING_LOCAL`, `LISTENING_CONFIDENCE` | whether remarks are classified |
| `HA_URL`, `HA_TOKEN` | catalog source |
| `CLOCK_TIMEZONE` | spoken time |
| `WEATHER_API_KEY`, `WEATHER_LATITUDE`, `WEATHER_LONGITUDE`, `WEATHER_UNITS`, `WEATHER_LANGUAGE`, `WEATHER_STYLE`, `WEATHER_BASE_URL` | forecast reader |
| `MUSIC`, `MUSIC_PROVIDER`, … | the music fast path |

The debug bundle lists environment variable **names** always, but withholds the values of `PROXY_API_KEY`, `UPSTREAM_API_KEY`, `SYSTEMONE_API_KEY`, `HA_TOKEN` and `TYPESAFE_PROXY_KEY`, showing `set (value withheld)` instead (`environment()` at `src/server.ts:154-168`).

## Secrets

Password fields are masked in every outbound copy. `publicConfig()` masks for the dashboard and the debug bundle; the bundle notes that "Secrets are masked to their first 12 characters; they are not exported in full" (`src/server.ts:301`). The same note warns that traces contain the utterances Assist sent.

`secretOrStored(submitted, stored)` at `src/schema.ts:792-796` is the rule used by every test button: an empty submission means "use the stored value", a masked preview means the same, anything else is a new secret. The comment records the bug that motivated it — an earlier version compared against the bare mask string and sent `sk-or-v1-abc••••••` as a real key.

## The data directory

Default `data/`, overridable with `DATA_DIR`, and in the container mounted at `/app/data`. Four files:

| File | Written by | Purpose |
| --- | --- | --- |
| `config.json` | `saveConfig` | the settings file; the only file you must keep |
| `catalog.json` | `src/catalog.ts:778-786` | catalog snapshot, reused for up to 24 hours |
| `decision-cache.json` | `src/decidecache.ts` | decisions that do not depend on live state |
| `history.json` | `src/history.ts` | dashboard trace, request log and counters |

<!-- openwiki: broken internal link [state-and-persistence.md] file "state-and-persistence.md" does not exist. Fix the href or restore the target, then delete this comment. -->
The catalog snapshot and decision cache both survive a restart; history exists so an image update does not empty the dashboard. See [State and persistence](state-and-persistence.md) for the format, the debounce and the failure behaviour.

## HTTP endpoints

Two groups. `/v1/*` is the OpenAI-compatible surface Home Assistant talks to; `/api/*` is the dashboard's own API. Both are served from `src/server.ts`.

### The model surface

| Endpoint | Behaviour |
| --- | --- |
| `POST /v1/chat/completions` | the whole point of the proxy: decide, call, answer or forward |
| `GET /v1/models` | the model list Assist asks for |
| `GET /health` | liveness, used by the Docker health check and by supervisors |

When `server.apiKey` is set, `/v1/*` requires `Authorization: Bearer <key>`; `authorised()` at `src/server.ts:105-110` drops the prefix and compares the token. `/health` is exempt so a health check never needs the secret.

### The dashboard surface

`/api/*` is dispatched by `api()`; the server strips the prefix before matching. The routes, all JSON:

| Route | Purpose |
| --- | --- |
| `GET /api/status` | version, uptime, effective config, decision and catalog state |
| `GET /api/requests` | recent requests, `limit` capped at 50 |
| `GET /api/trace` | trace rows, `limit` capped at 200 |
| `DELETE /api/trace` | clear the trace and flush the empty history |
| `GET /api/debug/bundle` | one downloadable JSON: environment names, masked config, status, catalog summary, traces, requests, recent logs |
| `GET /api/catalog`, `POST /api/catalog/refresh`, `POST /api/catalog/exposure` | inspect and refuse/accept exposure |
| `GET /api/config`, `POST /api/config`, `POST /api/config/reset` | read, patch and reset settings |
| `GET /api/schema` | groups and fields the settings page renders |
| `POST /api/test/ha`, `/api/test/decision`, `/api/test/upstream` | connection tests |
| `POST /api/breaker/reset` | close the decision breaker early |
| `POST /api/probe` | run a sentence through the pipeline without a model call |
| `GET /api/models` | upstream model list |

The dashboard is served from `public/`: `index.html` and the bundled `app.js`. `serveStatic` at `src/server.ts:112-...` normalises the path and refuses anything outside `publicDir`. `/favicon.ico` answers 204 rather than 404, because a missing icon on every page load reads like a fault.

## The container image

`Dockerfile` is a two-stage build:

- **build** — `node:22-alpine`, `npm ci`, copy `src`, `web`, `scripts`, `public`, then `npx tsc && node scripts/build-ui.mjs`. The dashboard bundle is written into `public/app.js`; the server compiles to `dist/`.
- **runtime** — `node:22-alpine` with no `node_modules` at all. Only `dist/`, `public/`, `package.json` and an empty `/app/data` are copied, because the server uses nothing but Node built-ins and static assets.

The image sets `NODE_ENV=production`, exposes `8080`, and runs `node dist/server.js`. A `HEALTHCHECK` every 30 s fetches `/health` with the same Node binary. `VERSION` is a build argument baked into the `org.opencontainers.image.*` labels (default `dev`), so `docker inspect` answers "which build is this?" without opening the dashboard.

`docker-compose.yml` runs `ghcr.io/ksmarty/typesafe-openai-proxy:latest`, publishes `8080:8080`, and mounts `${TYPESAFE_DATA_PATH:-/opt/typesafe-proxy}` at `/app/data`. The comment says why that mount is the only required one: `config.json` lives there. `extra_hosts` adds `host.docker.internal:host-gateway` so a model server on the Docker host is reachable.

## Workflows

`.github/workflows/` holds five workflows:

- **`ci.yml`** — on pushes to `main` and every pull request: typecheck, unit tests, build, then a Docker build with no push. The comment explains the second job: a broken Dockerfile should fail on the pull request that broke it, not at release time. Concurrency cancels superseded runs on the same ref.
- **`auto-increment.yml`** — bumps the patch version on every push to `main`, commits, tags `v<version>` with an annotation built from the commit log, and pushes. It then *dispatches* `release.yml` and `docker-publish.yml`, because a tag pushed with `GITHUB_TOKEN` starts no workflows. It deliberately does not wait for CI: a release is always cut, and the file names `workflow_run` as the alternative if that ever matters more.
- **`docker-publish.yml`** — builds and pushes the image to GHCR on `main`, on `v*.*.*` tags, and by dispatch with an optional version. It lowercases `github.repository` first, since GHCR rejects uppercase.
- **`release.yml`** — creates the GitHub Release from the annotated tag message rather than generated notes. The comment explains the choice: generated notes are assembled from merged pull requests, so a repository that commits straight to `main` gets a release containing only a changelog link.
- **`openwiki-update.yml`** — runs `openwiki code --update` daily and on dispatch, with a full clone so the update can diff against the commit it last documented. It removes `openwiki/.run.json` afterwards and commits the result.

## Build and test commands

From `package.json`:

| Command | What it does |
| --- | --- |
| `npm run dev` | build the dashboard, then `tsx watch src/server.ts` |
| `npm run dev:ui` | rebuild the dashboard bundle on change |
| `npm run build` | `tsc` then the UI bundle |
| `npm start` | `node dist/server.js` |
| `npm run typecheck` | `tsc --noEmit` and `tsc -p tsconfig.web.json` |
| `npm test` | `node --import tsx --test "test/**/*.test.ts"` |

Node `>=22.6` is required (`engines`). The test runner is Node's own, with `tsx` for TypeScript; there is no test framework dependency. The dashboard is built by `scripts/build-ui.mjs`, which bundles React and MUI with esbuild and writes `public/app.js`.

## Where to look next

<!-- openwiki: broken internal link [state-and-persistence.md] file "state-and-persistence.md" does not exist. Fix the href or restore the target, then delete this comment. -->
- [State and persistence](state-and-persistence.md) — the files that outlive a restart.
- [Dashboard](dashboard.md) — what the settings page and monitor do with these endpoints.
- [Request lifecycle](architecture/request-lifecycle.md) — what happens after `/v1/chat/completions` is accepted.
