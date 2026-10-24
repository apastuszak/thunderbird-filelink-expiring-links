// Local pending actions load independently of the server-backed share list, including offline.
const accountId = new URLSearchParams(location.search).get("accountId");
const $ = (id) => document.getElementById(id);
const active = new Set();
let generation = 0;

async function act(job, discard) {
  if (active.has(job.key)) return;
  if (discard && !confirm(job.kind === "password"
    ? "Discard this password email? This may delete the only remaining copy of its passwords. The recipients may be unable to open their links. No email will be sent."
    : "Discard this cleanup? Uploaded files and any remaining shares will stay on the server. No further cleanup retry will be made for this job.")) return;
  active.add(job.key);
  for (const row of $("pending-list").children) {
    if (row.dataset.key === job.key) for (const button of row.querySelectorAll("button")) button.disabled = true;
  }
  $("pending-result").textContent = discard ? "Discarding…" : "Retrying…";
  try {
    const result = await browser.runtime.sendMessage({
      type: discard ? "pending:discard" : "pending:retry", accountId, key: job.key,
    });
    $("pending-result").textContent = result?.message || "No response. Refresh pending actions and try again.";
  } catch {
    $("pending-result").textContent = "Could not contact the add-on. Refresh pending actions and try again.";
  } finally {
    active.delete(job.key);
    await loadPending();
  }
}

function render(job) {
  const row = document.createElement("li");
  row.dataset.key = job.key;
  const title = document.createElement("strong");
  title.textContent = job.title;
  const description = document.createElement("p");
  description.textContent = job.description;
  row.append(title, description);
  if (job.createdAt) {
    const date = document.createElement("p");
    date.className = "hint";
    date.textContent = `Saved ${new Date(job.createdAt).toLocaleString()}`;
    row.append(date);
  }
  const reason = document.createElement("p");
  reason.textContent = job.busy ? "An attempt is already running…" : (job.lastError || "The previous attempt did not complete. You can retry now.");
  row.append(reason);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = job.kind === "password" ? "Open password email" : "Retry now";
  retry.addEventListener("click", () => act(job, false));
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "danger";
  discard.textContent = "Discard";
  discard.addEventListener("click", () => act(job, true));
  retry.disabled = discard.disabled = job.busy || active.has(job.key);
  row.append(retry, discard);
  return row;
}

async function loadPending() {
  const request = ++generation;
  $("pending-refresh").disabled = true;
  $("pending-status").textContent = "Loading…";
  try {
    const response = await browser.runtime.sendMessage({ type: "pending:list", accountId });
    if (request !== generation) return;
    if (!Array.isArray(response?.jobs)) throw new Error("No list returned");
    $("pending-list").replaceChildren(...response.jobs.map(render));
    const count = response.jobs.length;
    $("pending-status").textContent = count ? `${count} pending ${count === 1 ? "action" : "actions"}.` : "No pending actions.";
  } catch {
    if (request !== generation) return;
    $("pending-list").replaceChildren();
    $("pending-status").textContent = "Could not load pending actions. Try refreshing.";
  } finally {
    if (request === generation) $("pending-refresh").disabled = false;
  }
}

$("pending-refresh").addEventListener("click", loadPending);
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((key) =>
    key.startsWith("pendingDelete:") || key.startsWith("pendingPasswordEmail:") || key === "accounts")) loadPending();
});
loadPending();
