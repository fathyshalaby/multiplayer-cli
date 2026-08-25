# Contributing

Thanks for looking. Issues and pull requests are welcome.

This project is [MIT licensed](./LICENSE). By contributing you agree your
contribution is licensed on the same terms.

## Getting set up

```bash
npm install
npm run build
npm test
```

Node 20.11+. The tests need no API key and no coding CLI: backends are covered
by stub binaries, and the model is covered by an offline backend.

The browser-seat tests want Playwright and a Chromium. Both are optional — the
suite skips them cleanly if they are missing:

```bash
npm install playwright && npx playwright install chromium
```

## Trying it without spending anything

```bash
npm run build && node dist/src/cli.js share --backend echo --policy pair
```

Open a second terminal, run the printed `mpx join …`, and you have a two-seat
room driven by a deterministic offline backend.

## Where things live

```
src/protocol.ts       the wire contract
src/core/gate.ts      the consent decision — pure, no clock of its own
src/core/room.ts      participants, proposals, timers, queue
src/core/policy.ts    presets and overrides
src/server/transport  how seats arrive: a local port, or a relay dialled out to
src/server/relay.ts   the relay — a pipe that knows as little as possible
src/server/server.ts  the room, wired to the session
src/server/runners.ts routing turns across accounts (experimental)
src/agent/profiles.ts one small profile per coding CLI
src/agent/process.ts  the shared process driver those profiles plug into
src/client/           connection, commands, terminal UI
src/client/web/       the browser seat — one self-contained page, no build step
```

## House rules

**Keep `gate.ts` pure.** Same inputs, same verdict, with `now` passed in. Every
voting rule is a unit test, and that is only possible because it does not reach
for a clock.

**Add a CLI as a profile, not a class.** See [docs/backends.md](./docs/backends.md).

**Test against stubs, not against the real tool.** A stub emitting exactly what
a tool documents covers argv construction, session capture, resume, interrupts
and error surfacing — and it runs in CI without credentials.

**Fail closed.** An unrecognised tool is classified as the most dangerous kind.
An unknown policy key is an error, not a silent no-op. A vote that cannot be
decided stays open rather than defaulting to send.

**Say what changed and why in the commit message.** The reasoning is the part
that is expensive to reconstruct later.

## Before you open a PR

```bash
npm test
```

Green suite, and mention anything you could not verify.
