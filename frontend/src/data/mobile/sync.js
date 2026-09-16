/**
 * Android WebDAV sync adapter for the modular mobile data layer
 * (`src/data/mobile/*`).
 *
 * All protocol, route and validation logic lives in
 * `src/platform/webdavSync.js`; this adapter only wires it to this layer's
 * SQLite helpers and JSON package functions. The Android runtime data layer
 * (`src/data/mobileDatabase.js`) wires the same factory to its own helpers.
 */

import { createUuid, insert, one, update } from './database.js';
import { exportDataPackage, validateDataPackage } from './portability.js';
import {
  DEFAULT_REMOTE_DIRECTORY,
  DEFAULT_REMOTE_FILENAME,
  SYNC_ERROR_MESSAGES,
  __setWebdavTransportForTests,
  buildTarget,
  createSyncRoutes,
  createWebdavProtocol,
  normalizeBaseUrl,
  summarizePackage,
  syncError,
  validateRemoteDirectory,
  validateRemoteFilename,
} from '../../platform/webdavSync.js';

export const SUPPORTED_PACKAGE_SCHEMA_VERSIONS = Object.freeze(['0.6.0', '0.8.0']);

const routes = createSyncRoutes({
  store: {
    getRow: () => one('webdav_config', 'id = 1'),
    insertRow: (data) => insert('webdav_config', data),
    updateRow: (id, data) => update('webdav_config', id, data),
  },
  exportPackage: exportDataPackage,
  assertPackage: (raw) => validateDataPackage(raw),
  supportedSchemaVersions: SUPPORTED_PACKAGE_SCHEMA_VERSIONS,
  generateUuid: createUuid,
  protocol: createWebdavProtocol(),
});

export async function syncRequest(method, pathname, body) {
  return routes.syncRequest(method, pathname, body);
}

/** Test hook: reset in-process sync state between tests. */
export function __resetWebdavSyncStateForTests() {
  if (typeof process === 'undefined' || process?.env?.NODE_ENV !== 'test') {
    throw new Error('The sync test hook is only available with NODE_ENV=test');
  }
  routes.resetState();
}

export {
  DEFAULT_REMOTE_DIRECTORY,
  DEFAULT_REMOTE_FILENAME,
  SYNC_ERROR_MESSAGES,
  __setWebdavTransportForTests,
  buildTarget,
  createSyncRoutes,
  normalizeBaseUrl,
  summarizePackage,
  syncError,
  validateRemoteDirectory,
  validateRemoteFilename,
};
