// Presentation only. This page does not load workspace data or run Cue actions.
(() => {
  const story = document.querySelector("#story");
  if (!story) return;
  const chapters = [...story.querySelectorAll(".chapter")];
  const scenes = [...story.querySelectorAll(".scene")];
  const stage = story.querySelector(".stage");
  const rail = story.querySelector("#rail");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const compact = matchMedia("(max-width: 960px)");
  const titles = [
    "Bloom · upload",
    "Channels · capture",
    "Cue · linking",
    "Sandbox · reproduce",
    "Codex · fix",
    "Review · approve",
    "Demo · verify",
    "Growth · reply",
    "Agents · Slack",
  ];
  let current = 0;
  let inline = false;
  if (!stage || !rail || chapters.length !== scenes.length) return;

  chapters.forEach((chapter, i) => {
    if (i) {
      const segment = document.createElement("div");
      segment.className = "seg";
      segment.appendChild(document.createElement("i"));
      rail.appendChild(segment);
    }
    const button = document.createElement("button");
    button.textContent = String(i + 1).padStart(2, "0");
    button.setAttribute(
      "aria-label",
      `Chapter ${i + 1}: ${chapter.querySelector("h3")?.textContent}`,
    );
    button.addEventListener("click", () =>
      chapter.scrollIntoView({
        behavior: reduced.matches ? "auto" : "smooth",
        block: "center",
      }),
    );
    rail.appendChild(button);
  });
  const buttons = [...rail.querySelectorAll("button")];
  const segments = [...rail.querySelectorAll(".seg")];
  const code = story.querySelector("#typed");
  if (code)
    code.textContent = "export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;";
  function show(i) {
    current = i;
    chapters.forEach((chapter, j) => chapter.classList.toggle("on", j === i));
    scenes.forEach((scene, j) =>
      scene.classList.toggle("on", inline || j === i),
    );
    buttons.forEach((button, j) => {
      button.classList.toggle("on", j === i);
      button.classList.toggle("past", j < i);
      button.setAttribute("aria-current", j === i ? "step" : "false");
    });
    segments.forEach((segment, j) => segment.classList.toggle("fill", j < i));
    stage.querySelector("#stage-n").textContent = String(i + 1).padStart(
      2,
      "0",
    );
    stage.querySelector("#stage-t").textContent = titles[i] || "Cue";
  }
  function layout() {
    inline = reduced.matches || compact.matches;
    story.classList.toggle("inline", inline);
    scenes.forEach((scene, i) =>
      (inline ? chapters[i] : stage).appendChild(scene),
    );
    show(current);
  }
  layout();
  reduced.addEventListener("change", layout);
  compact.addEventListener("change", layout);
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length)
        show(chapters.indexOf(visible[visible.length - 1].target));
    },
    { rootMargin: "-35% 0px -35% 0px" },
  );
  chapters.forEach((chapter) => observer.observe(chapter));
  const progress = document.querySelector("#progress");
  const nav = document.querySelector("#lnav");
  function scrollChrome() {
    const h = document.documentElement;
    if (progress)
      progress.style.width = `${(h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100}%`;
    nav?.classList.toggle("scrolled", h.scrollTop > 8);
  }
  addEventListener("scroll", scrollChrome, { passive: true });
  scrollChrome();
})();
