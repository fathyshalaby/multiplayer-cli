/**
 * The editor panel's markup, inlined so the extension ships as one bundled file
 * with no asset loading and no CSP exceptions.
 *
 * Everything here is presentation. The extension host holds the connection and
 * the keys; this only draws what it is given and posts back what was clicked.
 */
export function panelHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: transparent;
    display: flex; flex-direction: column; height: 100vh;
  }
  .idle { padding: 16px; }
  .idle p { color: var(--vscode-descriptionForeground); line-height: 1.5; }
  button {
    font: inherit; padding: 5px 12px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.ghost {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  header {
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
  }
  header .room { font-weight: 600; }
  header .meta, .dim { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .roster { padding: 6px 12px; display: flex; gap: 10px; flex-wrap: wrap; font-size: .9em; }
  .who { display: inline-flex; gap: 4px; align-items: center; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  main { flex: 1; overflow-y: auto; padding: 4px 12px 12px; }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--vscode-charts-blue);
    border-radius: 4px; padding: 8px 10px; margin: 8px 0;
    background: var(--vscode-editorWidget-background);
  }
  .card.tool { border-left-color: var(--vscode-charts-yellow); }
  .card.done { opacity: .55; border-left-color: var(--vscode-panel-border); }
  .card .head { font-size: .9em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .card .body { white-space: pre-wrap; word-break: break-word; }
  .card .btns { display: flex; gap: 6px; margin-top: 8px; }
  .row { margin: 2px 0; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  .model {
    border-left: 2px solid var(--vscode-charts-purple);
    padding-left: 8px; margin: 6px 0; white-space: pre-wrap;
  }
  .turn { color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: 10px; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px 12px; }
  .inputrow { display: flex; gap: 6px; }
  input[type=text] {
    flex: 1; font: inherit; padding: 5px 8px; border-radius: 3px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
  .hint { font-size: .85em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .warn { color: var(--vscode-editorWarning-foreground); }
</style>
</head>
<body>
<div id="idle" class="idle">
  <p><b>Share one AI session with your team.</b> Everyone sees the same transcript, and nothing is sent to the model until the room agrees.</p>
  <div style="display:flex;gap:8px;margin-top:12px">
    <button id="b-share">Share this folder</button>
    <button id="b-join" class="ghost">Join a session</button>
  </div>
  <p class="hint">Typing is proposing — a line of text becomes something the room votes on, not a message.</p>
</div>

<header id="chrome" hidden>
  <span class="room" id="room"></span>
  <span class="meta" id="meta"></span>
  <span style="margin-left:auto;display:flex;gap:6px">
    <button id="b-copy" class="ghost">Copy link</button>
    <button id="b-leave" class="ghost">Leave</button>
  </span>
</header>
<div class="roster" id="roster" hidden></div>
<main id="log" hidden></main>
<footer id="foot" hidden>
  <div class="inputrow">
    <input type="text" id="input" placeholder="Propose something to the room…" />
    <button id="b-send">Propose</button>
  </div>
  <div class="hint">Enter proposes. Prefix with <code>/say</code> to talk to the room only. <span id="crypto"></span></div>
</footer>

<script>
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const PALETTE = ["#4a8cf7","#b06ac9","#3f9d63","#c08a2e","#2f93a8","#c4534b","#7b5fd6","#4f8f3a"];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const color = (i) => PALETTE[(i || 0) % PALETTE.length];

  for (const [id, type] of [["b-share","share"],["b-join","join"],["b-copy","copy"],["b-leave","leave"]]) {
    $(id).onclick = () => vscode.postMessage({ type });
  }

  function submit() {
    const raw = $("input").value.trim();
    if (!raw) return;
    $("input").value = "";
    if (raw.startsWith("/say ")) vscode.postMessage({ type: "chat", text: raw.slice(5) });
    else if (raw === "/stop") vscode.postMessage({ type: "stop" });
    else vscode.postMessage({ type: "propose", text: raw });
  }
  $("b-send").onclick = submit;
  $("input").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  let stick = true;
  $("log").addEventListener("scroll", () => {
    const el = $("log");
    stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type !== "state") return;
    render(m.state);
  });

  function render(s) {
    const live = Boolean(s && s.connected);
    $("idle").hidden = live;
    for (const id of ["chrome", "roster", "log", "foot"]) $(id).hidden = !live;
    if (!live) return;

    $("room").textContent = s.room;
    $("meta").textContent = [s.backend, s.gate, s.agent !== "idle" ? s.agent : ""].filter(Boolean).join("  ·  ");
    $("crypto").innerHTML = s.encrypted
      ? '<span class="dim">End-to-end encrypted.</span>'
      : '<span class="warn">Not encrypted — this room has no token.</span>';

    $("roster").innerHTML = (s.participants || []).map((p) =>
      '<span class="who"><span class="dot" style="color:' + color(p.color) + '"></span>' + esc(p.name) +
      (p.role === "owner" ? ' <span class="dim">host</span>' : "") +
      (p.id === s.youId ? ' <span class="dim">you</span>' : "") + "</span>"
    ).join("");

    const cards = (s.proposals || []).filter((c) => c.open).map((c) =>
      '<div class="card' + (c.proposal.kind === "tool" ? " tool" : "") + '">' +
        '<div class="head"><b>' + esc(c.proposal.authorName) + "</b> " +
        (c.proposal.kind === "tool" ? "wants to run" : "proposes") + " <b>" + esc(c.proposal.id) + "</b></div>" +
        '<div class="body">' + esc(c.proposal.text) + "</div>" +
        '<div class="head" style="margin:6px 0 0">' + esc(c.progress) + "</div>" +
        '<div class="btns">' +
          '<button data-yes="' + esc(c.proposal.id) + '">Approve</button>' +
          '<button class="ghost" data-no="' + esc(c.proposal.id) + '">Veto</button>' +
        "</div>" +
      "</div>"
    ).join("");

    const log = (s.log || []).map((e) => {
      if (e.kind === "model") return '<div class="model">' + esc(e.text) + "</div>";
      if (e.kind === "chat")
        return '<div class="row">💬 <span style="color:' + color(e.color) + '">' + esc(e.who) + "</span>: " + esc(e.text) + "</div>";
      if (e.kind === "turn") return '<div class="turn">── ' + esc(e.text) + " ──</div>";
      return '<div class="row dim">' + esc(e.text) + "</div>";
    }).join("");

    $("log").innerHTML = cards + log;
    for (const b of $("log").querySelectorAll("[data-yes]"))
      b.onclick = () => vscode.postMessage({ type: "vote", id: b.getAttribute("data-yes"), text: "yes" });
    for (const b of $("log").querySelectorAll("[data-no]"))
      b.onclick = () => vscode.postMessage({ type: "veto", id: b.getAttribute("data-no") });

    if (stick) $("log").scrollTop = $("log").scrollHeight;
  }

  vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
