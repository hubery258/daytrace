package com.riji.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Minimal HTTP/1.1 exchange for WebDAV methods that {@link java.net.HttpURLConnection}
 * refuses to send.
 *
 * Android's HttpURLConnection only permits GET, POST, HEAD, OPTIONS, PUT, DELETE
 * and TRACE, so PROPFIND and MKCOL — required by the v0.11.0 manual WebDAV sync —
 * cannot go through it. This class performs exactly those requests over a plain
 * or TLS socket while keeping the existing security rules:
 *
 * - HTTPS uses the platform trust store plus HTTPS endpoint identification.
 * - The path, headers and body come from the caller; credentials stay in headers
 *   supplied by {@link RijiHttpPlugin} and are never logged here.
 * - Responses are bounded by the caller's size limit.
 *
 * Redirects are intentionally not followed: a redirect could forward the
 * Authorization header to another host, so the 3xx response is returned as-is.
 */
final class RijiHttpRawExchange {
    private static final Set<String> PERMITTED_METHODS = new HashSet<>(Arrays.asList(
        "GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"
    ));
    private static final int BUFFER_SIZE = 16 * 1024;

    private RijiHttpRawExchange() {}

    /** True when the method must bypass HttpURLConnection. */
    static boolean requiresRawTransport(String method) {
        return method != null && !method.isEmpty() && !PERMITTED_METHODS.contains(method.toUpperCase(Locale.US));
    }

    static final class Result {
        final int status;
        final Map<String, List<String>> headers;
        final byte[] body;

        Result(int status, Map<String, List<String>> headers, byte[] body) {
            this.status = status;
            this.headers = headers;
            this.body = body;
        }
    }

    static final class TooLargeException extends IOException {
        TooLargeException() {
            super("response exceeded the configured size limit");
        }
    }

    interface SocketOpener {
        Socket open(URI uri, int connectTimeoutMs, int readTimeoutMs) throws IOException;
    }

    static SocketOpener defaultOpener() {
        return (uri, connectTimeoutMs, readTimeoutMs) -> {
            String scheme = uri.getScheme() == null ? "http" : uri.getScheme().toLowerCase(Locale.US);
            int port = uri.getPort() >= 0 ? uri.getPort() : ("https".equals(scheme) ? 443 : 80);
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress(uri.getHost(), port), connectTimeoutMs);
            socket.setSoTimeout(readTimeoutMs);
            if (!"https".equals(scheme)) {
                return socket;
            }
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            SSLSocket ssl = (SSLSocket) factory.createSocket(socket, uri.getHost(), port, true);
            SSLParameters parameters = ssl.getSSLParameters();
            parameters.setEndpointIdentificationAlgorithm("HTTPS");
            ssl.setSSLParameters(parameters);
            ssl.startHandshake();
            return ssl;
        };
    }

    static Result execute(
        String url,
        String method,
        Map<String, List<String>> headers,
        byte[] body,
        int connectTimeoutMs,
        int readTimeoutMs,
        int maxResponseBytes
    ) throws IOException {
        return execute(url, method, headers, body, connectTimeoutMs, readTimeoutMs, maxResponseBytes, defaultOpener());
    }

    static Result execute(
        String url,
        String method,
        Map<String, List<String>> headers,
        byte[] body,
        int connectTimeoutMs,
        int readTimeoutMs,
        int maxResponseBytes,
        SocketOpener opener
    ) throws IOException {
        URI uri = RijiHttpSupport.requireHttpUri(url);
        String head = buildRequestHead(method, uri, headers, body == null ? -1 : body.length);
        Socket socket = opener.open(uri, connectTimeoutMs, readTimeoutMs);
        try {
            OutputStream output = socket.getOutputStream();
            output.write(head.getBytes(StandardCharsets.ISO_8859_1));
            if (body != null && body.length > 0) {
                output.write(body);
            }
            output.flush();
            return parseResponse(socket.getInputStream(), maxResponseBytes);
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Closing is best effort.
            }
        }
    }

    /** Build the request head. Header values are written verbatim, nothing is logged. */
    static String buildRequestHead(String method, URI uri, Map<String, List<String>> headers, int bodyLength) {
        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) {
            path = "/";
        }
        if (uri.getRawQuery() != null && !uri.getRawQuery().isEmpty()) {
            path = path + "?" + uri.getRawQuery();
        }
        int port = uri.getPort();
        String host = port >= 0 ? uri.getHost() + ":" + port : uri.getHost();
        StringBuilder builder = new StringBuilder();
        builder.append(method.toUpperCase(Locale.US)).append(' ').append(path).append(" HTTP/1.1\r\n");
        builder.append("Host: ").append(host).append("\r\n");
        builder.append("Connection: close\r\n");
        if (headers != null) {
            for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
                String name = entry.getKey();
                if (name == null || isManagedHeader(name)) {
                    continue;
                }
                for (String value : entry.getValue()) {
                    if (value == null) {
                        continue;
                    }
                    builder.append(name).append(": ").append(value).append("\r\n");
                }
            }
        }
        if (bodyLength >= 0) {
            builder.append("Content-Length: ").append(bodyLength).append("\r\n");
        }
        builder.append("\r\n");
        return builder.toString();
    }

    private static boolean isManagedHeader(String name) {
        String lower = name.toLowerCase(Locale.US);
        return lower.equals("host") || lower.equals("connection") || lower.equals("content-length");
    }

    static Result parseResponse(InputStream input, int maxResponseBytes) throws IOException {
        String statusLine = readLine(input);
        if (statusLine == null || statusLine.trim().isEmpty()) {
            throw new IOException("empty http response");
        }
        String[] parts = statusLine.trim().split(" ", 3);
        if (parts.length < 2) {
            throw new IOException("malformed http status line");
        }
        final int status;
        try {
            status = Integer.parseInt(parts[1].trim());
        } catch (NumberFormatException exception) {
            throw new IOException("malformed http status line");
        }

        Map<String, List<String>> headers = new LinkedHashMap<>();
        String line;
        while ((line = readLine(input)) != null && !line.isEmpty()) {
            int separator = line.indexOf(':');
            if (separator <= 0) {
                continue;
            }
            String name = line.substring(0, separator).trim();
            String value = line.substring(separator + 1).trim();
            if (name.isEmpty()) {
                continue;
            }
            List<String> values = headers.get(name);
            if (values == null) {
                values = new ArrayList<>();
                headers.put(name, values);
            }
            values.add(value);
        }

        byte[] body;
        String transferEncoding = headerValue(headers, "Transfer-Encoding");
        if (transferEncoding != null && transferEncoding.toLowerCase(Locale.US).contains("chunked")) {
            body = readChunkedBody(input, maxResponseBytes);
        } else {
            String contentLength = headerValue(headers, "Content-Length");
            if (contentLength != null) {
                final long declared;
                try {
                    declared = Long.parseLong(contentLength.trim());
                } catch (NumberFormatException exception) {
                    throw new IOException("invalid content length");
                }
                if (declared < 0) {
                    throw new IOException("invalid content length");
                }
                if (declared > maxResponseBytes) {
                    throw new TooLargeException();
                }
                body = readFully(input, (int) declared, maxResponseBytes);
            } else {
                body = readUntilEof(input, maxResponseBytes);
            }
        }
        return new Result(status, headers, body);
    }

    static String headerValue(Map<String, List<String>> headers, String name) {
        if (headers == null || name == null) {
            return null;
        }
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) {
                List<String> values = entry.getValue();
                return values == null || values.isEmpty() ? null : values.get(0);
            }
        }
        return null;
    }

    private static byte[] readChunkedBody(InputStream input, int maxResponseBytes) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        while (true) {
            String sizeLine = readLine(input);
            if (sizeLine == null) {
                throw new IOException("unexpected end of chunked body");
            }
            String token = sizeLine.trim();
            int extension = token.indexOf(';');
            if (extension >= 0) {
                token = token.substring(0, extension).trim();
            }
            final int size;
            try {
                size = Integer.parseInt(token, 16);
            } catch (NumberFormatException exception) {
                throw new IOException("invalid chunk size");
            }
            if (size < 0) {
                throw new IOException("invalid chunk size");
            }
            if (size == 0) {
                // Consume trailers until the terminating blank line.
                String trailer;
                while ((trailer = readLine(input)) != null && !trailer.isEmpty()) {
                    // Trailers carry no data we need.
                }
                return output.toByteArray();
            }
            if (output.size() + size > maxResponseBytes) {
                throw new TooLargeException();
            }
            byte[] chunk = readFully(input, size, maxResponseBytes);
            output.write(chunk, 0, chunk.length);
            readLine(input); // trailing CRLF after the chunk
        }
    }

    private static byte[] readFully(InputStream input, int length, int maxResponseBytes) throws IOException {
        if (length > maxResponseBytes) {
            throw new TooLargeException();
        }
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(buffer, offset, length - offset);
            if (read < 0) {
                throw new IOException("unexpected end of response");
            }
            offset += read;
        }
        return buffer;
    }

    private static byte[] readUntilEof(InputStream input, int maxResponseBytes) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[BUFFER_SIZE];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (output.size() + read > maxResponseBytes) {
                throw new TooLargeException();
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') {
                break;
            }
            if (value != '\r') {
                output.write(value);
            }
        }
        if (value == -1 && output.size() == 0) {
            return null;
        }
        return new String(output.toByteArray(), StandardCharsets.ISO_8859_1);
    }
}
