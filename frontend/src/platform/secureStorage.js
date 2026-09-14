import { Capacitor, registerPlugin } from '@capacitor/core'

export const RijiSecureStorage = registerPlugin('RijiSecureStorage')

function requireKey(key) {
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 256 || key.includes('\0')) {
    throw new TypeError('secure storage key is invalid')
  }
  return key
}

function ensureAvailable() {
  if (!isSecureStorageAvailable()) {
    const error = new Error('Android secure storage is unavailable')
    error.code = 'UNAVAILABLE'
    throw error
  }
}

export function isSecureStorageAvailable() {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('RijiSecureStorage')
}

export async function getSecureValue(key) {
  ensureAvailable()
  const result = await RijiSecureStorage.get({ key: requireKey(key) })
  return typeof result?.value === 'string' ? result.value : null
}

export async function setSecureValue(key, value) {
  ensureAvailable()
  requireKey(key)
  if (typeof value !== 'string') {
    throw new TypeError('secure storage value must be a string')
  }
  await RijiSecureStorage.set({ key, value })
}

export async function removeSecureValue(key) {
  ensureAvailable()
  const result = await RijiSecureStorage.remove({ key: requireKey(key) })
  return result?.removed === true
}

export async function hasSecureValue(key) {
  ensureAvailable()
  const result = await RijiSecureStorage.has({ key: requireKey(key) })
  return result?.value === true
}

export const secureStorage = Object.freeze({
  get: getSecureValue,
  set: setSecureValue,
  remove: removeSecureValue,
  has: hasSecureValue,
  isAvailable: isSecureStorageAvailable,
})
