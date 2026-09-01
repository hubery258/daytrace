package com.riji.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * Device-local storage for credentials and API keys. Values are encrypted by
 * an AndroidKeyStore AES/GCM key before they enter private SharedPreferences.
 * This plugin deliberately has no list/export API, so secrets cannot be swept
 * into the application's normal JSON backup path.
 */
@CapacitorPlugin(name = "RijiSecureStorage")
public final class RijiSecureStoragePlugin extends Plugin {
    private static final String PREFERENCES_NAME = "riji_private_secure_storage_v1";
    private static final String KEY_ALIAS = "riji.secure-storage.aes-gcm.v1";
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String VALUE_PREFIX = "v1:";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;
    private static final int MAX_KEY_CHARS = 256;
    private static final int MAX_VALUE_BYTES = 1024 * 1024;

    private final Object keyLock = new Object();
    private final SecureRandom secureRandom = new SecureRandom();
    private ExecutorService executor;
    private SharedPreferences preferences;

    @Override
    public void load() {
        preferences = getContext().getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        executor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "riji-secure-storage");
            thread.setDaemon(true);
            return thread;
        });
    }

    @PluginMethod
    public void get(PluginCall call) {
        final String key;
        try {
            key = requireString(call, "key", false, MAX_KEY_CHARS);
        } catch (InvalidInputException exception) {
            reject(call, exception.getMessage(), "INVALID_ARGUMENT");
            return;
        }

        submit(call, () -> {
            String encoded = preferences.getString(preferenceKey(key), null);
            JSObject result = new JSObject();
            if (encoded == null) {
                result.put("value", JSONObject.NULL);
            } else {
                result.put("value", decrypt(key, encoded));
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void set(PluginCall call) {
        final String key;
        final String value;
        try {
            key = requireString(call, "key", false, MAX_KEY_CHARS);
            value = requireString(call, "value", true, Integer.MAX_VALUE);
            if (value.getBytes(StandardCharsets.UTF_8).length > MAX_VALUE_BYTES) {
                throw new InvalidInputException("value is too large");
            }
        } catch (InvalidInputException exception) {
            reject(call, exception.getMessage(), "INVALID_ARGUMENT");
            return;
        }

        submit(call, () -> {
            String encrypted = encrypt(key, value);
            if (!preferences.edit().putString(preferenceKey(key), encrypted).commit()) {
                throw new StorageException("secure storage write failed", "WRITE_FAILED");
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        final String key;
        try {
            key = requireString(call, "key", false, MAX_KEY_CHARS);
        } catch (InvalidInputException exception) {
            reject(call, exception.getMessage(), "INVALID_ARGUMENT");
            return;
        }

        submit(call, () -> {
            String storageKey = preferenceKey(key);
            boolean existed = preferences.contains(storageKey);
            if (existed && !preferences.edit().remove(storageKey).commit()) {
                throw new StorageException("secure storage remove failed", "WRITE_FAILED");
            }
            JSObject result = new JSObject();
            result.put("removed", existed);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void has(PluginCall call) {
        final String key;
        try {
            key = requireString(call, "key", false, MAX_KEY_CHARS);
        } catch (InvalidInputException exception) {
            reject(call, exception.getMessage(), "INVALID_ARGUMENT");
            return;
        }

        submit(call, () -> {
            JSObject result = new JSObject();
            result.put("value", preferences.contains(preferenceKey(key)));
            call.resolve(result);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    private void submit(PluginCall call, StorageOperation operation) {
        if (executor == null || executor.isShutdown()) {
            reject(call, "secure storage is unavailable", "UNAVAILABLE");
            return;
        }
        try {
            executor.execute(() -> {
                try {
                    operation.run();
                } catch (StorageException exception) {
                    reject(call, exception.getMessage(), exception.code);
                } catch (Exception exception) {
                    // Never propagate provider messages: they can contain aliases or values.
                    reject(call, "secure storage operation failed", "SECURE_STORAGE_ERROR");
                }
            });
        } catch (RejectedExecutionException exception) {
            reject(call, "secure storage is unavailable", "UNAVAILABLE");
        }
    }

    private String encrypt(String logicalKey, String value) throws Exception {
        byte[] iv = new byte[IV_BYTES];
        secureRandom.nextBytes(iv);
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        cipher.updateAAD(logicalKey.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return VALUE_PREFIX +
            Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String logicalKey, String encoded) throws Exception {
        if (!encoded.startsWith(VALUE_PREFIX)) {
            throw new StorageException("secure storage item is invalid", "ITEM_CORRUPTED");
        }
        String[] fields = encoded.split(":", -1);
        if (fields.length != 3 || !"v1".equals(fields[0])) {
            throw new StorageException("secure storage item is invalid", "ITEM_CORRUPTED");
        }

        try {
            byte[] iv = Base64.decode(fields[1], Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(fields[2], Base64.NO_WRAP);
            if (iv.length != IV_BYTES || ciphertext.length < 16) {
                throw new StorageException("secure storage item is invalid", "ITEM_CORRUPTED");
            }
            Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            cipher.updateAAD(logicalKey.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (StorageException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new StorageException("secure storage item cannot be decrypted", "ITEM_CORRUPTED");
        }
    }

    private SecretKey getOrCreateKey() throws Exception {
        synchronized (keyLock) {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
            keyStore.load(null);
            java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
            if (existing instanceof SecretKey) {
                return (SecretKey) existing;
            }

            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE);
            generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256)
                .build());
            return generator.generateKey();
        }
    }

    private static String preferenceKey(String logicalKey) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(logicalKey.getBytes(StandardCharsets.UTF_8));
        return "item." + Base64.encodeToString(hash, Base64.NO_WRAP | Base64.URL_SAFE);
    }

    private static String requireString(
        PluginCall call,
        String name,
        boolean allowEmpty,
        int maxCharacters
    ) throws InvalidInputException {
        Object raw = call.getData().opt(name);
        if (!(raw instanceof String)) {
            throw new InvalidInputException(name + " must be a string");
        }
        String value = (String) raw;
        if ((!allowEmpty && value.trim().isEmpty()) || value.length() > maxCharacters || value.indexOf('\0') >= 0) {
            throw new InvalidInputException(name + " is invalid");
        }
        return value;
    }

    private static void reject(PluginCall call, String message, String code) {
        call.reject(message, code);
    }

    private interface StorageOperation {
        void run() throws Exception;
    }

    private static final class InvalidInputException extends Exception {
        InvalidInputException(String message) {
            super(message);
        }
    }

    private static final class StorageException extends Exception {
        final String code;

        StorageException(String message, String code) {
            super(message);
            this.code = code;
        }
    }
}
