package com.riji.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.ProtocolException;
import java.net.URI;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * An Android-only HTTP transport for requests that cannot use WebView fetch.
 *
 * Security invariants:
 * - HTTPS uses the platform's default trust store and hostname verifier.
 * - Cookies live only in this plugin's in-memory CookieManager.
 * - Cookie response headers are never bridged back to JavaScript.
 * - URLs, headers, bodies and exception details are never logged.
 */
@CapacitorPlugin(name = "RijiHttp")
public final class RijiHttpPlugin extends Plugin {
    private static final int DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
    private static final int DEFAULT_READ_TIMEOUT_MS = 30_000;
    private static final int MAX_TIMEOUT_MS = 120_000;
    private static final int DEFAULT_MAX_REDIRECTS = 5;
    private static final int MAX_REDIRECTS = 10;
    private static final int DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
    private static final int MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
    private static final int MAX_HEADERS = 100;
    private static final int BUFFER_SIZE = 16 * 1024;

    private final ConcurrentMap<String, RequestContext> requests = new ConcurrentHashMap<>();
    private final Object cookieLock = new Object();
    private CookieManager cookieManager;
    private ExecutorService executor;
    private volatile boolean destroyed;

    @Override
    public void load() {
        cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "riji-native-http");
            thread.setDaemon(true);
            return thread;
        });
    }

    @PluginMethod
    public void request(PluginCall call) {
        final RequestSpec spec;
        try {
            spec = RequestSpec.from(call.getData());
        } catch (InvalidRequestException | IllegalArgumentException exception) {
            call.reject(exception.getMessage(), "INVALID_ARGUMENT");
            return;
        }

        if (destroyed || executor == null || executor.isShutdown()) {
            call.reject("native http is unavailable", "UNAVAILABLE");
            return;
        }

        RequestContext context = new RequestContext(spec.requestId, call);
        if (requests.putIfAbsent(spec.requestId, context) != null) {
            call.reject("requestId is already active", "DUPLICATE_REQUEST_ID");
            return;
        }

        try {
            executor.execute(() -> execute(context, spec));
        } catch (RejectedExecutionException exception) {
            requests.remove(spec.requestId, context);
            context.reject("native http is unavailable", "UNAVAILABLE");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Object raw = call.getData().opt("requestId");
        if (!(raw instanceof String) || !isValidRequestId((String) raw)) {
            call.reject("requestId is invalid", "INVALID_ARGUMENT");
            return;
        }

        RequestContext context = requests.get((String) raw);
        boolean cancelled = context != null && context.cancel();
        JSObject result = new JSObject();
        result.put("cancelled", cancelled);
        call.resolve(result);
    }

    @PluginMethod
    public void clearCookies(PluginCall call) {
        if (cookieManager == null) {
            call.reject("native http is unavailable", "UNAVAILABLE");
            return;
        }
        synchronized (cookieLock) {
            cookieManager.getCookieStore().removeAll();
        }
        JSObject result = new JSObject();
        result.put("cleared", true);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        for (RequestContext context : requests.values()) {
            context.closeForDestroy();
        }
        requests.clear();
        if (executor != null) {
            executor.shutdownNow();
        }
        if (cookieManager != null) {
            synchronized (cookieLock) {
                cookieManager.getCookieStore().removeAll();
            }
        }
    }

    private void execute(RequestContext context, RequestSpec spec) {
        context.attachWorker(Thread.currentThread());
        try {
            if (context.isCancelled()) {
                throw new RequestCancelledException();
            }
            context.resolve(performRequest(context, spec));
        } catch (RequestCancelledException exception) {
            context.reject("request was cancelled", "REQUEST_CANCELLED");
        } catch (ResponseTooLargeException exception) {
            context.reject("response exceeded the configured size limit", "RESPONSE_TOO_LARGE");
        } catch (RedirectException exception) {
            context.reject(exception.getMessage(), exception.code);
        } catch (ProtocolException exception) {
            context.reject("http protocol error", "PROTOCOL_ERROR");
        } catch (IOException exception) {
            if (context.isCancelled()) {
                context.reject("request was cancelled", "REQUEST_CANCELLED");
            } else {
                context.reject(safeNetworkMessage(exception), RijiHttpSupport.networkErrorCode(exception));
            }
        } catch (SecurityException exception) {
            context.reject("request was blocked by the platform", "SECURITY_ERROR");
        } catch (Exception exception) {
            context.reject("native http request failed", "REQUEST_FAILED");
        } finally {
            context.detachConnection(null);
            context.detachWorker();
            requests.remove(spec.requestId, context);
            // Do not leak a cancellation interrupt into another pooled request.
            Thread.interrupted();
        }
    }

    private JSObject performRequest(RequestContext context, RequestSpec spec) throws Exception {
        URI currentUri = spec.uri;
        String currentMethod = spec.method;
        byte[] currentBody = spec.body;
        Map<String, List<String>> currentHeaders = copyHeaders(spec.headers);
        int redirectCount = 0;

        while (true) {
            if (context.isCancelled()) {
                throw new RequestCancelledException();
            }

            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) currentUri.toURL().openConnection();
                context.attachConnection(connection);
                connection.setConnectTimeout(spec.connectTimeoutMs);
                connection.setReadTimeout(spec.readTimeoutMs);
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setRequestMethod(currentMethod);

                applyHeaders(connection, currentHeaders);
                applyCookies(connection, currentUri);

                if (currentBody != null) {
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(currentBody.length);
                    try (OutputStream output = connection.getOutputStream()) {
                        output.write(currentBody);
                    }
                }

                int status = connection.getResponseCode();
                Map<String, List<String>> responseHeaders = connection.getHeaderFields();
                storeCookies(currentUri, responseHeaders);

                if (RijiHttpSupport.isRedirect(status)) {
                    if ("error".equals(spec.redirectMode)) {
                        throw new RedirectException("redirect was not allowed", "REDIRECT_DISALLOWED");
                    }
                    if ("follow".equals(spec.redirectMode)) {
                        if (redirectCount >= spec.maxRedirects) {
                            throw new RedirectException("too many redirects", "TOO_MANY_REDIRECTS");
                        }
                        URI nextUri;
                        try {
                            nextUri = RijiHttpSupport.resolveRedirect(currentUri, connection.getHeaderField("Location"));
                        } catch (IllegalArgumentException exception) {
                            throw new RedirectException("redirect location was invalid", "INVALID_REDIRECT");
                        }
                        if (RijiHttpSupport.isTlsDowngrade(currentUri, nextUri) && !spec.allowInsecureRedirects) {
                            throw new RedirectException("insecure redirect was blocked", "INSECURE_REDIRECT");
                        }

                        String nextMethod = RijiHttpSupport.redirectedMethod(status, currentMethod);
                        if (!RijiHttpSupport.isSameOrigin(currentUri, nextUri)) {
                            removeHeader(currentHeaders, "Authorization");
                            removeHeader(currentHeaders, "Proxy-Authorization");
                            removeHeader(currentHeaders, "Cookie");
                        }
                        if (!nextMethod.equals(currentMethod)) {
                            currentBody = null;
                            removeHeader(currentHeaders, "Content-Type");
                            removeHeader(currentHeaders, "Content-Length");
                            removeHeader(currentHeaders, "Transfer-Encoding");
                        }

                        currentUri = nextUri;
                        currentMethod = nextMethod;
                        redirectCount += 1;
                        continue;
                    }
                }

                byte[] responseBody = readResponseBody(connection, status, spec.maxResponseBytes, context);
                JSObject result = new JSObject();
                result.put("requestId", spec.requestId);
                result.put("status", status);
                result.put("headers", exposedHeaders(responseHeaders));
                if ("base64".equals(spec.responseType)) {
                    result.put("body", Base64.encodeToString(responseBody, Base64.NO_WRAP));
                } else {
                    Charset charset = RijiHttpSupport.responseCharset(connection.getContentType());
                    result.put("body", new String(responseBody, charset));
                }
                result.put("url", currentUri.toString());
                result.put("redirected", redirectCount > 0);
                return result;
            } finally {
                if (connection != null) {
                    context.detachConnection(connection);
                    connection.disconnect();
                }
            }
        }
    }

    private void applyHeaders(HttpURLConnection connection, Map<String, List<String>> headers) {
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            boolean first = true;
            for (String value : entry.getValue()) {
                if (first) {
                    connection.setRequestProperty(entry.getKey(), value);
                    first = false;
                } else {
                    connection.addRequestProperty(entry.getKey(), value);
                }
            }
        }
    }

    private void applyCookies(HttpURLConnection connection, URI uri) throws IOException {
        Map<String, List<String>> cookieHeaders;
        synchronized (cookieLock) {
            cookieHeaders = cookieManager.get(uri, Collections.emptyMap());
        }
        for (Map.Entry<String, List<String>> entry : cookieHeaders.entrySet()) {
            for (String value : entry.getValue()) {
                connection.addRequestProperty(entry.getKey(), value);
            }
        }
    }

    private void storeCookies(URI uri, Map<String, List<String>> responseHeaders) throws IOException {
        if (responseHeaders == null) {
            return;
        }
        synchronized (cookieLock) {
            cookieManager.put(uri, responseHeaders);
        }
    }

    private static byte[] readResponseBody(
        HttpURLConnection connection,
        int status,
        int maxBytes,
        RequestContext context
    ) throws IOException, ResponseTooLargeException, RequestCancelledException {
        String contentLength = connection.getHeaderField("Content-Length");
        if (contentLength != null) {
            try {
                long declared = Long.parseLong(contentLength.trim());
                if (declared > maxBytes) {
                    throw new ResponseTooLargeException();
                }
            } catch (NumberFormatException ignored) {
                // A malformed length is handled by the streaming limit below.
            }
        }

        InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (input == null) {
            return new byte[0];
        }
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = stream.read(buffer)) != -1) {
                if (context.isCancelled() || Thread.currentThread().isInterrupted()) {
                    throw new RequestCancelledException();
                }
                if (output.size() > maxBytes - read) {
                    throw new ResponseTooLargeException();
                }
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static JSObject exposedHeaders(Map<String, List<String>> headers) {
        JSObject result = new JSObject();
        if (headers == null) {
            return result;
        }
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            String name = entry.getKey();
            if (name == null || isCookieHeader(name)) {
                continue;
            }
            List<String> values = entry.getValue();
            if (values != null && !values.isEmpty()) {
                result.put(name, joinHeaderValues(values));
            }
        }
        return result;
    }

    private static String joinHeaderValues(List<String> values) {
        StringBuilder joined = new StringBuilder();
        for (String value : values) {
            if (value == null) {
                continue;
            }
            if (joined.length() > 0) {
                joined.append(", ");
            }
            joined.append(value);
        }
        return joined.toString();
    }

    private static boolean isCookieHeader(String name) {
        return "Set-Cookie".equalsIgnoreCase(name) || "Set-Cookie2".equalsIgnoreCase(name);
    }

    private static Map<String, List<String>> copyHeaders(Map<String, List<String>> source) {
        Map<String, List<String>> copy = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> entry : source.entrySet()) {
            copy.put(entry.getKey(), new ArrayList<>(entry.getValue()));
        }
        return copy;
    }

    private static void removeHeader(Map<String, List<String>> headers, String target) {
        String match = null;
        for (String name : headers.keySet()) {
            if (target.equalsIgnoreCase(name)) {
                match = name;
                break;
            }
        }
        if (match != null) {
            headers.remove(match);
        }
    }

    private static String safeNetworkMessage(IOException exception) {
        String code = RijiHttpSupport.networkErrorCode(exception);
        switch (code) {
            case "TIMEOUT":
                return "request timed out";
            case "DNS_ERROR":
                return "host could not be resolved";
            case "TLS_ERROR":
                return "secure connection failed";
            case "CONNECTION_ERROR":
                return "connection failed";
            default:
                return "network request failed";
        }
    }

    private static boolean isValidRequestId(String requestId) {
        if (requestId == null || requestId.isEmpty() || requestId.length() > 128) {
            return false;
        }
        for (int index = 0; index < requestId.length(); index += 1) {
            char character = requestId.charAt(index);
            boolean allowed = (character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') ||
                character == '.' || character == '_' || character == ':' || character == '-';
            if (!allowed) {
                return false;
            }
        }
        return true;
    }

    private static final class RequestSpec {
        final String requestId;
        final URI uri;
        final String method;
        final Map<String, List<String>> headers;
        final byte[] body;
        final int connectTimeoutMs;
        final int readTimeoutMs;
        final String redirectMode;
        final int maxRedirects;
        final boolean allowInsecureRedirects;
        final int maxResponseBytes;
        final String responseType;

        private RequestSpec(
            String requestId,
            URI uri,
            String method,
            Map<String, List<String>> headers,
            byte[] body,
            int connectTimeoutMs,
            int readTimeoutMs,
            String redirectMode,
            int maxRedirects,
            boolean allowInsecureRedirects,
            int maxResponseBytes,
            String responseType
        ) {
            this.requestId = requestId;
            this.uri = uri;
            this.method = method;
            this.headers = headers;
            this.body = body;
            this.connectTimeoutMs = connectTimeoutMs;
            this.readTimeoutMs = readTimeoutMs;
            this.redirectMode = redirectMode;
            this.maxRedirects = maxRedirects;
            this.allowInsecureRedirects = allowInsecureRedirects;
            this.maxResponseBytes = maxResponseBytes;
            this.responseType = responseType;
        }

        static RequestSpec from(JSObject data) throws InvalidRequestException {
            String requestId = optionalString(data, "requestId", UUID.randomUUID().toString());
            if (!isValidRequestId(requestId)) {
                throw new InvalidRequestException("requestId is invalid");
            }

            Object rawUrl = data.opt("url");
            if (!(rawUrl instanceof String)) {
                throw new InvalidRequestException("url must be a string");
            }
            URI uri = RijiHttpSupport.requireHttpUri((String) rawUrl);
            String method = RijiHttpSupport.requireMethod(optionalString(data, "method", "GET"));
            Map<String, List<String>> headers = parseHeaders(data.opt("headers"));
            byte[] body = parseBody(data.opt("body"));
            if (body != null && ("GET".equals(method) || "HEAD".equals(method))) {
                throw new InvalidRequestException("GET and HEAD requests cannot have a body");
            }

            int connectTimeout = boundedInt(data, "connectTimeoutMs", DEFAULT_CONNECT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
            int readTimeout = boundedInt(data, "readTimeoutMs", DEFAULT_READ_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
            String redirect = optionalString(data, "redirect", "follow").toLowerCase(Locale.US);
            if (!("follow".equals(redirect) || "manual".equals(redirect) || "error".equals(redirect))) {
                throw new InvalidRequestException("redirect must be follow, manual, or error");
            }
            int maxRedirects = boundedInt(data, "maxRedirects", DEFAULT_MAX_REDIRECTS, 0, MAX_REDIRECTS);
            boolean allowInsecureRedirects = optionalBoolean(data, "allowInsecureRedirects", false);
            int maxResponseBytes = boundedInt(
                data,
                "maxResponseBytes",
                DEFAULT_MAX_RESPONSE_BYTES,
                1,
                MAX_RESPONSE_BYTES
            );
            String responseType = optionalString(data, "responseType", "text").toLowerCase(Locale.US);
            if (!("text".equals(responseType) || "base64".equals(responseType))) {
                throw new InvalidRequestException("responseType must be text or base64");
            }

            return new RequestSpec(
                requestId,
                uri,
                method,
                headers,
                body,
                connectTimeout,
                readTimeout,
                redirect,
                maxRedirects,
                allowInsecureRedirects,
                maxResponseBytes,
                responseType
            );
        }

        private static Map<String, List<String>> parseHeaders(Object raw) throws InvalidRequestException {
            Map<String, List<String>> headers = new LinkedHashMap<>();
            if (raw == null || raw == JSONObject.NULL) {
                return headers;
            }
            if (!(raw instanceof JSONObject)) {
                throw new InvalidRequestException("headers must be an object");
            }
            JSONObject object = (JSONObject) raw;
            if (object.length() > MAX_HEADERS) {
                throw new InvalidRequestException("too many headers");
            }
            java.util.Iterator<String> names = object.keys();
            while (names.hasNext()) {
                String name = names.next();
                if (!RijiHttpSupport.isValidHeaderName(name)) {
                    throw new InvalidRequestException("header name is invalid");
                }
                if ("Content-Length".equalsIgnoreCase(name) || "Transfer-Encoding".equalsIgnoreCase(name)) {
                    throw new InvalidRequestException("content framing headers are managed by native http");
                }
                List<String> values = parseHeaderValues(object.opt(name));
                headers.put(name, values);
            }
            return headers;
        }

        private static List<String> parseHeaderValues(Object raw) throws InvalidRequestException {
            List<String> values = new ArrayList<>();
            if (raw instanceof String) {
                values.add(requireHeaderValue((String) raw));
                return values;
            }
            if (raw instanceof JSONArray) {
                JSONArray array = (JSONArray) raw;
                if (array.length() == 0 || array.length() > 32) {
                    throw new InvalidRequestException("header value array is invalid");
                }
                for (int index = 0; index < array.length(); index += 1) {
                    Object item = array.opt(index);
                    if (!(item instanceof String)) {
                        throw new InvalidRequestException("header values must be strings");
                    }
                    values.add(requireHeaderValue((String) item));
                }
                return values;
            }
            throw new InvalidRequestException("header values must be strings or string arrays");
        }

        private static String requireHeaderValue(String value) throws InvalidRequestException {
            if (!RijiHttpSupport.isValidHeaderValue(value)) {
                throw new InvalidRequestException("header value is invalid");
            }
            return value;
        }

        private static byte[] parseBody(Object raw) throws InvalidRequestException {
            if (raw == null || raw == JSONObject.NULL) {
                return null;
            }
            if (!(raw instanceof String)) {
                throw new InvalidRequestException("body must be a string");
            }
            byte[] body = ((String) raw).getBytes(StandardCharsets.UTF_8);
            if (body.length > MAX_REQUEST_BODY_BYTES) {
                throw new InvalidRequestException("request body is too large");
            }
            return body;
        }

        private static String optionalString(JSObject data, String key, String fallback) throws InvalidRequestException {
            Object raw = data.opt(key);
            if (raw == null || raw == JSONObject.NULL) {
                return fallback;
            }
            if (!(raw instanceof String)) {
                throw new InvalidRequestException(key + " must be a string");
            }
            return (String) raw;
        }

        private static boolean optionalBoolean(JSObject data, String key, boolean fallback) throws InvalidRequestException {
            Object raw = data.opt(key);
            if (raw == null || raw == JSONObject.NULL) {
                return fallback;
            }
            if (!(raw instanceof Boolean)) {
                throw new InvalidRequestException(key + " must be a boolean");
            }
            return (Boolean) raw;
        }

        private static int boundedInt(JSObject data, String key, int fallback, int minimum, int maximum)
            throws InvalidRequestException {
            Object raw = data.opt(key);
            if (raw == null || raw == JSONObject.NULL) {
                return fallback;
            }
            if (!(raw instanceof Number)) {
                throw new InvalidRequestException(key + " must be an integer");
            }
            Number number = (Number) raw;
            double doubleValue = number.doubleValue();
            int value = number.intValue();
            if (!Double.isFinite(doubleValue) || doubleValue != value || value < minimum || value > maximum) {
                throw new InvalidRequestException(key + " is out of range");
            }
            return value;
        }
    }

    private static final class RequestContext {
        private final String requestId;
        private final PluginCall call;
        private final AtomicBoolean completed = new AtomicBoolean(false);
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private volatile HttpURLConnection connection;
        private volatile Thread worker;

        RequestContext(String requestId, PluginCall call) {
            this.requestId = requestId;
            this.call = call;
        }

        void attachWorker(Thread thread) {
            worker = thread;
        }

        void detachWorker() {
            worker = null;
        }

        void attachConnection(HttpURLConnection value) throws RequestCancelledException {
            connection = value;
            if (cancelled.get()) {
                value.disconnect();
                throw new RequestCancelledException();
            }
        }

        void detachConnection(HttpURLConnection expected) {
            HttpURLConnection active = connection;
            if (expected == null || active == expected) {
                connection = null;
            }
        }

        boolean isCancelled() {
            return cancelled.get();
        }

        boolean cancel() {
            if (completed.get()) {
                return false;
            }
            cancelled.set(true);
            reject("request was cancelled", "REQUEST_CANCELLED");
            disconnectAndInterrupt();
            return true;
        }

        void closeForDestroy() {
            cancelled.set(true);
            reject("native http was closed", "UNAVAILABLE");
            disconnectAndInterrupt();
        }

        void resolve(JSObject result) {
            if (completed.compareAndSet(false, true)) {
                call.resolve(result);
            }
        }

        void reject(String message, String code) {
            if (completed.compareAndSet(false, true)) {
                call.reject(message, code);
            }
        }

        private void disconnectAndInterrupt() {
            HttpURLConnection activeConnection = connection;
            if (activeConnection != null) {
                activeConnection.disconnect();
            }
            Thread activeWorker = worker;
            if (activeWorker != null) {
                activeWorker.interrupt();
            }
        }
    }

    private static final class InvalidRequestException extends Exception {
        InvalidRequestException(String message) {
            super(message);
        }
    }

    private static final class RequestCancelledException extends Exception {}

    private static final class ResponseTooLargeException extends Exception {}

    private static final class RedirectException extends Exception {
        final String code;

        RedirectException(String message, String code) {
            super(message);
            this.code = code;
        }
    }
}
