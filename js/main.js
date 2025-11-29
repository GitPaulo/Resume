import "../css/style.css";

import * as pdfjsLib from "pdfjs-dist";
import A11yDialog from "a11y-dialog";
import isMobile from "is-mobile";

pdfjsLib.GlobalWorkerOptions.workerSrc = "build/main.bundle.worker.js";

const PDF_URL = "resources/paulo_resume.pdf";

// Scale constraints
const SCALE_STEP = 0.25;
const MOBILE_SCALE = 0.75;
const BROWSER_SCALE = 1.5;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5.0;

// Render resolution and fitting tolerance
const RENDER_RESOLUTION = 1.6;
const FIT_EPSILON = 0.01;

// UI layout constants
const SCROLLBAR_WIDTH = 15;
const PADDING_REM = 4;
const LINK_HIGHLIGHT_CLASS = "pdf-link-highlight";

// State
let pdf = null;
let scale = 1;
let fittedScale = null;
let isFitted = false;
let currentRenderTask = null;

// Dialog
let dialog = null;
let dialogEl = null;

const byId = (id) => document.getElementById(id);

const debounce = (fn, delay) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

const isMobilePortrait = () =>
  isMobile() && window.innerHeight > window.innerWidth;

const isLinksDialogOpen = () =>
  dialogEl?.getAttribute("aria-hidden") === "false";

const getPage1 = async () => {
  if (!pdf) throw new Error("PDF not ready");
  return pdf.getPage(1);
};

const clearHighlights = () => {
  document
    .querySelectorAll(`.${LINK_HIGHLIGHT_CLASS}`)
    .forEach((el) => el.remove());
};

const showHighlights = () => {
  document
    .querySelectorAll(`.${LINK_HIGHLIGHT_CLASS}`)
    .forEach((el) => (el.style.opacity = "1"));
};

const updateScaleMessages = () => {
  const tooSmall = byId("too-small-message");
  const tooLarge = byId("too-large-message");

  if (tooSmall) tooSmall.style.display = scale <= MIN_SCALE ? "block" : "none";
  if (tooLarge) tooLarge.style.display = scale >= MAX_SCALE ? "block" : "none";
};

const updateZoomButtons = async () => {
  const wrap = byId("canvas-wrap");
  const zoomInBtn = byId("b1");
  const zoomOutBtn = byId("b5");

  if (!wrap || !zoomInBtn || !zoomOutBtn || !pdf) return;

  if (isMobilePortrait()) {
    zoomInBtn.disabled = true;
    zoomOutBtn.disabled = true;
    return;
  }

  zoomOutBtn.disabled = scale <= MIN_SCALE;

  if (scale >= MAX_SCALE) {
    zoomInBtn.disabled = true;
    return;
  }

  try {
    const page = await getPage1();
    const viewport = page.getViewport({ scale: 1 });

    const nextScale = scale + SCALE_STEP;
    const nextWidth = viewport.width * nextScale;

    const isCentered = wrap.classList.contains("centered");
    const fontSize = parseFloat(getComputedStyle(wrap).fontSize);
    const paddingPx = fontSize * (PADDING_REM * 2);

    const scrollbarWidth = isCentered ? SCROLLBAR_WIDTH : 0;
    const available = wrap.clientWidth - paddingPx - scrollbarWidth;

    const isDisabled = nextWidth > available;
    zoomInBtn.disabled = isDisabled;
    zoomInBtn.title = isDisabled
      ? "Zoom in disabled due to viewport size"
      : "Zoom In";
  } catch (err) {
    console.error("Zoom button update error:", err);
  }
};

const checkFittedState = () => {
  const wrap = byId("canvas-wrap");
  const fitBtn = byId("b3");
  if (!wrap || !fitBtn || fittedScale == null) return;

  const isAtTop = wrap.scrollTop <= 10;
  const isAtFittedZoom = Math.abs(scale - fittedScale) < FIT_EPSILON;
  const isCentered = wrap.classList.contains("centered");

  const shouldHideFit = isAtTop && isAtFittedZoom && isCentered;
  if (shouldHideFit === isFitted) return;

  isFitted = shouldHideFit;
  fitBtn.classList.toggle("visible", !isFitted);
  fitBtn.classList.toggle("hidden", isFitted);
};

const ensureOverlayParent = () => {
  const canvas = byId("resume-canvas");
  if (!canvas) return null;

  const parent = canvas.parentElement;
  if (!parent) return null;

  const cs = getComputedStyle(parent);
  if (cs.position === "static") parent.style.position = "relative";

  return parent;
};

const renderDocument = async (page, s) => {
  const canvas = byId("resume-canvas");
  const wrap = byId("canvas-wrap");
  if (!canvas || !wrap) return;

  if (currentRenderTask) {
    currentRenderTask.cancel();
    currentRenderTask = null;
  }

  const ctx = canvas.getContext("2d");

  // Store previous layout for scroll preservation
  const prevW = canvas.offsetWidth || 1;
  const prevH = canvas.offsetHeight || 1;
  const prevLeft = wrap.scrollLeft;
  const prevTop = wrap.scrollTop;
  const prevCenter = prevLeft + wrap.offsetWidth / 2;

  const viewport = page.getViewport({ scale: s });

  canvas.width = viewport.width * RENDER_RESOLUTION;
  canvas.height = viewport.height * RENDER_RESOLUTION;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  currentRenderTask = page.render({
    canvasContext: ctx,
    viewport,
    transform: [RENDER_RESOLUTION, 0, 0, RENDER_RESOLUTION, 0, 0],
  });

  try {
    await currentRenderTask.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") {
      console.error("Rendering error:", err);
    }
    return;
  } finally {
    currentRenderTask = null;
  }

  // Scroll preservation
  wrap.scrollLeft =
    prevCenter * (viewport.width / prevW) - wrap.offsetWidth / 2;
  wrap.scrollTop = prevTop * (viewport.height / prevH);

  requestAnimationFrame(() => highlightLinks(page, viewport));
};

const highlightLinks = async (page, viewport) => {
  clearHighlights();

  const canvas = byId("resume-canvas");
  const parent = ensureOverlayParent();
  if (!canvas || !parent) return;

  try {
    const annotations = await page.getAnnotations();

    const parentRect = parent.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const offLeft = canvasRect.left - parentRect.left;
    const offTop = canvasRect.top - parentRect.top;

    for (const a of annotations) {
      if (a.subtype !== "Link" || !a.url) continue;

      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);

      const el = document.createElement("a");
      el.href = a.url;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.className = LINK_HIGHLIGHT_CLASS;
      el.setAttribute("aria-label", `Link to ${a.url}`);

      Object.assign(el.style, {
        position: "absolute",
        left: `${offLeft + left}px`,
        top: `${offTop + top}px`,
        width: `${width}px`,
        height: `${height}px`,
        zIndex: 1,
        transition: "opacity 0.2s ease",
        opacity: 1,
      });

      parent.appendChild(el);
    }
  } catch (err) {
    console.error("Highlight link error:", err);
  }
};

const renderCurrent = () => {
  requestAnimationFrame(async () => {
    try {
      const page = await getPage1();
      await renderDocument(page, scale);
      updateScaleMessages();
      checkFittedState();
      updateZoomButtons();
    } catch (err) {
      console.error("Render update error:", err);
    }
  });
};

const fit = async () => {
  const wrap = byId("canvas-wrap");
  if (!wrap || !pdf) return;

  clearHighlights();
  wrap.classList.add("centered");
  wrap.style.removeProperty("overflow");

  try {
    const page = await getPage1();
    const viewport = page.getViewport({ scale: 1 });

    const availableW = wrap.clientWidth * 0.99;
    const availableH = wrap.clientHeight * 0.99;

    const scaleX = availableW / viewport.width;
    const scaleY = availableH / viewport.height;

    const fitScale = Math.min(scaleX, scaleY);
    const minAllowed = isMobile() ? 0.1 : 0.5;

    scale = Math.max(minAllowed, Math.min(2.0, fitScale));
    fittedScale = scale;

    await renderDocument(page, scale);

    wrap.scrollTop = 0;
    wrap.scrollLeft = 0;

    updateScaleMessages();
    checkFittedState();
    updateZoomButtons();
  } catch (err) {
    console.error("Fit error:", err);
  }
};

const zoomIn = async (delta) => {
  if (isMobilePortrait()) return;

  if (scale >= MAX_SCALE) {
    const m = byId("too-large-message");
    if (m) m.style.display = "block";
    return;
  }

  const wrap = byId("canvas-wrap");
  if (!wrap || !pdf) return;

  try {
    const page = await getPage1();
    const viewport = page.getViewport({ scale: 1 });

    const next = Math.min(MAX_SCALE, scale + delta);
    const nextWidth = viewport.width * next;

    const isCentered = wrap.classList.contains("centered");
    const fontSize = parseFloat(getComputedStyle(wrap).fontSize);
    const paddingPx = fontSize * (PADDING_REM * 2);

    const scrollbarWidth = isCentered ? SCROLLBAR_WIDTH : 0;
    const available = wrap.clientWidth - paddingPx - scrollbarWidth;

    if (nextWidth > available) return;

    clearHighlights();

    if ((isMobile() && scale > MOBILE_SCALE) || scale > BROWSER_SCALE) {
      wrap.style.overflow = "auto";
    }

    scale = next;
    wrap.classList.remove("centered");
    renderCurrent();
  } catch (err) {
    console.error("Zoom-in error:", err);
  }
};

const zoomOut = (delta) => {
  if (isMobilePortrait()) return;

  if (scale <= MIN_SCALE) {
    const m = byId("too-small-message");
    if (m) m.style.display = "block";
    return;
  }

  const wrap = byId("canvas-wrap");
  if (!wrap) return;

  clearHighlights();
  scale = Math.max(MIN_SCALE, scale - delta);
  wrap.classList.remove("centered");
  renderCurrent();
};

const populateLinksList = async () => {
  if (!pdf) return;

  try {
    const page = await getPage1();
    const annotations = await page.getAnnotations();

    const listEl = byId("links-area");
    const countEl = byId("links-count");

    if (!listEl || !countEl) return;

    const urls = [
      ...new Set(annotations.filter((a) => a.url).map((a) => a.url)),
    ];
    const count = urls.length;

    listEl.innerHTML = "";
    listEl.classList.toggle("empty", count === 0);
    countEl.textContent = String(count);

    if (count === 0) {
      listEl.textContent = "No links found in document.";
      return;
    }

    for (const url of urls) {
      const item = document.createElement("div");
      item.className = "link-item";

      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.innerHTML = `<span class="link-icon">↗</span><span>${url}</span>`;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "copy-btn";
      copyBtn.innerHTML = `<i class="fa-regular fa-copy"></i>`;
      copyBtn.setAttribute("aria-label", `Copy ${url}`);

      copyBtn.onclick = async () => {
        document.querySelectorAll(".copy-btn").forEach((btn) => {
          btn.innerHTML = '<i class="fa-regular fa-copy"></i>';
          btn.classList.remove("copied");
        });

        try {
          await navigator.clipboard.writeText(url);
          copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
            copyBtn.classList.remove("copied");
          }, 2000);
        } catch (err) {
          console.error("Copy error:", err);
        }
      };

      item.appendChild(a);
      item.appendChild(copyBtn);
      listEl.appendChild(item);
    }

    showHighlights();
  } catch (err) {
    console.error("Link list error:", err);
  }
};

const showUI = () => {
  const spinner = byId("loading-spinner");
  const pdfContainer = byId("pdf-container");
  const buttonArea = byId("button-area");
  const controls = byId("controls");
  const wrap = byId("canvas-wrap");

  if (spinner) {
    spinner.classList.add("hidden");
    setTimeout(() => (spinner.style.display = "none"), 300);
  }
  if (pdfContainer) pdfContainer.classList.add("loaded");
  if (buttonArea) buttonArea.classList.add("visible");
  if (controls) controls.classList.add("visible");

  if (wrap) {
    wrap.addEventListener("scroll", debounce(checkFittedState, 150));
  }
};
const setupDragScroll = () => {
  const wrap = byId("canvas-wrap");
  if (!wrap) return;

  let state = { left: 0, top: 0, x: 0, y: 0 };

  const onDown = (e) => {
    wrap.style.cursor = "grabbing";
    wrap.style.userSelect = "none";
    state = {
      left: wrap.scrollLeft,
      top: wrap.scrollTop,
      x: e.clientX,
      y: e.clientY,
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const onMove = (e) => {
    wrap.scrollLeft = state.left - (e.clientX - state.x);
    wrap.scrollTop = state.top - (e.clientY - state.y);
  };

  const onUp = () => {
    wrap.style.cursor = "grab";
    wrap.style.removeProperty("user-select");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  wrap.addEventListener("mousedown", onDown);
};

const setupKeyboardNav = () => {
  const wrap = byId("canvas-wrap");
  if (!wrap) return;

  const STEP = 50;

  wrap.addEventListener("keydown", (e) => {
    const { key } = e;

    switch (key) {
      case "ArrowUp":
        e.preventDefault();
        wrap.scrollTop -= STEP;
        break;
      case "ArrowDown":
        e.preventDefault();
        wrap.scrollTop += STEP;
        break;
      case "ArrowLeft":
        e.preventDefault();
        wrap.scrollLeft -= STEP;
        break;
      case "ArrowRight":
        e.preventDefault();
        wrap.scrollLeft += STEP;
        break;
      case "Home":
        e.preventDefault();
        wrap.scrollTop = 0;
        break;
      case "End":
        e.preventDefault();
        wrap.scrollTop = wrap.scrollHeight;
        break;
      case "PageUp":
        e.preventDefault();
        wrap.scrollTop -= wrap.offsetHeight;
        break;
      case "PageDown":
        e.preventDefault();
        wrap.scrollTop += wrap.offsetHeight;
        break;
    }
  });
};

const setupKeyboardShortcuts = () => {
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const inField = t?.tagName === "INPUT" || t?.tagName === "TEXTAREA";

    if (inField || isLinksDialogOpen()) return;

    switch (e.key) {
      case "+":
      case "=":
        e.preventDefault();
        zoomIn(SCALE_STEP);
        break;
      case "-":
        e.preventDefault();
        zoomOut(SCALE_STEP);
        break;
      case "0":
        e.preventDefault();
        fit();
        break;
      case "l":
      case "L":
        e.preventDefault();
        openLinks();
        break;
      case "d":
      case "D":
        e.preventDefault();
        download();
        break;
      case "Escape":
        if (isLinksDialogOpen()) closeLinks();
        break;
    }
  });
};

const setupDialog = () => {
  dialogEl = byId("links-dialog");
  if (!dialogEl) return;

  dialog = new A11yDialog(dialogEl);
  const linksBtn = byId("b4");

  dialog.on("show", () => linksBtn?.classList.add("active"));
  dialog.on("hide", () => linksBtn?.classList.remove("active"));
  dialog.on("show", populateLinksList);
};

const setupInput = () => {
  setupDialog();
  setupDragScroll();
  setupKeyboardNav();
  setupKeyboardShortcuts();

  const mq = window.matchMedia("(max-width: 750px)");
  mq.addEventListener("change", fit);
};

const setupUI = () => {
  setTimeout(showUI, 100);

  let lastW = window.innerWidth;

  window.addEventListener(
    "resize",
    debounce(() => {
      const w = window.innerWidth;
      if (!isMobile() || w !== lastW) {
        lastW = w;
        fit();
      }
    }, 100)
  );
};

const openLinks = () => {
  if (!dialogEl || !dialog) return;
  if (isLinksDialogOpen()) dialog.hide();
  else dialog.show();
};

const closeLinks = () => dialog?.hide();

const download = () => {
  window.open(PDF_URL, "_self");
};

// Export global functions
window.zoomIn = zoomIn;
window.zoomOut = zoomOut;
window.fit = fit;
window.openLinks = openLinks;
window.closeLinks = closeLinks;
window.download = download;

// Bootstrap
document.body.classList.add("loaded");

// Redirect mobile users to PDF
if (isMobile()) {
  window.location.href = PDF_URL;
}

(async () => {
  try {
    const loadingTask = pdfjsLib.getDocument(PDF_URL);
    pdf = await loadingTask.promise;

    await getPage1(); // ensure page loaded
    await fit();
    setupUI();
    setupInput();
  } catch (err) {
    console.error("PDF load failure:", err);

    const spinner = byId("loading-spinner");
    if (spinner) {
      spinner.innerHTML = `<p style="color: var(--color-accent);">
          Failed to load resume. Please refresh the page.
         </p>`;
    }
  }
})();
