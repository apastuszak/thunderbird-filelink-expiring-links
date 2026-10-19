// Asks how to deliver a generated link password. Opened by background.js with ?tabId=<compose tab>.
// The password itself is fetched from the background page, never put in the URL.
const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = (id) => document.getElementById(id);

async function load() {
  const info = await browser.runtime.sendMessage({ type: "password:get", tabId });
  if (!info) {
    $("intro").textContent = "This message is no longer open.";
    for (const el of document.querySelectorAll("button, input")) el.disabled = true;
    return;
  }
  $("password").value = info.password;
  $("intro").textContent =
    info.links === 1
      ? "The link in your message is protected with this password. It is already on your clipboard."
      : "The links in your message share this password. It is already on your clipboard.";
  if (info.delivery && info.delivery !== "self") {
    document.querySelector(`input[value="${info.delivery}"]`).checked = true;
  }
}

$("copy-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("password").value);
  $("copied").textContent = "Copied.";
});

$("done-btn").addEventListener("click", async () => {
  const delivery = document.querySelector('input[name="delivery"]:checked').value;
  await browser.runtime.sendMessage({ type: "password:set", tabId, delivery, remember: $("remember").checked });
  window.close();
});

load();
