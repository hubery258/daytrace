/**
 * Unified WebDAV SyncAdapter (v0.11.1).
 *
 * The settings UI only talks to this adapter. Platform differences stay behind
 * it:
 *
 * | platform            | network path                        | password storage          |
 * | ------------------- | ----------------------------------- | ------------------------- |
 * | Web + local FastAPI | local backend proxies WebDAV        | local SQLite configuration |
 * | Windows Electron    | FastAPI sidecar proxies WebDAV      | local SQLite configuration |
 * | Android             | Capacitor native HTTP (RijiHttp)    | local SQLite configuration |
 *
 * v0.11.x is manual only: every remote mutation goes through an explicit user
 * confirmation, downloads never write the local database and no merge algorithm
 * is added here.
 */

import { syncApi } from '../api/clientCore.js';
import { createPasswordStore } from './passwordStore.js';

export function createSyncAdapter({ api = syncApi, passwordStore = null } = {}) {
  let legacyStorePromise = null;
  const getLegacyStore = async () => {
    if (!legacyStorePromise) legacyStorePromise = Promise.resolve(passwordStore || createPasswordStore());
    return legacyStorePromise;
  };
  const call = (method, ...args) => api[method](...args);

  return {
    async getConfig() {
      return call('getConfig');
    },

    async saveConfig(draft) {
      return call('saveConfig', {
        base_url: draft.base_url,
        username: draft.username,
        password: typeof draft.password === 'string' ? draft.password : '',
        remember_password: Boolean(draft.remember_password),
        remote_directory: draft.remote_directory,
        remote_filename: draft.remote_filename,
        allow_insecure_http: Boolean(draft.allow_insecure_http),
      });
    },

    /** Migrate a v0.11.0 platform-stored password into the local config row. */
    async restoreRememberedPassword() {
      const config = await call('getConfig');
      if (config.has_password || !config.remember_password || !config.base_url) return { restored: false, config };
      try {
        const store = await getLegacyStore();
        const password = await store.get();
        if (!password) return { restored: false, config };
        const saved = await call('saveConfig', {
          base_url: config.base_url,
          username: config.username,
          password,
          remember_password: true,
          remote_directory: config.remote_directory,
          remote_filename: config.remote_filename,
          allow_insecure_http: Boolean(config.allow_insecure_http),
        });
        try { await store.remove(); } catch { /* legacy cleanup is best effort */ }
        return { restored: true, config: saved };
      } catch {
        return { restored: false, config };
      }
    },

    async forgetPassword() {
      const saved = await call('saveConfig', {
        password: '',
        remember_password: false,
      });
      try { await (await getLegacyStore()).remove(); } catch { /* legacy cleanup is best effort */ }
      return saved;
    },

    async testConnection(draft) {
      return call('testConnection', {
        base_url: draft.base_url,
        username: draft.username,
        password: typeof draft.password === 'string' ? draft.password : '',
        remote_directory: draft.remote_directory,
        remote_filename: draft.remote_filename,
        allow_insecure_http: Boolean(draft.allow_insecure_http),
      });
    },

    async preflightUpload() {
      return call('preflightUpload');
    },

    async uploadLatest({ confirmed = false, expectedRemoteEtag = null, expectedRemoteExists = null } = {}) {
      if (!confirmed) throw Object.assign(new Error('需要确认后才能上传。'), { code: 'SYNC_CONFIRMATION_REQUIRED' });
      return call('upload', {
        confirmed: true,
        expected_remote_etag: expectedRemoteEtag,
        expected_remote_exists: expectedRemoteExists,
      });
    },

    async downloadLatest() {
      return call('download');
    },

    async getStatus() {
      return call('status');
    },
  };
}

export const syncAdapter = createSyncAdapter();
export default syncAdapter;
