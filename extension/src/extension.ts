import * as vscode from "vscode";
import { hostname } from "node:os";
import { Connection } from "../../src/client/connection.js";
import { RoomServer } from "../../src/server/server.js";
import { LocalWsTransport, RelayTransport, type Transport } from "../../src/server/transport.js";
import { parseJoinTarget } from "../../src/util/url.js";
import { resolvePreset } from "../../src/core/policy.js";
import { detectBackend } from "../../src/util/detect.js";
import type { BackendName } from "../../src/agent/index.js";
import { roomName, token as makeToken } from "../../src/util/id.js";
import type { ServerMessage } from "../../src/protocol.js";
import { RoomView } from "../../src/client/roomView.js";
import { panelHtml } from "../../src/client/editorPanel.js";

/**
 * A seat in the editor.
 *
 * The extension host owns the connection, so the same client, protocol and
 * encryption the terminal uses run here unchanged — the webview is only a view,
 * which also keeps it clear of the secure-context rules browsers apply to
 * crypto. Cursor, VSCodium and Windsurf get this because it is a plain VS Code
 * extension published to Open VSX, with none of the licensing that keeps Live
 * Share off those editors.
 */

let session: Session | null = null;
let view: RoomPanel | null = null;
let status: vscode.StatusBarItem;

interface Session {
  conn: Connection;
  server: RoomServer | null;
  room: RoomView;
  shareUrl: string;
}

export function activate(context: vscode.ExtensionContext): void {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "multiplayer.focus";
  status.text = "$(circle-slash) multiplayer";
  status.tooltip = "No shared session";
  status.show();
  context.subscriptions.push(status);

  view = new RoomPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("multiplayer.room", view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const cmd = (name: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, fn));

  cmd("multiplayer.focus", () => vscode.commands.executeCommand("multiplayer.room.focus"));
  cmd("multiplayer.share", () => shareFolder());
  cmd("multiplayer.join", () => joinSession());
  cmd("multiplayer.propose", () => promptAnd("Propose to the room", (text) => send({ t: "propose", text })));
  cmd("multiplayer.say", () => promptAnd("Say something to the room", (text) => send({ t: "chat", text })));
  cmd("multiplayer.approve", () => vote("yes"));
  cmd("multiplayer.veto", () => vote("no"));
  cmd("multiplayer.stop", () => send({ t: "interrupt" }));
  cmd("multiplayer.copyLink", () => copyLink());
  cmd("multiplayer.leave", () => leave());

  context.subscriptions.push({ dispose: () => void leave() });
}

export function deactivate(): void {
  void leave();
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function shareFolder(): Promise<void> {
  if (session) {
    vscode.window.showWarningMessage("You are already in a session. Leave it first.");
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Open a folder first — a session needs a working directory.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("multiplayer");
  const chosen = cfg.get<string>("backend") || "";
  const detected = chosen ? null : detectBackend();
  const backend = (chosen || detected!.backend) as BackendName;
  const preset = cfg.get<string>("policy") || "team";
  const relay = cfg.get<string>("relay") || "";
  const cwd = folder.uri.fsPath;
  const name = roomName();
  const tok = makeToken();

  const transport: Transport = relay
    ? new RelayTransport({ url: relay, roomName: name, onWarn: (t) => vscode.window.showWarningMessage(t) })
    : new LocalWsTransport({ host: "0.0.0.0", port: 0, roomName: name, tls: null });

  const server = new RoomServer({
    transport,
    roomName: name,
    token: tok,
    policy: resolvePreset(preset)!,
    cwd,
    backend,
    model: backend === "anthropic" ? "claude-opus-5" : "",
    maxTokens: 32000,
    showThinking: false,
    systemPromptExtra: "",
    backendBin: "",
    backendArgs: [],
    permissionMode: "acceptEdits",
    resume: null,
    attach: null,
    pool: false,
    transcriptPath: null,
  });

  let info;
  try {
    info = await server.listen();
  } catch (err) {
    vscode.window.showErrorMessage(`Could not start the session: ${(err as Error).message}`);
    return;
  }

  const share = info.shareUrl(tok) ?? "";
  await connect(server.selfUrl(), name, tok, server, share);
  if (share) {
    await vscode.env.clipboard.writeText(share);
    const open = "Show link";
    const pick = await vscode.window.showInformationMessage(
      `Session ${name} started on ${backend}. Invite link copied to your clipboard.`,
      open,
    );
    if (pick === open) vscode.window.showInformationMessage(share, { modal: true });
  }
}

async function joinSession(): Promise<void> {
  if (session) {
    vscode.window.showWarningMessage("You are already in a session. Leave it first.");
    return;
  }
  const link = await vscode.window.showInputBox({
    title: "Join a shared AI session",
    prompt: "Paste the invite link",
    placeHolder: "https://relay.example.com/s/amber-ridge-04#t=…",
    ignoreFocusOut: true,
  });
  if (!link) return;

  const target = parseJoinTarget(link);
  if (!target.room) {
    vscode.window.showErrorMessage("That does not look like an invite link.");
    return;
  }
  await connect(target.url, target.room, target.token, null, link);
}

async function connect(
  url: string,
  room: string,
  tok: string | null,
  server: RoomServer | null,
  shareUrl: string,
): Promise<void> {
  const name = vscode.workspace.getConfiguration("multiplayer").get<string>("name") || hostname() || "editor";
  const conn = new Connection({ url, room, token: tok, name, reconnect: true });
  const roomView = new RoomView();
  roomView.setShareUrl(shareUrl);
  session = { conn, server, room: roomView, shareUrl };

  conn.on("open", () => {
    roomView.setConnected(true, conn.encrypted);
    refresh();
  });
  conn.on("message", (msg: ServerMessage) => {
    roomView.apply(msg);
    refresh();
  });
  conn.on("warn", (text: string) => vscode.window.showWarningMessage(text));
  conn.on("closed", (why: string) => {
    roomView.setConnected(false, false);
    refresh();
    vscode.window.showInformationMessage(`Left the session (${why}).`);
    void leave();
  });

  conn.connect();
  refresh();
  await vscode.commands.executeCommand("multiplayer.room.focus");
}

async function leave(): Promise<void> {
  const s = session;
  session = null;
  if (!s) return;
  s.conn.close();
  await s.server?.close();
  s.room.reset();
  refresh();
}

function send(msg: Parameters<Connection["send"]>[0]): void {
  if (!session) {
    vscode.window.showWarningMessage("You are not in a session.");
    return;
  }
  session.conn.send(msg);
}

async function promptAnd(title: string, fn: (text: string) => void): Promise<void> {
  if (!session) {
    vscode.window.showWarningMessage("You are not in a session.");
    return;
  }
  const text = await vscode.window.showInputBox({ title, ignoreFocusOut: true });
  if (text && text.trim()) fn(text.trim());
}

async function vote(v: "yes" | "no"): Promise<void> {
  if (!session) {
    vscode.window.showWarningMessage("You are not in a session.");
    return;
  }
  const id = session.room.defaultProposalId();
  if (!id) {
    vscode.window.showInformationMessage("Nothing is waiting on a decision.");
    return;
  }
  if (v === "no") {
    const why = await vscode.window.showInputBox({
      title: `Veto ${id}`,
      prompt: "Why not? Recorded with your veto.",
      ignoreFocusOut: true,
    });
    session.conn.send({ t: "vote", proposalId: id, vote: "no", ...(why?.trim() ? { comment: why.trim() } : {}) });
    return;
  }
  session.conn.send({ t: "vote", proposalId: id, vote: "yes" });
}

async function copyLink(): Promise<void> {
  if (!session?.shareUrl) {
    vscode.window.showWarningMessage("No invite link — you joined someone else's session.");
    return;
  }
  await vscode.env.clipboard.writeText(session.shareUrl);
  vscode.window.showInformationMessage("Invite link copied.");
}

function refresh(): void {
  const s = session;
  status.text = s ? s.room.statusText() : "$(circle-slash) multiplayer";
  status.tooltip = s ? `multiplayer — ${s.room.snapshot().room}` : "No shared session";
  view?.render(s ? s.room.snapshot() : null);
}

/* ------------------------------------------------------------------ */
/* the panel                                                           */
/* ------------------------------------------------------------------ */

class RoomPanel implements vscode.WebviewViewProvider {
  private webview: vscode.WebviewView | null = null;

  constructor(private readonly root: vscode.Uri) {}

  resolveWebviewView(v: vscode.WebviewView): void {
    this.webview = v;
    v.webview.options = { enableScripts: true, localResourceRoots: [this.root] };
    v.webview.html = panelHtml();
    v.webview.onDidReceiveMessage((m: { type: string; id?: string; text?: string }) => {
      switch (m.type) {
        case "ready":
          refresh();
          return;
        case "propose":
          if (m.text?.trim()) send({ t: "propose", text: m.text.trim() });
          return;
        case "chat":
          if (m.text?.trim()) send({ t: "chat", text: m.text.trim() });
          return;
        case "vote":
          if (m.id) send({ t: "vote", proposalId: m.id, vote: m.text === "no" ? "no" : "yes" });
          return;
        case "veto":
          if (m.id) void vetoWithReason(m.id);
          return;
        case "stop":
          send({ t: "interrupt" });
          return;
        case "share":
          void vscode.commands.executeCommand("multiplayer.share");
          return;
        case "join":
          void vscode.commands.executeCommand("multiplayer.join");
          return;
        case "copy":
          void copyLink();
          return;
        case "leave":
          void leave();
          return;
      }
    });
    refresh();
  }

  render(state: unknown): void {
    void this.webview?.webview.postMessage({ type: "state", state });
  }
}

async function vetoWithReason(id: string): Promise<void> {
  const why = await vscode.window.showInputBox({
    title: `Veto ${id}`,
    prompt: "Why not? Recorded with your veto.",
    ignoreFocusOut: true,
  });
  send({ t: "vote", proposalId: id, vote: "no", ...(why?.trim() ? { comment: why.trim() } : {}) });
}
