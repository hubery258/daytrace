/**
 * Cross-platform secret storage for the WebDAV password (v0.11.0).
 *
 * Password handling rules:
 * - The password never enters the JSON data package, a log line or an error
 *   message.
 * - Web remembers nothing by default. When the user opts in, the value is
 *   encrypted with a non-extractable WebCrypto AES-GCM key and stored in the
 *   browser; the UI must state that this is weaker than a system keychain.
 * - Windows desktop uses Electron safeStorage (DPAPI backed) through the
 *   preload bridge.
 * - Android uses the existing RijiSecureStorage plugin (Android Keystore).
 */

import { Capacitor } from '@capacitor/core';

import { isSecureStorageAvailable, secureStorage } from '../platform/secureStorage.js';

export const WEBDAV_SECRET_KEY = 'daytrace_webdav_password';
const KEY_STORAGE_NAME = 'daytrace-webdav-secret';
const KEY_STORAGE_STORE = 'keys';
const KEY_STORAGE_ID = 'webdav-password';

function byteToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function base64ToBytes(value) {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createMemoryKeyStorage() {
  let key = null;
  return {
    async load() { return key; },
    async save(value) { key = value; },
    async clear() { key = null; },
  };
}

export function createIndexedDbKeyStorage({ indexedDB = globalThis.indexedDB, name = KEY_STORAGE_NAME } = {}) {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORAGE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb open failed'));
  });
  const withStore = async (mode, run) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(KEY_STORAGE_STORE, mode);
        const store = transaction.objectStore(KEY_STORAGE_STORE);
        const request = run(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('indexeddb request failed'));
      });
    } finally {
      db.close();
    }
  };
  return {
    async load() {
      const value = await withStore('readonly', (store) => store.get(KEY_STORAGE_ID));
      return value ?? null;
    },
    async save(value) { await withStore('readwrite', (store) => store.put(value, KEY_STORAGE_ID)); },
    async clear() { await withStore('readwrite', (store) => store.delete(KEY_STORAGE_ID)); },
  };
}

function desktopBridge() {
  const bridge = globalThis.rijiDesktop?.secure;
  return bridge && typeof bridge.isAvailable === 'function' && bridge.isAvailable() === true ? bridge : null;
}

async function importAesKey(rawKey) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 WebCrypto，无法加密保存密码');
  return subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function createWebSecretStore({ storage = globalThis.localStorage, keyStorage, subtle = globalThis.crypto?.subtle, cryptoRef = globalThis.crypto } = {}) {
  const keys = keyStorage || createIndexedDbKeyStorage();
  const loadKey = async () => {
    const stored = await keys.load();
    if (stored) return importAesKey(stored instanceof Uint8Array ? stored : new Uint8Array(stored));
    const raw = cryptoRef.getRandomValues(new Uint8Array(32));
    await keys.save(raw);
    return importAesKey(raw);
  };
  const remove = async () => { storage.removeItem(WEBDAV_SECRET_KEY); };
  return {
    async set(value) {
      if (!value) throw new TypeError('password must be a non-empty string');
      const key = await loadKey();
      const iv = cryptoRef.getRandomValues(new Uint8Array(12));
      const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
      storage.setItem(WEBDAV_SECRET_KEY, JSON.stringify({
        v: 1,
        iv: byteToBase64(iv),
        data: byteToBase64(new Uint8Array(ciphertext)),
      }));
    },
    async get() {
      const raw = storage.getItem(WEBDAV_SECRET_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const key = await loadKey();
        const plaintext = await subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(parsed.iv) },
          key,
          base64ToBytes(parsed.data),
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        // A broken blob must never block the user; it just means "no password".
        await remove();
        return null;
      }
    },
    remove,
    kind: 'web-encrypted-local-storage',
  };
}

function createMemoryStore() {
  let value = null;
  return {
    async set(next) { value = next; },
    async get() { return value; },
    async remove() { value = null; },
    kind: 'session-memory',
  };
}

export async function createPasswordStore(options = {}) {
  const platform = options.platform || Capacitor.getPlatform();
  if (platform === 'android' && (options.forceAndroid || isSecureStorageAvailable())) {
    return {
      kind: 'android-keystore',
      async set(value) { await secureStorage.set(WEBDAV_SECRET_KEY, value); },
      async get() {
        try {
          return await secureStorage.get(WEBDAV_SECRET_KEY);
        } catch {
          return null;
        }
      },
      async remove() {
        try { await secureStorage.remove(WEBDAV_SECRET_KEY); } catch { /* nothing persisted */ }
      },
    };
  }
  const bridge = options.desktopBridge || desktopBridge();
  if (bridge) {
    return {
      kind: 'electron-safe-storage',
      async set(value) { await bridge.set(WEBDAV_SECRET_KEY, value); },
      async get() {
        try {
          const value = await bridge.get(WEBDAV_SECRET_KEY);
          return typeof value === 'string' && value ? value : null;
        } catch {
          return null;
        }
      },
      async remove() { await bridge.remove(WEBDAV_SECRET_KEY); },
    };
  }
  if (options.webStore) return options.webStore;
  if (platform !== 'android' && globalThis.localStorage && globalThis.crypto?.subtle) {
    try {
      return await createWebSecretStore(options.webSecretOptions || {});
    } catch {
      return createMemoryStore();
    }
  }
  return createMemoryStore();
}

export const webdavPasswordStore = Object.freeze({
  create: createPasswordStore,
});

export default createPasswordStore;
