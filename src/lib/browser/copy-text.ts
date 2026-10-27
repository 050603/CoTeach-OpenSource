export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof document === "undefined") throw new Error("COPY_NOT_AVAILABLE");

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Plain-HTTP deployments are not secure contexts in several browsers.
      // Continue to the selection-based browser copy path below.
    }
  }

  const element = document.createElement("textarea");
  element.value = text;
  element.setAttribute("readonly", "");
  element.style.position = "fixed";
  element.style.opacity = "0";
  element.style.pointerEvents = "none";
  document.body.appendChild(element);
  element.select();
  element.setSelectionRange(0, element.value.length);
  try {
    if (!document.execCommand("copy")) throw new Error("COPY_REJECTED");
  } finally {
    element.remove();
  }
}
