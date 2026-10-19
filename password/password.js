// Asks how to deliver a generated link password. Opened by background.js with ?tabId=<compose tab>.
// The password itself is fetched from the background page, never put in the URL.
// Every change applies immediately, so closing the window keeps whatever it shows.
const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = (id) => document.getElementById(id);
const selected = () => document.querySelector('input[name="delivery"]:checked').value;

async function copyPassword() {
  try {
    await navigator.clipboard.writeText($("password").value);
    $("copied").textContent = "Copied.";
  } catch {
    $("copied").textContent = "Could not copy. Select the password and copy it by hand.";
  }
}

function save() {
  return browser.runtime.sendMessage({ type: "password:set", tabId, delivery: selected(), remember: $("remember").checked });
}

async function load() {
  const info = await browser.runtime.sendMessage({ type: "password:get", tabId });
  if (!info) {
    $("intro").textContent = "This message is no longer open.";
    for (const el of document.querySelectorAll("button, input")) el.disabled = true;
    return;
  }
  $("password").value = info.password;
  $("intro").textContent =
    info.links === 1 ? "The link in your message is protected with this password." : "The links in your message share this password.";
  document.querySelector(`input[name="delivery"][value="${info.delivery || "separate"}"]`).checked = true;
}

$("copy-btn").addEventListener("click", copyPassword);

for (const radio of document.querySelectorAll('input[name="delivery"]')) {
  radio.addEventListener("change", async () => {
    await save();
    // Only copy when the user will paste it somewhere themselves.
    if (selected() === "self") await copyPassword();
  });
}
$("remember").addEventListener("change", save);
$("done-btn").addEventListener("click", () => window.close());

load();
