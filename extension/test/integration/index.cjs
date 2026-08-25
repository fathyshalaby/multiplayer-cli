/**
 * Runs inside a real VS Code, in the extension host.
 *
 * Everything else about the extension is tested against a stubbed editor API,
 * which is fast and proves the logic. It cannot prove the one thing that has
 * actually broken before: that VS Code will load this bundle and activate it.
 * That failure — `import.meta.url` being undefined once esbuild had made the
 * bundle CommonJS — passed every unit test and would have shipped an extension
 * that did nothing at all.
 */
const assert = require("node:assert");
const vscode = require("vscode");

const ID = "fathyshalaby.multiplayer-cli-vscode";

const COMMANDS = [
  "multiplayer.share",
  "multiplayer.join",
  "multiplayer.propose",
  "multiplayer.approve",
  "multiplayer.veto",
  "multiplayer.say",
  "multiplayer.stop",
  "multiplayer.copyLink",
  "multiplayer.leave",
];

exports.run = async function run() {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, `${ID} is not installed in this VS Code`);

  await ext.activate();
  assert.equal(ext.isActive, true, "the extension did not activate");

  const registered = await vscode.commands.getCommands(true);
  const missing = COMMANDS.filter((c) => !registered.includes(c));
  assert.deepEqual(missing, [], `commands declared but never registered: ${missing.join(", ")}`);

  // Every setting the extension reads must exist in the contributed schema, or
  // it silently gets `undefined` and falls back for reasons nobody can see.
  const cfg = vscode.workspace.getConfiguration("multiplayer");
  for (const key of ["backend", "policy", "relay", "lanes", "laneSetup"]) {
    assert.notEqual(cfg.inspect(key), undefined, `multiplayer.${key} is not a declared setting`);
  }
  assert.equal(cfg.get("lanes"), 3, "the default lane count should reach the extension");

  // Leaving with no session is the cheapest command that touches real state;
  // it should be a no-op rather than a stack trace in the user's window.
  await vscode.commands.executeCommand("multiplayer.leave");

  console.log(`ok — ${ID} activated in VS Code ${vscode.version} and registered ${COMMANDS.length} commands`);
};
