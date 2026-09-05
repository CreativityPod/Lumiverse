import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const currentWindow = getCurrentWindow();
const dragHandle = document.querySelector<HTMLElement>("#drag-handle")!;
const closeButton = document.querySelector<HTMLButtonElement>("#close")!;
const clickThroughButton = document.querySelector<HTMLButtonElement>("#click-through")!;

/**
 * Surface a rejected native call instead of dropping it.
 *
 * These all fail silently when the window's capability does not reach it —
 * the button simply does nothing, with no clue why. Logging the rejection is
 * what turns a dead control into a diagnosable one.
 */
function reportFailure(what: string) {
  return (error: unknown) => console.error(`[widget] ${what} failed:`, error);
}

dragHandle.addEventListener("mousedown", (event) => {
  if (event.button === 0 && !(event.target instanceof Element && event.target.closest("button"))) {
    currentWindow.startDragging().catch(reportFailure("startDragging"));
  }
});

for (const handle of document.querySelectorAll<HTMLButtonElement>("[data-direction]")) {
  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    currentWindow
      .startResizeDragging(handle.dataset.direction as ResizeDirection)
      .catch(reportFailure("startResizeDragging"));
  });
}

closeButton.addEventListener("click", () => {
  invoke("hide_widget_poc").catch(reportFailure("hide_widget_poc"));
});

clickThroughButton.addEventListener("click", () => {
  // A click-through native window cannot receive the next click to turn this
  // off, so the tray command deliberately owns restoration for this POC.
  invoke("set_widget_poc_click_through", { enabled: true }).catch(
    reportFailure("set_widget_poc_click_through"),
  );
});
