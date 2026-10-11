/* Cue's public install script. App IDs are public; conversation tokens are visitor scoped. */
(() => {
  const script = document.currentScript;
  if (!script || document.getElementById("cue-widget-launcher")) return;
  const app = script.dataset.app;
  if (!app) return;
  const base = new URL(script.src).origin,
    origin = location.origin;
  const storageKey = `cue:widget:${base}:${app}`;
  let token;
  try {
    token = localStorage.getItem(storageKey);
  } catch {}
  const button = document.createElement("button");
  button.id = "cue-widget-launcher";
  button.type = "button";
  button.textContent = "Get help";
  button.setAttribute("aria-label", "Open Cue support");
  button.style.cssText =
    "position:fixed;right:24px;bottom:24px;z-index:2147483000;background:#217a54;color:white;border:0;border-radius:100px;padding:16px 22px;font:600 15px system-ui;cursor:pointer;box-shadow:0 5px 24px #0002";
  const frame = document.createElement("iframe");
  frame.title = "Cue support";
  frame.id = "cue-widget-frame";
  frame.src = `${base}/widget?app=${encodeURIComponent(app)}&origin=${encodeURIComponent(origin)}`;
  frame.style.cssText =
    "display:none;position:fixed;right:24px;bottom:90px;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100dvh - 120px));border:1px solid #ddd;border-radius:18px;z-index:2147483001;background:white;box-shadow:0 10px 48px #0003";
  frame.referrerPolicy = "origin";
  frame.allow = "microphone";
  const context = () => ({
    type: "cue:init",
    app,
    origin,
    token,
    name: script.dataset.name || "",
    page: location.origin + location.pathname,
  });
  button.onclick = () => {
    const open = frame.style.display === "none";
    frame.style.display = open ? "block" : "none";
    button.setAttribute("aria-expanded", String(open));
    if (open) frame.contentWindow?.postMessage(context(), base);
  };
  window.addEventListener("message", (e) => {
    if (e.origin !== base || e.source !== frame.contentWindow) return;
    if (e.data?.type === "cue:ready")
      frame.contentWindow.postMessage(context(), base);
    if (e.data?.type === "cue:session" && typeof e.data.token === "string") {
      token = e.data.token;
      try {
        localStorage.setItem(storageKey, token);
      } catch {}
    }
    if (e.data?.type === "cue:close") {
      frame.style.display = "none";
      button.setAttribute("aria-expanded", "false");
    }
  });
  const mount = () => document.body.append(button, frame);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
