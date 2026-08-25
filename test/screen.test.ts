import test from "node:test";
import assert from "node:assert/strict";
import { applyKey, commonPrefix, newEditor, remember, type EditorState, type Key } from "../src/client/editor.js";
import { MIN_COLS, MIN_ROWS, fits, pad, render, spread, type Size } from "../src/client/layout.js";
import { Screen } from "../src/client/screen.js";
import { RoomView, type ViewState } from "../src/client/roomView.js";
import { PRESETS } from "../src/core/policy.js";
import { stripAnsi } from "../src/util/ansi.js";
import type { LaneInfo, Participant, Proposal, RoomSnapshot, Tally } from "../src/protocol.js";

/* ------------------------------------------------------------------ */
/* the line editor                                                     */
/* ------------------------------------------------------------------ */

/** Feed a string of ordinary characters, as typing them would. */
function type(state: EditorState, text: string): EditorState {
  let s = state;
  for (const ch of text) s = applyKey(s, ch, {}).state;
  return s;
}

function press(state: EditorState, key: Key, opts = {}) {
  return applyKey(state, key.sequence, key, opts);
}

test("typing inserts at the cursor, wherever the cursor happens to be", () => {
  let s = type(newEditor(), "add reties");
  assert.equal(s.text, "add reties");
  // Back over "ies" and put the missing r in, as anyone fixing this typo would.
  for (let i = 0; i < 3; i++) s = press(s, { name: "left" }).state;
  s = type(s, "r");
  assert.equal(s.text, "add retries");
  assert.equal(s.cursor, "add retr".length);
});

test("the usual shell editing keys do the usual things", () => {
  let s = type(newEditor(), "one two three");
  s = press(s, { name: "w", ctrl: true }).state;
  assert.equal(s.text, "one two ");

  s = press(s, { name: "a", ctrl: true }).state;
  assert.equal(s.cursor, 0);
  s = press(s, { name: "k", ctrl: true }).state;
  assert.equal(s.text, "");

  s = type(s, "hello");
  s = press(s, { name: "backspace" }).state;
  assert.equal(s.text, "hell");
  s = press(s, { name: "home" }).state;
  s = press(s, { name: "delete" }).state;
  assert.equal(s.text, "ell");
  s = press(s, { name: "end" }).state;
  s = press(s, { name: "u", ctrl: true }).state;
  assert.equal(s.text, "");
});

test("Ctrl-D leaves only on an empty line, so it cannot eat a half-typed proposal", () => {
  const typed = type(newEditor(), "half a thought");
  assert.equal(press(typed, { name: "d", ctrl: true }).action.kind, "none");
  assert.equal(press(newEditor(), { name: "d", ctrl: true }).action.kind, "quit");
});

test("submitting clears the line and remembers it", () => {
  const s = type(newEditor(), "add retries");
  const { state, action } = press(s, { name: "return" });
  assert.deepEqual(action, { kind: "submit", text: "add retries" });
  assert.equal(state.text, "");
  assert.deepEqual(state.history, ["add retries"]);
});

test("history walks back and returns to what was being typed", () => {
  let s = newEditor(["first", "second"]);
  s = type(s, "unfinished");
  s = press(s, { name: "up" }).state;
  assert.equal(s.text, "second");
  s = press(s, { name: "up" }).state;
  assert.equal(s.text, "first");
  s = press(s, { name: "up" }).state;
  assert.equal(s.text, "first", "the top of the history is the top");
  s = press(s, { name: "down" }).state;
  s = press(s, { name: "down" }).state;
  assert.equal(s.text, "unfinished", "the draft comes back");
});

test("typing abandons history browsing, as a shell does", () => {
  let s = newEditor(["first"]);
  s = press(s, { name: "up" }).state;
  s = type(s, "!");
  assert.equal(s.text, "first!");
  s = press(s, { name: "down" }).state;
  assert.equal(s.text, "first!", "down is a no-op once you have started editing");
});

test("history does not record blanks or immediate repeats", () => {
  assert.deepEqual(remember(["a"], "   "), ["a"]);
  assert.deepEqual(remember(["a"], "a"), ["a"]);
  assert.deepEqual(remember(["a"], "b"), ["a", "b"]);
});

test("tab completes a unique command and offers the rest", () => {
  const complete = (line: string) => ["/race", "/rename", "/relay"].filter((n) => n.startsWith(line));
  let s = type(newEditor(), "/rac");
  const one = press(s, { name: "tab" }, { complete });
  assert.equal(one.state.text, "/race ", "a finished word gets its space");
  assert.equal(one.action.kind, "none");

  s = type(newEditor(), "/r");
  const many = press(s, { name: "tab" }, { complete });
  assert.equal(many.state.text, "/r", "no common prefix beyond what was typed");
  assert.equal(many.action.kind, "suggest");
  assert.deepEqual((many.action as { options: string[] }).options, ["/race", "/rename", "/relay"]);
});

test("common prefixes are computed, not guessed", () => {
  assert.equal(commonPrefix(["/race", "/rename"]), "/r");
  assert.equal(commonPrefix(["/queue", "/queue"]), "/queue");
  assert.equal(commonPrefix([]), "");
});

test("Ctrl-C and the page keys are decisions for the caller, not edits", () => {
  assert.equal(press(type(newEditor(), "x"), { name: "c", ctrl: true }).action.kind, "interrupt");
  assert.deepEqual(press(newEditor(), { name: "pageup" }, { page: 12 }).action, { kind: "scroll", delta: 12 });
  assert.deepEqual(press(newEditor(), { name: "pagedown" }, { page: 12 }).action, { kind: "scroll", delta: -12 });
  assert.equal(press(newEditor(), { name: "l", ctrl: true }).action.kind, "redraw");
});

/* ------------------------------------------------------------------ */
/* the layout                                                          */
/* ------------------------------------------------------------------ */

function participant(over: Partial<Participant> = {}): Participant {
  return { id: "p1", name: "alice", color: 0, role: "member", joinedAt: 0, connected: true, typing: false, ...over };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "#1",
    kind: "prompt",
    authorId: "p1",
    authorName: "alice",
    text: "add retries to the http client",
    createdAt: 0,
    deadline: null,
    votes: {},
    edits: [],
    status: "open",
    ...over,
  };
}

function tally(over: Partial<Tally> = {}): Tally {
  return { yes: 1, no: 0, abstain: 0, pending: ["p2"], electorate: 2, need: 1, decision: "pending", reason: "", ...over };
}

function snapshot(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: "room_1",
    name: "amber-ridge",
    cwd: "/work/api",
    policy: PRESETS.team!,
    participants: [participant(), participant({ id: "p2", name: "bob", color: 1 })],
    proposals: [],
    agent: { state: "idle", turnId: null, model: "opus", backend: "claude-code" },
    queued: [],
    micHolderId: null,
    transcriptPath: "/work/api/.mpx/amber-ridge.jsonl",
    turnCount: 3,
    runners: [],
    activeRunnerId: null,
    lanes: [],
    laneCount: 3,
    crossroads: null,
    ...over,
  };
}

function viewOf(room: RoomSnapshot, extra: (v: RoomView) => void = () => {}): ViewState {
  const view = new RoomView(() => 1000);
  view.setConnected(true, true);
  view.apply({ t: "welcome", you: room.participants[0]!, room });
  extra(view);
  return view.snapshot();
}

function frame(view: ViewState, size: Size = { cols: 100, rows: 24 }, over = {}) {
  return render(size, { view, input: { text: "", cursor: 0 }, scroll: 0, now: 1000, ...over });
}

function plain(f: { lines: string[] }): string[] {
  return f.lines.map(stripAnsi);
}

test("a frame is exactly the size of the terminal, to the column", () => {
  const f = frame(viewOf(snapshot()), { cols: 97, rows: 21 });
  assert.equal(f.lines.length, 21);
  for (const line of f.lines) assert.equal(stripAnsi(line).length, 97);
});

test("the header names the room, the backend and the gate", () => {
  const head = plain(frame(viewOf(snapshot())))[0]!;
  assert.match(head, /amber-ridge/);
  assert.match(head, /claude-code\/opus/);
  assert.match(head, /majority\+veto/);
  assert.match(head, /2 seats/);
  assert.match(head, /encrypted/);
});

test("an unencrypted room says so where it cannot be missed", () => {
  const view = new RoomView(() => 1000);
  view.setConnected(true, false);
  view.apply({ t: "welcome", you: snapshot().participants[0]!, room: snapshot() });
  assert.match(plain(frame(view.snapshot()))[0]!, /unencrypted/);
});

test("the sidebar carries the roster, the open votes and the lanes", () => {
  const room = snapshot({ lanes: [lane("A", "done", "3 files +64 -12"), lane("B", "running")] });
  const view = viewOf(room, (v) => {
    v.apply({ t: "proposal", proposal: proposal(), tally: tally(), event: "new" });
  });
  const text = plain(frame(view)).join("\n");
  assert.match(text, /ROOM/);
  assert.match(text, /alice/);
  assert.match(text, /bob/);
  assert.match(text, /DECIDING/);
  assert.match(text, /#1/);
  assert.match(text, /LANES/);
  assert.match(text, /3 files \+64 -12/);
});

test("an overflowing sidebar drops the oldest, never the vote that just arrived", () => {
  const view = viewOf(snapshot(), (v) => {
    for (let i = 1; i <= 8; i++) {
      v.apply({
        t: "proposal",
        proposal: proposal({ id: `#${i}`, text: `proposal number ${i}` }),
        tally: tally(),
        event: "new",
      });
    }
  });
  const text = plain(frame(view, { cols: 100, rows: 20 })).join("\n");
  assert.match(text, /#8/, "the newest vote survives the squeeze");
  assert.doesNotMatch(text, /#1\b/, "the oldest is what gives way");
});

test("a lane vote is labelled by its lane, in lane order", () => {
  const view = viewOf(snapshot({ lanes: [lane("A", "done", "1 file +1"), lane("B", "done", "9 files +2")] }), (v) => {
    for (const id of ["A", "B"]) {
      v.apply({
        t: "proposal",
        proposal: proposal({ id: `#${id}`, kind: "lane", lane: id, authorName: "race", text: `land lane ${id}` }),
        tally: tally(),
        event: "new",
      });
    }
  });
  const text = plain(frame(view)).join("\n");
  assert.match(text, /lane A[\s\S]*lane B/, "A is listed before B");
  assert.doesNotMatch(text, /#A lane\b(?! A)/);
});

test("a narrow terminal drops the sidebar rather than mangling it", () => {
  const room = snapshot();
  const view = viewOf(room, (v) => {
    v.apply({ t: "proposal", proposal: proposal(), tally: tally(), event: "new" });
  });
  const wide = plain(frame(view, { cols: 100, rows: 24 })).join("\n");
  const narrow = plain(frame(view, { cols: 70, rows: 24 })).join("\n");
  assert.match(wide, /DECIDING/);
  assert.doesNotMatch(narrow, /DECIDING/);
  assert.doesNotMatch(narrow, /│/, "no divider once there is nothing beside it");
});

test("terminals too small for panes are refused, not squeezed", () => {
  assert.equal(fits({ cols: MIN_COLS, rows: MIN_ROWS }), true);
  assert.equal(fits({ cols: MIN_COLS - 1, rows: MIN_ROWS }), false);
  assert.equal(fits({ cols: MIN_COLS, rows: MIN_ROWS - 1 }), false);
});

test("the model's reply fills the transcript, newest at the bottom", () => {
  const view = viewOf(snapshot(), (v) => {
    v.apply({ t: "turnStart", turnId: "t1", prompt: "p", contributors: ["alice"] });
    for (const word of ["Here ", "is ", "the ", "answer."]) {
      v.apply({ t: "delta", turnId: "t1", kind: "text", text: word });
    }
  });
  const lines = plain(frame(view));
  const body = lines.slice(2, -3);
  assert.match(body[body.length - 1]!, /Here is the answer\./);
  assert.match(body.join("\n"), /sending to the model/);
});

test("scrolling back holds position and says how far down the bottom is", () => {
  const view = viewOf(snapshot(), (v) => {
    for (let i = 0; i < 60; i++) v.apply({ t: "notice", level: "info", text: `line ${i}` });
  });
  const bottom = plain(frame(view)).join("\n");
  assert.match(bottom, /line 59/);

  const back = plain(frame(view, { cols: 100, rows: 24 }, { scroll: 20 }));
  assert.match(back.join("\n"), /20 more lines below/);
  assert.doesNotMatch(back.join("\n"), /line 59/);
});

test("the input line scrolls under a fixed prompt instead of wrapping", () => {
  const view = viewOf(snapshot());
  const long = "x".repeat(300);
  const f = frame(view, { cols: 100, rows: 24 }, { input: { text: long, cursor: long.length } });
  const lines = plain(f);
  const inputRow = lines[lines.length - 2]!;
  assert.equal(inputRow.length, 100);
  assert.match(inputRow, /^alice ❯ x+ *$/);
  assert.equal(f.cursor.row, lines.length - 2, "the cursor sits on the input line");
  assert.ok(f.cursor.col < 100, "and inside the terminal");
});

test("the status line says what is waiting on you, and what the model is doing", () => {
  const idle = plain(frame(viewOf(snapshot())));
  assert.match(idle[idle.length - 1]!, /type to propose/);

  const busy = viewOf(snapshot(), (v) => {
    v.apply({ t: "proposal", proposal: proposal(), tally: tally(), event: "new" });
    v.apply({ t: "agent", status: { state: "tool", turnId: "t1", model: "opus", backend: "claude-code", detail: "bash: rm -rf build/" } });
  });
  const line = plain(frame(busy)).pop()!;
  assert.match(line, /tool/);
  assert.match(line, /rm -rf build/);
  assert.match(line, /1 awaiting a decision/);
});

test("a hint replaces the status line, and only the status line", () => {
  const view = viewOf(snapshot());
  const f = plain(frame(view, { cols: 100, rows: 24 }, { hint: "/race  /rename  /relay" }));
  assert.match(f[f.length - 1]!, /\/race {2}\/rename {2}\/relay/);
  assert.match(f[f.length - 2]!, /alice ❯/);
});

test("spread and pad measure visible width, not escape sequences", () => {
  const line = spread("\x1b[1mleft\x1b[22m", "\x1b[2mright\x1b[22m", 20);
  assert.equal(stripAnsi(line).length, 20);
  assert.equal(stripAnsi(line), "left           right");
  assert.equal(stripAnsi(pad("\x1b[31mabc\x1b[39m", 6)), "abc   ");
  assert.equal(stripAnsi(pad("abcdefgh", 4)), "abc…");
});

function lane(id: string, state: LaneInfo["state"], summary = ""): LaneInfo {
  return {
    id,
    turnId: "t1",
    branch: `mpx/room/t1/${id.toLowerCase()}`,
    dir: `/tmp/lanes/${id}`,
    backend: "claude-code",
    state,
    summary,
    detail: "",
    commit: null,
    proposalId: null,
    startedAt: 0,
    endedAt: null,
  };
}

/* ------------------------------------------------------------------ */
/* the diffing renderer                                                */
/* ------------------------------------------------------------------ */

class FakeOut {
  written = "";
  write(s: string): void {
    this.written += s;
  }
}

test("the screen enters and leaves the alternate buffer, once each", () => {
  const out = new FakeOut();
  const screen = new Screen(out);
  screen.enter();
  screen.enter();
  assert.equal(out.written.split("\x1b[?1049h").length - 1, 1);
  screen.leave();
  screen.leave();
  assert.equal(out.written.split("\x1b[?1049l").length - 1, 1);
  assert.match(out.written, /\x1b\[\?25h\x1b\[\?1049l$/, "the cursor comes back before the buffer does");
});

test("only the lines that changed are rewritten", () => {
  const out = new FakeOut();
  const screen = new Screen(out);
  screen.enter();
  const first = { lines: ["one", "two", "three"], cursor: { row: 2, col: 0 } };
  screen.draw(first);
  const afterFirst = screen.bytes;

  out.written = "";
  screen.draw({ lines: ["one", "TWO", "three"], cursor: { row: 2, col: 0 } });
  assert.match(out.written, /TWO/);
  assert.doesNotMatch(out.written, /three/);
  assert.ok(screen.bytes - afterFirst < afterFirst, "a one-line change costs less than a full paint");
});

test("an identical frame writes nothing but the cursor", () => {
  const out = new FakeOut();
  const screen = new Screen(out);
  screen.enter();
  const f = { lines: ["a", "b"], cursor: { row: 1, col: 0 } };
  screen.draw(f);
  out.written = "";
  screen.draw({ lines: ["a", "b"], cursor: { row: 1, col: 0 } });
  assert.doesNotMatch(out.written, /a|b/);
});

test("invalidating forces the next frame to repaint in full", () => {
  const out = new FakeOut();
  const screen = new Screen(out);
  screen.enter();
  screen.draw({ lines: ["a", "b"], cursor: { row: 0, col: 0 } });
  screen.invalidate();
  out.written = "";
  screen.draw({ lines: ["a", "b"], cursor: { row: 0, col: 0 } });
  assert.match(out.written, /a/);
  assert.match(out.written, /b/);
});

test("a screen that was never entered draws nothing at all", () => {
  const out = new FakeOut();
  new Screen(out).draw({ lines: ["a"], cursor: { row: 0, col: 0 } });
  assert.equal(out.written, "");
});

test("a shrinking frame clears the rows it no longer uses", () => {
  const out = new FakeOut();
  const screen = new Screen(out);
  screen.enter();
  screen.draw({ lines: ["a", "b", "c"], cursor: { row: 0, col: 0 } });
  out.written = "";
  screen.draw({ lines: ["a"], cursor: { row: 0, col: 0 } });
  assert.match(out.written, /\x1b\[2;1H\x1b\[2K/, "row 2 is blanked");
  assert.match(out.written, /\x1b\[3;1H\x1b\[2K/, "row 3 is blanked");
});
