const params = new URLSearchParams(location.search);
const fromExplained = params.get("from") === "explained" || params.get("fresh") === "1";
const wantedAddress = String(params.get("address") || "").trim();
const wantedDomain = String(params.get("domain") || "").trim();
const openCreate = params.get("create") === "1";

if (fromExplained) {
  try {
    localStorage.setItem("kachat-session-logged-out-v1", "true");
    sessionStorage.removeItem("kachat-session-active-v1");
  } catch {}
}

function shortAddress(address) {
  const a = String(address || "");
  if (a.length <= 22) return a;
  return `${a.slice(0, 12)}…${a.slice(-8)}`;
}

function paintBanner() {
  const host = document.querySelector("[data-explained-handoff]");
  if (!host) return;
  if (!fromExplained && !wantedAddress && !wantedDomain) {
    host.hidden = true;
    return;
  }
  const who = wantedDomain || (wantedAddress ? shortAddress(wantedAddress) : "");
  const safe = String(who).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  host.hidden = false;
  host.innerHTML = who
    ? `<p>From Kaspa Explained. Continue as <strong>${safe}</strong>.</p>
       <p>Log in with Kasware or Kastle, or sign in to the matching saved account. Approve the wallet popup.</p>
       <p><a href="/kachat">Back to wallet choice</a></p>`
    : `<p>From Kaspa Explained. You skipped the wallet step.</p>
       <p>Log in with Kasware or Kastle here. Approve the wallet popup. Or create / import an account.</p>
       <p><a href="/kachat">Back to wallet choice</a></p>`;
}

function highlightMatchingAccount() {
  if (!wantedAddress) return;
  document.querySelectorAll("[data-saved-account-address]").forEach((row) => {
    const match = row.dataset.savedAccountAddress === wantedAddress;
    row.classList.toggle("saved-account-match", match);
    if (match) row.prepend(row.querySelector(".saved-account-signin") || row.firstChild);
  });
  const match = [...document.querySelectorAll("[data-saved-account-address]")]
    .find((row) => row.dataset.savedAccountAddress === wantedAddress);
  if (match) {
    const list = match.parentElement;
    if (list && list.firstChild !== match) list.prepend(match);
  }
}

function boot() {
  paintBanner();
  highlightMatchingAccount();
  if (openCreate) {
    document.querySelector("[data-logged-out-create]")?.click();
  }
  const observer = new MutationObserver(() => highlightMatchingAccount());
  const list = document.querySelector("[data-saved-account-list]");
  if (list) observer.observe(list, {childList: true, subtree: true});
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
