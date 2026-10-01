// iOS Safari keeps the layout viewport at full height when the keyboard opens and lays the keyboard over the bottom of the page, which hides the
// bottom row (Excalidraw's bar, the dock). What stays on screen is the visual viewport: the page is made that tall (--vvh, read by .app under
// (pointer: coarse) in styles.css), so its bottom row sits above the keyboard. `scale` undoes a pinch zoom, which shrinks the visual viewport too.
// Safari also pans the visual viewport down the layout viewport to keep the focused field in view (`offsetTop`, --vvt): the page follows it, else a blank band opens between
// the page's bottom and the keyboard. It moves by `top`, not a transform, which would make the fixed dock and panels position against the page instead of the screen.
const vv = window.visualViewport;
if (vv && matchMedia("(pointer: coarse)").matches) {
  const fit = () => {
    const root = document.documentElement.style;
    root.setProperty("--vvh", `${Math.round(vv.height * vv.scale)}px`);
    root.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}
