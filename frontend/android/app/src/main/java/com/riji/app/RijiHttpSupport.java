package com.riji.app;

import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;

/**
 * Pure-Java helpers for {@link RijiHttpPlugin}. Keeping URL and protocol rules
 * here makes them testable without Android or Capacitor runtime classes.
 */
final class RijiHttpSupport {
    private static final Pattern HTTP_METHOD = Pattern.compile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");
    private static final Pattern HEADER_NAME = Pattern.compile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");
    private static final Pattern CHARSET = Pattern.compile("(?i)(?:^|;)\\s*charset\\s*=\\s*(?:\"([^\"]+)\"|([^;\\s]+))");

    private RijiHttpSupport() {}

    static URI requireHttpUri(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            throw new IllegalArgumentException("url is required");
        }
        if (rawUrl.length() > 8192) {
            throw new IllegalArgumentException("url is too long");
        }

        final URI uri;
        try {
            uri = new URI(rawUrl);
        } catch (URISyntaxException exception) {
            throw new IllegalArgumentException("url is invalid");
        }

        String scheme = uri.getScheme();
        if (scheme == null ||
            !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
            throw new IllegalArgumentException("only http and https urls are supported");
        }
        if (uri.getHost() == null || uri.getHost().isEmpty()) {
            throw new IllegalArgumentException("url host is required");
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("credentials in urls are not allowed");
        }
        return uri;
    }

    static URI resolveRedirect(URI current, String location) {
        if (location == null || location.trim().isEmpty()) {
            throw new IllegalArgumentException("redirect location is missing");
        }
        URI resolved;
        try {
            resolved = current.resolve(new URI(location.trim()));
        } catch (IllegalArgumentException | URISyntaxException exception) {
            throw new IllegalArgumentException("redirect location is invalid");
        }
        return requireHttpUri(resolved.toString());
    }

    static String requireMethod(String rawMethod) {
        String method = rawMethod == null ? "GET" : rawMethod.trim().toUpperCase(Locale.US);
        if (method.isEmpty() || method.length() > 32 || !HTTP_METHOD.matcher(method).matches()) {
            throw new IllegalArgumentException("method is invalid");
        }
        return method;
    }

    static boolean isValidHeaderName(String name) {
        return name != null &&
            !name.isEmpty() &&
            name.length() <= 256 &&
            HEADER_NAME.matcher(name).matches();
    }

    static boolean isValidHeaderValue(String value) {
        return value != null &&
            value.length() <= 16384 &&
            value.indexOf('\r') < 0 &&
            value.indexOf('\n') < 0 &&
            value.indexOf('\0') < 0;
    }

    static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    static String redirectedMethod(int status, String method) {
        if (status == 303 && !"GET".equals(method) && !"HEAD".equals(method)) {
            return "GET";
        }
        if ((status == 301 || status == 302) && "POST".equals(method)) {
            return "GET";
        }
        return method;
    }

    static boolean isSameOrigin(URI left, URI right) {
        return left.getScheme().equalsIgnoreCase(right.getScheme()) &&
            left.getHost().equalsIgnoreCase(right.getHost()) &&
            effectivePort(left) == effectivePort(right);
    }

    static boolean isTlsDowngrade(URI from, URI to) {
        return "https".equalsIgnoreCase(from.getScheme()) && "http".equalsIgnoreCase(to.getScheme());
    }

    static Charset responseCharset(String contentType) {
        if (contentType != null) {
            Matcher matcher = CHARSET.matcher(contentType);
            if (matcher.find()) {
                String name = matcher.group(1) != null ? matcher.group(1) : matcher.group(2);
                try {
                    return Charset.forName(name.trim());
                } catch (IllegalArgumentException ignored) {
                    // An invalid server declaration must not crash the bridge.
                }
            }
        }
        return StandardCharsets.UTF_8;
    }

    static String networkErrorCode(Throwable throwable) {
        if (throwable instanceof SocketTimeoutException) {
            return "TIMEOUT";
        }
        if (throwable instanceof UnknownHostException) {
            return "DNS_ERROR";
        }
        if (throwable instanceof SSLHandshakeException ||
            throwable instanceof SSLPeerUnverifiedException ||
            throwable instanceof SSLException) {
            return "TLS_ERROR";
        }
        if (throwable instanceof ConnectException || throwable instanceof NoRouteToHostException) {
            return "CONNECTION_ERROR";
        }
        return "NETWORK_ERROR";
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }
}
