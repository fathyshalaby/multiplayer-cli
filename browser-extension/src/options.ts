import type { RoomSettings } from "./background.js";

const FIELDS: (keyof RoomSettings)[] = ["roomUrl", "roomName", "roomToken", "seatName", "backendLabel"];

function el(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

async function restore(): Promise<void> {
  const stored = await chrome.storage.local.get(FIELDS);
  for (const field of FIELDS) {
    const value = stored[field];
    if (typeof value === "string") el(field).value = value;
  }
}

async function save(): Promise<void> {
  const values: Record<string, string> = {};
  for (const field of FIELDS) values[field] = el(field).value.trim();
  await chrome.storage.local.set(values);
  const status = document.getElementById("status")!;
  status.textContent = "Saved. Reopen the site tab for it to take effect.";
  setTimeout(() => {
    status.textContent = "";
  }, 3000);
}

document.getElementById("save")!.addEventListener("click", () => void save());
void restore();
