# The terminal seat

What `mpx share` and `mpx join` put on your screen.

## The layout

A full-screen seat: the model's reply on the left, and everything you need to
keep an eye on — who is here, what is waiting on your vote, how the lanes are
doing — in a pane beside it.

```
 amber-ridge  ·  claude-code/opus  ·  majority+veto 45s        3 seats · encrypted
 ─────────────────────────────────────────────────────────────────────────────────
 ── sending to the model (alice) ─────────────────────│ ROOM
 │ I'll add a retry wrapper around the fetch call and │ ● alice  host you
 │ back off exponentially between attempts.           │ ● bob
 │                                                    │ ● carol  observer
 ── turn complete ────────────────────────────────────│
                                                      │ DECIDING
                                                      │ ▸ #7 bob
                                                      │   cap the backoff at 30s
                                                      │   1/3 ✓ · 2 pending · 18s
                                                      │
                                                      │ LANES
                                                      │ ✓ A 3 files +64 -12
                                                      │ · B no changes
                                                      │ ✓ C 1 file +8 -3
 ─────────────────────────────────────────────────────────────────────────────────
 alice ❯ cap it at 30s
 1 awaiting a decision                                                    7 turns
```

The sidebar exists because of racing. A room used to be one conversation in one
column, but a race is several agents working at once, and "which lane is
winning" should not scroll away under the model's next paragraph.

## Keys

| | |
|---|---|
| `Enter` | send — bare text is a proposal, `/…` is a command |
| `Tab` | complete a command; twice shows the candidates |
| `↑` `↓` | walk back through what you have sent |
| `PgUp` `PgDn` | scroll the transcript; new output waits rather than yanking you down |
| `Ctrl-C` | interrupt the model — again, with nothing running, leaves |
| `Ctrl-D` | leave, but only on an empty line |
| `Ctrl-L` | repaint, for when something else has written over the screen |
| `Ctrl-A` `Ctrl-E` `Ctrl-K` `Ctrl-U` `Ctrl-W` | the usual line editing |

The input line scrolls under a fixed prompt rather than wrapping, so a long
proposal never pushes the transcript around while you are still writing it.

## The one-column mode

There is a plain seat too — one scrolling column above a prompt. It is not a
lesser fallback; it is the right thing in a pipe, in CI, in a narrow pane, and
in any terminal that will not do alternate screens.

It is chosen automatically when:

- stdin or stdout is not a terminal (piped, redirected, or under CI),
- `TERM=dumb`,
- the window is under 60 columns or 14 rows,
- `--plain` or `MPX_PLAIN=1` says so.

```bash
mpx share --plain
mpx join <link> --plain
```

Between 60 and 84 columns the sidebar is dropped and the transcript takes the
whole width. Open votes still appear inline, as they do in the plain seat, so
nothing becomes unreachable on a narrow terminal.

---

## How it is built

*You only need this section if you are changing the terminal UI.*

Five pieces, only one of which needs a terminal:

| | |
|---|---|
| `src/client/roomView.ts` | accumulates the room from its own messages — shared with the editor extension |
| `src/client/layout.ts` | `(state, size) → lines`. Pure: no cursor, no stdout, no clock of its own |
| `src/client/editor.ts` | `(keystroke) → new line state + an action`. Pure |
| `src/client/screen.ts` | writes a frame, rewriting only the lines that changed |
| `src/client/fullscreen.ts` | the wiring, and the only part that needs a real terminal |

Splitting it this way is what makes terminal layout testable at all. The tests
hand `layout` a room and read the strings back, and hand `editor` keys and read
the buffer back. A frame is exactly `rows` lines of exactly `cols` visible
columns — measured ignoring escape sequences — so assertions can be precise
rather than approximate.

`screen` keeps the previous frame and sends only the differences. A full repaint
on every keystroke is what makes a terminal UI flicker, and what makes it
unusable over ssh; typing one character costs a few dozen bytes instead of a few
kilobytes.

## The recording in the README

`./scripts/record-demo.sh` drives the real binary in a real terminal, types real
commands into it, and renders whatever came back to `docs/media/session.svg`.
Nobody draws the demo, so the picture cannot quietly stop matching the tool.

It needs `script` (util-linux) for the pty. Two things are worth knowing if you
touch it:

- **The timing log counts bytes, and the stream is UTF-8.** Slicing the decoded
  string instead drifts the moment a box-drawing character appears, which is
  immediately, and every chunk after that is nonsense.
- **Frame boundaries come from the stream, not the timing.** `script` buffers
  its own reads, so its chunks have nothing to do with the app's writes. A
  completed repaint ends by parking the cursor and showing it; sampling anywhere
  else catches a half-updated screen, which shows up as duplicated lines.

---

[← All documentation](./README.md)
