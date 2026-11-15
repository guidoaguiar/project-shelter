# SHELTER

An offline-first survival knowledge node. It runs on hardware you own and keeps working when the network does not: a field manual of practical skills, a local AI advisor, a world map, field calculators, a log, a supply inventory, and a depot of optional containerized services.

Inspired by [Project N.O.M.A.D.](https://github.com/crosstalk-solutions/project-nomad). Shelter is an independent project and shares no code with it.

## Run

Requires Node.js 20 or newer. There are no dependencies to install.

```
node server.js
```

Open http://localhost:4077.

To serve phones and tablets on your network:

```
node server.js --lan
```

Shelter has no login. Do not expose it to the internet.

## Modules

| # | Module | What it does |
|---|---|---|
| 01 | Command | Host telemetry, link status, grid position, sun and moon, supply readiness, configuration |
| 02 | Manual | 40 field manual entries in 10 sections, with ranked full-text search |
| 03 | Advisor | Chat with a local model, grounded in the manual and citing entries. With no model it returns the closest entries instead |
| 04 | Map | Offline vector world map, waypoints, range and bearing from home |
| 05 | Tools | Coordinate conversion (DD, DMS, UTM, MGRS), sun and moon times, Morse with audio, water disinfection dosing, pace and bearing, encoding and hashing |
| 06 | Log | Markdown notes saved on the node |
| 07 | Stores | Supply inventory with days of water and food, and expiry warnings |
| 08 | Depot | Deploys 19 services as Docker containers, in six categories: knowledge (Kiwix, Kolibri, Calibre-Web, DokuWiki), AI (Ollama, Open WebUI), tools, vault, homestead and media. Each card links to where its content comes from |

The display button in the top bar cycles three modes: dark, night vision (red only, to preserve dark adaptation) and daylight.

## Local AI

The Advisor talks to [Ollama](https://ollama.com) at `http://127.0.0.1:11434` by default. Install Ollama (or deploy it from the Depot), pull a model such as `llama3.2:3b`, and the AI indicator in the top bar turns on.

Any OpenAI-compatible server (LM Studio, llama.cpp) also works: choose it under Command, Configuration, and include `/v1` in the URL.

## Adding to the manual

Drop a Markdown file into `content/manual`. It is picked up without a restart.

```markdown
# Title of the Entry
tags: optional, comma, separated

The first paragraph is the summary shown in search results.

## A section
```

The file name sets the section (`11-vehicles.md` becomes VEHICLES). Each line starting with a single `#` begins a new entry.

## Adding your own services

Create `config/depot.custom.json` with entries in the same format as `config/depot.json`, then restart. An entry whose `id` matches a built-in one replaces it.

```json
[
  {
    "id": "my-service",
    "category": "TOOLS",
    "name": "MY SERVICE",
    "title": "What it is",
    "desc": "What it does.",
    "image": "owner/image:tag",
    "port": 8700,
    "containerPort": 80,
    "volumes": { "data": "/data" },
    "env": { "KEY": "value" },
    "links": [{ "label": "DOCS", "url": "https://example.org" }]
  }
]
```

Each name under `volumes` becomes a folder in `data/depot/<id>/`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4077` | Listening port |
| `HOST` | `127.0.0.1` | Bind address. `--lan` sets `0.0.0.0` |
| `SHELTER_DATA` | `./data` | Where settings, notes, stores, waypoints and container data live |
| `SHELTER_NET_CHECK` | `1.1.1.1:443` | Host probed for uplink status. Set to `off` to disable |
| `SHELTER_REMOTE_ADMIN` | unset | Set to `1` to allow Depot control from other devices in LAN mode |

Back up the node by copying the `data` folder.

## Layout

```
server.js            HTTP server and API
server/              manual search, storage, telemetry, model link, depot
content/manual/      field manual (Markdown)
config/depot.json    container catalog
public/              interface: no build step, no external assets
data/                created at first run
```

## Notes

- The only outbound traffic is the uplink probe (a bare TCP connection) and whatever you deploy or download yourself.
- Map data is Natural Earth 1:110m (public domain), via the `world-atlas` package. It is for orientation, not route planning.
- The manual is a reference, not training, and not a substitute for professional medical care. Practise skills before you depend on them.

## License

Apache-2.0
