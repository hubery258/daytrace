package com.riji.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public final class RijiHttpRawExchangeTest {
    private static Map<String, List<String>> headers(String... pairs) {
        Map<String, List<String>> map = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            map.put(pairs[index], Collections.singletonList(pairs[index + 1]));
        }
        return map;
    }

    private static InputStream stream(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.ISO_8859_1));
    }

    @Test
    public void onlyNonPermittedMethodsUseTheRawTransport() {
        assertTrue(RijiHttpRawExchange.requiresRawTransport("PROPFIND"));
        assertTrue(RijiHttpRawExchange.requiresRawTransport("MKCOL"));
        assertTrue(RijiHttpRawExchange.requiresRawTransport("proppatch"));
        assertFalse(RijiHttpRawExchange.requiresRawTransport("GET"));
        assertFalse(RijiHttpRawExchange.requiresRawTransport("PUT"));
        assertFalse(RijiHttpRawExchange.requiresRawTransport("HEAD"));
        assertFalse(RijiHttpRawExchange.requiresRawTransport("DELETE"));
        assertFalse(RijiHttpRawExchange.requiresRawTransport(null));
    }

    @Test
    public void buildsARequestHeadWithoutLeakingAnythingItWasNotGiven() {
        String head = RijiHttpRawExchange.buildRequestHead(
            "PROPFIND",
            URI.create("https://dav.example.com/remote.php/dav/files/alice/daytrace/?depth=0"),
            headers("Depth", "0", "Authorization", "Basic c2VjcmV0"),
            128
        );

        assertTrue(head.startsWith("PROPFIND /remote.php/dav/files/alice/daytrace/?depth=0 HTTP/1.1\r\n"));
        assertTrue(head.contains("Host: dav.example.com\r\n"));
        assertTrue(head.contains("Depth: 0\r\n"));
        assertTrue(head.contains("Content-Length: 128\r\n"));
        assertTrue(head.endsWith("\r\n\r\n"));
        // Managed framing headers are rewritten by this class.
        String rewritten = RijiHttpRawExchange.buildRequestHead(
            "PUT",
            URI.create("http://dav.example.com/daytrace/daytrace-latest.json"),
            headers("Content-Length", "999", "Host", "evil.example.com"),
            12
        );
        assertTrue(rewritten.contains("Host: dav.example.com\r\n"));
        assertTrue(rewritten.contains("Content-Length: 12\r\n"));
        assertFalse(rewritten.contains("999"));
        assertFalse(rewritten.contains("evil.example.com"));
    }

    @Test
    public void parsesAContentLengthResponse() throws IOException {
        RijiHttpRawExchange.Result result = RijiHttpRawExchange.parseResponse(
            stream("HTTP/1.1 207 Multi-Status\r\nETag: \"abc\"\r\nContent-Length: 5\r\n\r\nhello"),
            1024
        );
        assertEquals(207, result.status);
        assertEquals("hello", new String(result.body, StandardCharsets.UTF_8));
        assertEquals("\"abc\"", RijiHttpRawExchange.headerValue(result.headers, "etag"));
    }

    @Test
    public void parsesAChunkedResponse() throws IOException {
        String response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
            + "5\r\nhello\r\n"
            + "6\r\n world\r\n"
            + "0\r\n\r\n";
        RijiHttpRawExchange.Result result = RijiHttpRawExchange.parseResponse(stream(response), 1024);
        assertEquals(200, result.status);
        assertEquals("hello world", new String(result.body, StandardCharsets.UTF_8));
    }

    @Test
    public void rejectsOversizedResponses() {
        assertThrows(RijiHttpRawExchange.TooLargeException.class, () -> RijiHttpRawExchange.parseResponse(
            stream("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n"),
            64
        ));
        assertThrows(RijiHttpRawExchange.TooLargeException.class, () -> RijiHttpRawExchange.parseResponse(
            stream("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n40\r\n" + "x".repeat(64) + "\r\n0\r\n\r\n"),
            32
        ));
    }

    @Test
    public void rejectsMalformedResponses() {
        assertThrows(IOException.class, () -> RijiHttpRawExchange.parseResponse(stream(""), 64));
        assertThrows(IOException.class, () -> RijiHttpRawExchange.parseResponse(stream("garbage\r\n\r\n"), 64));
        assertThrows(IOException.class, () -> RijiHttpRawExchange.parseResponse(
            stream("HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\n"), 64));
    }

    @Test
    public void performsAPropfindRequestAgainstALocalServer() throws Exception {
        AtomicReference<String> received = new AtomicReference<>();
        try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            Thread responder = new Thread(() -> {
                try (Socket socket = server.accept()) {
                    InputStream input = socket.getInputStream();
                    StringBuilder request = new StringBuilder();
                    int value;
                    while ((value = input.read()) != -1) {
                        request.append((char) value);
                        if (request.length() >= 4 && request.substring(request.length() - 4).equals("\r\n\r\n")) {
                            break;
                        }
                    }
                    received.set(request.toString());
                    String body = "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"/>";
                    OutputStream output = socket.getOutputStream();
                    output.write(("HTTP/1.1 207 Multi-Status\r\n"
                        + "Content-Type: application/xml\r\n"
                        + "ETag: \"v1\"\r\n"
                        + "Content-Length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n\r\n"
                        + body).getBytes(StandardCharsets.UTF_8));
                    output.flush();
                } catch (IOException ignored) {
                    // The assertion below reports the failure.
                }
            });
            responder.start();

            URI uri = URI.create("http://127.0.0.1:" + server.getLocalPort() + "/dav/daytrace");
            Map<String, List<String>> requestHeaders = new LinkedHashMap<>();
            requestHeaders.put("Depth", new ArrayList<>(Collections.singletonList("0")));
            requestHeaders.put("Authorization", new ArrayList<>(Collections.singletonList("Basic dGVzdA==")));
            RijiHttpRawExchange.Result result = RijiHttpRawExchange.execute(
                uri.toString(),
                "PROPFIND",
                requestHeaders,
                "<d:propfind/>".getBytes(StandardCharsets.UTF_8),
                2000,
                2000,
                4096
            );
            responder.join(4000);

            assertEquals(207, result.status);
            assertEquals("\"v1\"", RijiHttpRawExchange.headerValue(result.headers, "ETag"));
            assertTrue(new String(result.body, StandardCharsets.UTF_8).contains("multistatus"));
            assertNotNull(received.get());
            assertTrue(received.get().startsWith("PROPFIND /dav/daytrace HTTP/1.1"));
            assertTrue(received.get().contains("Depth: 0"));
            assertTrue(received.get().contains("Authorization: Basic dGVzdA=="));
            assertTrue(received.get().contains("Content-Length: 13"));
        }
    }

    @Test
    public void reportsConnectionFailuresAsIoErrors() {
        // Port 1 on loopback is not listening in a unit test environment.
        assertThrows(IOException.class, () -> RijiHttpRawExchange.execute(
            "http://127.0.0.1:1/dav",
            "MKCOL",
            headers(),
            new byte[0],
            500,
            500,
            1024
        ));
    }

    @Test
    public void rejectsNonHttpUrls() {
        assertThrows(IllegalArgumentException.class, () -> RijiHttpRawExchange.execute(
            "file:///etc/passwd",
            "PROPFIND",
            headers(),
            null,
            100,
            100,
            1024
        ));
    }

    @Test
    public void headerLookupIsCaseInsensitive() {
        Map<String, List<String>> map = headers("ETag", "\"x\"", "Content-Length", "3");
        assertEquals("\"x\"", RijiHttpRawExchange.headerValue(map, "etag"));
        assertEquals("3", RijiHttpRawExchange.headerValue(map, "CONTENT-LENGTH"));
        assertEquals(null, RijiHttpRawExchange.headerValue(map, "missing"));
        assertEquals(null, RijiHttpRawExchange.headerValue(null, "etag"));
        assertEquals(Collections.singletonList("b"), headers("a", "b").get("a"));
    }
}
