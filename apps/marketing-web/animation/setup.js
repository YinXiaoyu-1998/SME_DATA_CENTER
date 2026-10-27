/* global document, window, gsap, TextPlugin */
// Deterministic HyperFrames timeline, also used by the landing-page player.
(() => {
  const root = document.getElementById("smedc-setup");
  if (!root || !window.gsap || !window.TextPlugin) return;
  gsap.registerPlugin(TextPlugin);
  const request = root.querySelector(".setup-request-text");
  const prompt = request.textContent.trim();
  root.dataset.installPrompt = prompt;
  const timeline = gsap.timeline({ paused: true });
  timeline.from(
    root.querySelector(".setup-request"),
    { x: 16, opacity: 0, duration: 0.5, ease: "power3.out" },
    0.3
  );
  timeline.fromTo(
    request,
    { text: "" },
    { text: { value: prompt }, duration: 3.8, ease: "none" },
    0.65
  );
  timeline.from(
    root.querySelector(".setup-agent-intro"),
    { y: 10, opacity: 0, duration: 0.45, ease: "power2.out" },
    4.9
  );
  const eases = ["power3.out", "sine.out", "power2.out", "expo.out"];
  root.querySelectorAll(".setup-step").forEach((step, index) => {
    timeline.from(
      step,
      { x: -10, opacity: 0, duration: 0.42 + index * 0.04, ease: eases[index] },
      6.1 + index * 1.65
    );
  });
  timeline.from(
    root.querySelector(".setup-finish"),
    { y: 12, opacity: 0, scale: 0.99, duration: 0.65, ease: "expo.out" },
    12.9
  );
  timeline.from(
    root.querySelector(".setup-finish-tail"),
    { y: 5, opacity: 0, duration: 0.5, ease: "sine.out" },
    14.1
  );
  window.__timelines = window.__timelines || {};
  window.__timelines["smedc-setup"] = timeline;
})();
