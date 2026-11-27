/** Returns the visible viewport geometry only while a mobile text keyboard is open. */
export function keyboardViewport(): { height: number; bottom: number } | null {
  const viewport = window.visualViewport;
  const active = document.activeElement;
  const isTextEntry = active instanceof HTMLElement && (
    active.isContentEditable || active.matches("input, textarea, [contenteditable='true']")
  );
  if (!viewport || !isTextEntry || Math.abs(viewport.scale - 1) > 0.01 || window.innerHeight - viewport.height <= 80) {
    return null;
  }
  return {
    height: viewport.height,
    bottom: Math.max(0, window.innerHeight - viewport.offsetTop - viewport.height),
  };
}
