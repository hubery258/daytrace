/**
 * Tiny bridge between the WebDAV download flow and the existing JSON import
 * preview.
 *
 * A download must never write the local database. The WebDAV panel publishes
 * the downloaded package here; the existing data portability panel picks it up
 * and runs its own preview + confirmation + merge flow unchanged.
 */

let pending = null;
const listeners = new Set();

export function publishDownloadedPackage(dataPackage, meta = {}) {
  pending = { package: dataPackage, meta, receivedAt: Date.now() };
  for (const listener of [...listeners]) {
    try {
      listener(pending);
    } catch {
      // A broken listener must not break the download flow.
    }
  }
  return pending;
}

export function takeDownloadedPackage() {
  const value = pending;
  pending = null;
  return value;
}

export function subscribeDownloadedPackage(listener) {
  listeners.add(listener);
  if (pending) listener(pending);
  return () => listeners.delete(listener);
}

export function __resetDownloadBridgeForTests() {
  pending = null;
  listeners.clear();
}
