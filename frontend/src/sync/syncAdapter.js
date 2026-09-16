/**
 * Unified WebDAV SyncAdapter (v0.11.0).
 *
 * The settings UI only talks to this adapter. Platform differences stay behind
 * it:
 *
 * | platform            | network path                        | password storage          |
 * | ------------------- | ----------------------------------- | ------------------------- |
 * | Web + local FastAPI | local backend proxies WebDAV        | encrypted browser storage |
 * | Windows Electron    | FastAPI sidecar proxies WebDAV      | Electron safeStorage      |
 * | Android             | Capacitor native HTTP (RijiHttp)    | Android Keystore          |
 *
 * v0.11.0 is manual only: every remote mutation goes through an explicit user
 * confirmation, downloads never write the local database and no merge algorithm
 * is added here.
 */

import { syncApi } from '../api/clientCore.js';
import { createPasswordStore } from './passwordStore.js';

export function createSyncAdapter({ api = syncApi, passwordStore = null } = {}) {
  let storePromise = null;
  const getStore = async () => {
    if (!storePromise) storePromise = Promise.resolve(passwordStore || createPasswordStore());
    return storePromise;
  };

  const call = (method, ...args) => api[method](...args);

  return {
    async getConfig() {
      return call('getConfig');
    },

    async saveConfig(draft) {
      const store = await getStore();
      const remember = Boolean(draft.remember_password);
      const password = typeof draft.password === 'string' ? draft.password : '';
      if (remember && password) {
        // Optional durability: v0.11.1 automatic sync will depend on it.
        await store.set(password);
      } else if (!remember) {
        await store.remove();
      }
      return call('saveConfig', {
        base_url: draft.base_url,
        username: draft.username,
        password,
        remember_password: remember,
        remote_directory: draft.remote_directory,
        remote_filename: draft.remote_filename,
        allow_insecure_http: Boolean(draft.allow_insecure_http),
      });
    },

    /** Re-seed the backend session with a remembered password after a reload. */
    async restoreRememberedPassword() {
      const store = await getStore();
      const config = await call('getConfig');
      if (config.has_password) return { restored: false, config };
      if (!config.remember_password || !config.base_url) return { restored: false, config };
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
      return { restored: true, config: saved };
    },

    async forgetPassword() {
      const store = await getStore();
      await store.remove();
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
