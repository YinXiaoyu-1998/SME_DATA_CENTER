// A standalone, progressively enhanced script; the public site needs no framework.
export const clientSource = String.raw`"use strict";
const copyButton = document.getElementById("copy-contact");
const copyStatus = document.getElementById("copy-status");
if (copyButton && copyStatus) {
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("企业智脑 SMEDC\n电话：18514577162\n邮箱：consyinxy@gmail.com");
      copyStatus.textContent = "已复制联系方式，可粘贴到你的通讯工具。";
    } catch {
      copyStatus.textContent = "暂时无法自动复制，请选中上方电话或邮箱手动复制。";
    }
  });
}

if (typeof window !== "undefined" && document.querySelectorAll) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const fineDesktop = window.matchMedia("(min-width: 761px) and (pointer: fine)");
  const ease = "cubic-bezier(0.22, 1, 0.36, 1)";
  const move = (element, frames, options = {}) => {
    if (reducedMotion.matches || !element || typeof element.animate !== "function") return null;
    return element.animate(frames, { duration: 400, easing: ease, ...options });
  };
  const reveal = (element) => {
    element.classList.remove("is-pending");
    element.classList.add("is-revealed");
  };
  const revealContaining = (target) => {
    for (let element = target; element; element = element.parentElement) {
      if (element.matches("[data-reveal]")) reveal(element);
    }
  };
  const reveals = [...document.querySelectorAll("[data-reveal]")];
  let revealObserver;
  if (!reducedMotion.matches && "IntersectionObserver" in window) {
    revealObserver = new IntersectionObserver((entries) => {
      let stagger = 0;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.style.transitionDelay = Math.min(stagger++ * 70, 210) + "ms";
        reveal(entry.target);
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach((element) => {
      if (element.getBoundingClientRect().top > window.innerHeight * 0.9) {
        element.classList.add("is-pending");
        revealObserver.observe(element);
      }
    });
  }
  // Keyboard and deep-link users must never land on an invisible reveal target.
  document.addEventListener("focusin", (event) => revealContaining(event.target));
  const revealHash = () => {
    const target = document.getElementById(window.location.hash.slice(1));
    if (target) revealContaining(target);
  };
  window.addEventListener("hashchange", revealHash);
  revealHash();
  const entranceAnimations = [...document.querySelectorAll("[data-entrance]")].map((element, index) =>
    move(element, [
      { opacity: 0, transform: "translateY(24px)" },
      { opacity: 1, transform: "translateY(0)" }
    ], { duration: 850, delay: index * 100, fill: "backwards" })
  );

  const header = document.querySelector(".site-header");
  const progress = document.querySelector(".reading-progress");
  const hero = document.querySelector(".hero");
  const heroPhoto = document.querySelector(".hero-photo");
  const navigation = [...document.querySelectorAll("nav a")];
  const navigationSections = navigation.map((link) => document.querySelector(link.getAttribute("href")));
  let scrollFrame = 0;
  const renderScroll = () => {
    scrollFrame = 0;
    const y = window.scrollY;
    header?.classList.toggle("is-scrolled", y > 16);
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (progress) progress.style.transform = "scaleX(" + (scrollable > 0 ? Math.min(y / scrollable, 1) : 0) + ")";
    if (heroPhoto && hero) {
      heroPhoto.style.transform = !reducedMotion.matches && fineDesktop.matches
        ? "translate3d(0," + Math.min(y * 0.08, hero.offsetHeight * 0.045) + "px,0)"
        : "none";
    }
    let current = -1;
    navigationSections.forEach((section, index) => {
      if (y > 100 && section && section.getBoundingClientRect().top <= window.innerHeight * 0.45) current = index;
    });
    navigation.forEach((link, index) => {
      if (index === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };
  const requestScroll = () => {
    if (!scrollFrame) scrollFrame = window.requestAnimationFrame(renderScroll);
  };
  window.addEventListener("scroll", requestScroll, { passive: true });
  window.addEventListener("resize", requestScroll, { passive: true });
  window.addEventListener("load", requestScroll, { once: true });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) {
      revealObserver?.disconnect();
      reveals.forEach(reveal);
      entranceAnimations.forEach((animation) => animation?.cancel());
    }
    requestScroll();
  });
  renderScroll();

  const selector = document.querySelector(".work-selector");
  const tabs = [...document.querySelectorAll("[data-work-tab]")];
  const panels = [...document.querySelectorAll("[data-work-panel]")];
  if (selector && tabs.length && panels.length) {
    selector.classList.add("is-enhanced");
    const tabList = selector.querySelector(".work-tabs");
    tabList.setAttribute("role", "tablist");
    const orientTabs = () => tabList.setAttribute("aria-orientation", window.innerWidth > 760 ? "vertical" : "horizontal");
    orientTabs();
    window.addEventListener("resize", orientTabs, { passive: true });
    const selectWork = (key, animate = true) => {
      tabs.forEach((tab) => {
        const selected = tab.dataset.workTab === key;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      panels.forEach((panel) => {
        const selected = panel.id === key;
        panel.hidden = !selected;
        if (selected && animate) move(panel, [
          { opacity: 0, transform: "translateY(12px)" },
          { opacity: 1, transform: "translateY(0)" }
        ], { duration: 420 });
      });
      requestScroll();
    };
    tabs.forEach((tab, index) => {
      const key = tab.dataset.workTab;
      tab.id = "tab-" + key;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", key);
      const panel = document.getElementById(key);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      panel.tabIndex = 0;
      tab.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        selectWork(key);
      });
      tab.addEventListener("keydown", (event) => {
        let next;
        if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % tabs.length;
        if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (event.key === " ") next = index;
        if (next === undefined) return;
        event.preventDefault();
        tabs[next].focus();
        selectWork(tabs[next].dataset.workTab);
      });
    });
    const workFromHash = () => {
      const key = window.location.hash.slice(1);
      if (panels.some((panel) => panel.id === key)) {
        selectWork(key, false);
        revealContaining(selector);
        document.getElementById(key).scrollIntoView({ block: "start" });
      }
    };
    selectWork("analysis", false);
    window.addEventListener("hashchange", workFromHash);
    workFromHash();
  }

  document.querySelectorAll("details").forEach((detail) => {
    detail.addEventListener("toggle", () => {
      if (detail.open) {
        const content = detail.querySelector(".choice-content") || detail.querySelector("div");
        move(content, [
          { opacity: 0, transform: "translateY(-8px)" },
          { opacity: 1, transform: "translateY(0)" }
        ], { duration: 380 });
      }
      requestScroll();
    });
  });

  const dialog = document.getElementById("report-dialog");
  const frame = document.getElementById("report-frame");
  const reportStatus = document.getElementById("report-status");
  const closeButton = document.getElementById("close-report");
  if (dialog && frame && closeButton && typeof dialog.showModal === "function") {
    let returnFocus;
    let closing = false;
    const closeReport = () => {
      if (!dialog.open || closing) return;
      closing = true;
      const animation = move(dialog, [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(12px) scale(0.99)" }
      ], { duration: 180, easing: "ease-in", fill: "forwards" });
      const finish = () => { animation?.cancel(); dialog.close(); };
      if (animation) animation.finished.then(finish, finish);
      else finish();
    };
    document.querySelectorAll("[data-open-report]").forEach((link) => {
      link.setAttribute("aria-haspopup", "dialog");
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (dialog.open) return;
        returnFocus = link;
        if (!frame.hasAttribute("src")) frame.src = frame.dataset.src;
        document.body.classList.add("reader-open");
        dialog.showModal();
        closeButton.focus({ preventScroll: true });
        move(dialog, [
          { opacity: 0, transform: "translateY(24px) scale(0.98)" },
          { opacity: 1, transform: "translateY(0) scale(1)" }
        ], { duration: 420 });
      });
    });
    frame.addEventListener("load", () => {
      if (!frame.hasAttribute("src")) return;
      frame.hidden = false;
      reportStatus.hidden = true;
    });
    closeButton.addEventListener("click", closeReport);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeReport(); });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeReport();
    });
    dialog.addEventListener("close", () => {
      closing = false;
      document.body.classList.remove("reader-open");
      returnFocus?.focus({ preventScroll: true });
    });
    window.addEventListener("message", (event) => {
      if (event.source === frame.contentWindow && event.data?.type === "smedc-report:close") closeReport();
    });
  }
}
`;
