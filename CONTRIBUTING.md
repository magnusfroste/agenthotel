# Contributing to AgentHotel

Thank you for looking. AgentHotel is small enough that one pull request can
change it noticeably, and a new template is often the whole of a useful
contribution.

## Where to start

- **Add a template.** This is the easiest way in, and the one that helps the
  most people. A template is one `templates/<id>/meta.yaml` file: the card in
  the library (name, icon, description, instructions) plus a `deploy:` block
  that says how to run the app — a Docker image, a compose file or a Git
  repository with a Dockerfile — and which secrets to generate. No frontend
  change is needed. Good examples to copy:
  [`lobby`](templates/lobby/meta.yaml) (a Git repository),
  [`agentreports`](templates/agentreports/meta.yaml) (generated keys and a
  health check) and [`skillhub`](templates/skillhub/meta.yaml) (a compose stack).
  Add a test for it in `backend/test/templates.test.js`, like the ones already
  there.
- **Issues labelled
  [`good first issue`](https://github.com/magnusfroste/agenthotel/labels/good%20first%20issue)**
  are scoped so you do not need to know the whole panel first.
- **Bugs you hit yourself.** If something broke on your own server, you are the
  best person to fix it. Open an issue first if the fix is not obvious, so we
  can agree on the approach before you spend an evening on it.
- **Documentation.** The [manual](docs/MANUAL.md) is written for people running
  a hotel. If a step was unclear to you, it is unclear to others.

Larger changes, such as a new runtime in `backend/plugins/` or anything that
touches routing or authentication, are welcome too. Please open an issue to
discuss it before you write the code.

## How the code is laid out

[AGENTS.md](AGENTS.md) is the architecture document: the three containers, how
Caddy routes are managed, how deploys are queued and logged, and the reasons
behind decisions that look odd at first. It is written so that an AI coding
agent can work from it as well. If you use one, point it there.

- `backend/server.js` is the Express API and the Docker work. `backend/lib/`
  holds the parts with their own tests. `backend/plugins/` holds one file per
  runtime.
- `frontend/src/` is the React panel (Vite).
- `templates/` holds the template library.
- `docker/` holds the Caddy configuration and the files the containers are
  built from.

## Running the tests

The backend has a test suite (`backend/test/*.test.js`, `node:test`). GitHub
Actions runs it on every push and pull request, together with a syntax check
of every backend file and a frontend build. You can run the suite without Node
on your machine:

```bash
docker run --rm -v $PWD:/src:ro node:22-alpine sh -c "apk add -q python3 make g++ >/dev/null; cp -r /src /w && cd /w/backend && npm ci --silent && npm test"
```

## Trying a change in a real panel

The panel manages Docker on the machine it runs on. Use a throwaway VPS or a
virtual machine rather than your laptop's own Docker. A small cloud VM is
enough.

```bash
git clone https://github.com/<you>/agenthotel.git && cd agenthotel && ./install.sh
# after each change:
docker compose build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)
docker compose up -d
docker compose logs -f backend
```

## What a good pull request looks like

- **One change per pull request**, with a description of what was wrong or
  missing and how you checked that the change works.
- **Tests for logic.** If you can write a function so that it can be tested
  without Docker (most of `backend/lib/` is written that way), do so and add
  the test.
- **Comments explain why, not what.** The codebase records the incident behind
  a decision ("a build died at step 7/18 when the panel was upgraded") so that
  the next person does not undo it. Please keep that up.
- **Guests are untrusted.** Every agent on a hotel may be hostile. Nothing a
  guest can reach (the Docker network it shares with Caddy, its own container)
  may give it the panel's API, Caddy's admin API or another guest's secrets.
  The README's [Security model](README.md#security-model) section has the
  details.
- **Secrets on screen** carry a `data-secret` attribute, so that a screen
  recording can blur them (see AGENTS.md).

## Reporting a security problem

Please do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
