---
type: "Tutorial"
title: "Quickstart"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-2b68006c6421e01c95988dcc
    resource: repo://src/config.ts
  - id: openwiki-source-8c630d0655d2170e7b1bb86c
    resource: repo://src/history.ts
  - id: openwiki-source-d9b845a7425932c3767a237e
    resource: repo://src/server.ts
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# Quickstart

You need a running Home Assistant with `hass_local_openai_llm`, and a model server that integration already talks to. The proxy goes between them and changes nothing until you configure a decision backend.

## 1. Run the proxy

From source, Node 22.6 or newer:

```bash
npm install
npm run dev          # http://localhost:8080 — dashboard and /v1 endpoint
```

With Docker, from the repository:

```bash
mkdir -p /opt/typesafe-proxy
docker compose up -d          # ghcr.io/ksmarty/typesafe-openai-proxy:latest
```

The compose file bind-mounts that host directory to `/app/data`. `config.json`, the entity snapshot, the decision cache and `history.json` all live there, which is what makes settings and recorded decisions survive an image update. The image runs as uid 1000, so `chown 1000:1000` the host directory if you created it as root.

`PORT` (default 8080) and `HOST` (default 0.0.0.0) come from the environment. Every other setting has a dashboard field and an environment equivalent; the environment wins when set.

## 2. Fill in Settings

Open `http://<host>:8080/` and go to Settings. The one field needed for a working pass-through is **Inference server to fall back to** — the URL `hass_local_openai_llm` uses today. Save, and the proxy already forwards everything there unchanged.

For the fast path, add:

- **Decision backend** — `System One` with a base URL and model name, or `Heuristic` to try routing without a model.
- **Home Assistant URL + long-lived token** — optional; gives the catalog entity ids, areas and floors over the websocket instead of parsing the request's system prompt.
- **Spoken-from area** — enables "turn on the lights here".
- **Start deciding on its own** — off by default. See [Nothing happens until you ask](#nothing-happens-until-you-ask) below.

Each group has its own **Reset** in the footer, so resetting the catalog section cannot clear the decision key.

## 3. Point the integration at the proxy

In the `hass_local_openai_llm` integration options, set **Server URL** to `http://<proxy-host>:8080/v1`. Keep the model name. If you set `PROXY_API_KEY`, that value is the API key the integration must send — `/v1` requires it as a bearer token, and an empty value accepts any client.

Keep **Assist tools / tool calling** enabled. The proxy builds its calls from the `tools[]` array the request carries; when no tool is offered it forwards instead of inventing one, because a call to a tool the caller never offered would be rejected.

## 4. Check that it works

Three checks, each independent of Home Assistant:

```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/v1/models
curl -s -X POST http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"typesafe-router","messages":[{"role":"user","content":"what time is it?"}]}'
```

- `/health` reports `ok`, whether routing is enabled, the backend, whether the fast path is ready to decide (`deciding`), and how many entities the catalog currently holds.
- `/v1/models` lists the model names the proxy answers to.
- The third request is the smallest end-to-end case: with the backend off it is forwarded verbatim; with a backend configured it is decided, and a fast-path sentence like the time is answered locally.

Then talk to Assist and open the **Monitor** view. Every request appears as a row with its route, the gates it passed or failed, why it was forwarded, and — for a forwarded request — the model server's answer and any tools it used. `POST /v1/chat/completions` is the endpoint Home Assistant actually calls; `/v1/models` is used by the integration to list models.

### Nothing happens until you ask

With `decision.backend` set to `none`, or `systemone` without a URL, the proxy is a pass-through. It records the request and forwards it; Assist behaves exactly as before. Two ways to start deciding:

- Set **Start deciding on its own** (`decision.autoStart`) — every request is decided once the backend is ready.
- Or name the model `typesafe-router` in the request. That model is always decided, whatever `autoStart` says, which is how to try the fast path without touching your working entry.

The Monitor header shows `deciding` or `pass-through`, and the tiles separate *forwarded* (decided, then handed on) from *passed through* (never decided).

## Troubleshooting

| symptom | cause |
| --- | --- |
| 401 from `/v1` | `PROXY_API_KEY` is set and the integration sends a different key, or none. |
| Every row says "passed through" | Backend off, or `autoStart` off and the model name is not `typesafe-router`. |
| Rows say the intent is not offered | The request carried no Assist tools; the proxy forwards rather than inventing a call. |
| "The inference server is unreachable" | `upstream.baseUrl` is empty or wrong, or the container cannot reach the host (`host.docker.internal`). |
| Trace is empty after an update | The data directory is not mounted, so `history.json` was written inside the container. |
| Decision errors every time, then forwards | The decision backend is down or its circuit breaker is open (3 failures, 30 s). Forwarding is the designed behaviour. |

Settings are validated on save. A masked secret returned by `GET /api/config` is recognised and kept when it is posted back, so saving the page cannot erase a key you cannot see.

## Next

- **[Overview](overview.md)** — why the proxy exists and how the two paths fit together.
- **[Request lifecycle](architecture/request-lifecycle.md)** — what happens to one request, end to end.
- **[Configuration and deployment](configuration-and-deployment.md)** — precedence, endpoints, Traefik split, workflows.
