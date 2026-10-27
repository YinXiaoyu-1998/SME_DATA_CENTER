// Playback controls for the shared HyperFrames composition.
export const setupPlayerSource = String.raw`"use strict";
if (typeof window !== "undefined") {

  const setupRoot = document.getElementById("smedc-setup");
  if (setupRoot) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const copyPrompt = document.getElementById("copy-setup-prompt");
    const demoStatus = document.getElementById("setup-demo-status");
    const prompt = setupRoot.dataset.installPrompt || setupRoot.querySelector(".setup-request-text").textContent.trim();
  const timeline = window.__timelines?.["smedc-setup"];
    copyPrompt.hidden = false;
    copyPrompt.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        demoStatus.textContent = "安装请求已复制，发给您熟悉的主流 Agent 智能体，即可开始 AI 原生接入。";
      } catch {
      timeline?.progress(1).pause();
        demoStatus.textContent = "暂时无法自动复制，请选中对话中的完整安装请求手动复制。";
      }
    });
    if (timeline) {
      const playback = document.querySelector("[data-demo-playback]");
      const playButton = document.getElementById("setup-play");
      const progressInput = document.getElementById("setup-progress");
      let visible = false;
      let wantsPlayback = true;
      let complete = false;
      const syncPlayback = () => {
        playback.hidden = reducedMotion.matches;
        if (reducedMotion.matches) {
          timeline.progress(1).pause();
          setupRoot.dataset.demoState = "static";
          return;
        }
        const playing = visible && wantsPlayback && !document.hidden && !complete;
        if (playing) timeline.play();
        else timeline.pause();
        setupRoot.dataset.demoState = complete ? "complete" : playing ? "playing" : "paused";
        playButton.textContent = complete ? "重播演示" : playing ? "暂停演示" : "播放演示";
      };
      progressInput.max = String(timeline.duration());
    progressInput.value = String(timeline.time());
      timeline.eventCallback("onUpdate", () => { progressInput.value = String(timeline.time()); });
      timeline.eventCallback("onComplete", () => {
        complete = true;
        wantsPlayback = false;
        syncPlayback();
      });
      playButton.addEventListener("click", () => {
        if (complete) {
          timeline.pause(0);
          complete = false;
          wantsPlayback = true;
        } else {
          wantsPlayback = !wantsPlayback;
        }
        syncPlayback();
      });
      progressInput.addEventListener("input", () => {
        wantsPlayback = false;
        complete = false;
        timeline.pause().time(Number(progressInput.value));
        complete = timeline.progress() >= 1;
        syncPlayback();
      });
      if ("IntersectionObserver" in window) {
        const demoObserver = new IntersectionObserver((entries) => {
          visible = entries[0].isIntersecting;
          syncPlayback();
        }, { threshold: 0.35 });
        demoObserver.observe(setupRoot);
      } else {
        // No observer: keep the end-state readable and allow manual replay.
        timeline.progress(1).pause();
        complete = true;
        wantsPlayback = false;
        visible = true;
      }
      document.addEventListener("visibilitychange", syncPlayback);
      reducedMotion.addEventListener("change", () => {
        if (!reducedMotion.matches) { complete = true; wantsPlayback = false; }
        syncPlayback();
      });
      syncPlayback();
    }
  }
}
`;
