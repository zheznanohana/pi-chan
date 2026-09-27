'use strict';
// Electron's native setPosition accepts signed integer DIP coordinates only.
function dragPosition(bounds, delta) {
  if (!bounds || !delta || typeof delta !== 'object') return null;
  if (![bounds.x, bounds.y, delta.dx, delta.dy].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const x = Math.round(bounds.x + delta.dx), y = Math.round(bounds.y + delta.dy);
  if (![x, y].every(v => Number.isSafeInteger(v) && v >= -2147483648 && v <= 2147483647)) return null;
  return { x, y };
}
function moveWindowBy(window, delta) {
  if (!window || window.isDestroyed()) return false;
  try {
    const next = dragPosition(window.getBounds(), delta);
    if (!next || window.isDestroyed()) return false;
    window.setPosition(next.x, next.y);
    return true;
  } catch (error) {
    // The native window may close between getBounds and setPosition.
    console.warn('[Pet] Drag skipped:', error.message);
    return false;
  }
}
module.exports = { dragPosition, moveWindowBy };
