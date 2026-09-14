package com.riji.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.SSLHandshakeException;
import org.junit.Test;

public final class RijiHttpSupportTest {
    @Test
    public void acceptsHttpAndHttpsButRejectsCredentialsAndOtherSchemes() {
        assertEquals("https", RijiHttpSupport.requireHttpUri("https://example.com/v1").getScheme());
        assertEquals("http", RijiHttpSupport.requireHttpUri("http://calendar.celechron.top/api").getScheme());
        assertThrows(IllegalArgumentException.class, () -> RijiHttpSupport.requireHttpUri("file:///tmp/a"));
        assertThrows(IllegalArgumentException.class, () -> RijiHttpSupport.requireHttpUri("https://user:secret@example.com"));
    }

    @Test
    public void redirectRulesProtectAuthorizationAndTls() {
        URI secure = URI.create("https://example.com/a");
        URI sameOrigin = URI.create("https://example.com/b");
        URI differentPort = URI.create("https://example.com:444/b");
        URI cleartext = URI.create("http://example.com/b");

        assertTrue(RijiHttpSupport.isSameOrigin(secure, sameOrigin));
        assertFalse(RijiHttpSupport.isSameOrigin(secure, differentPort));
        assertTrue(RijiHttpSupport.isTlsDowngrade(secure, cleartext));
        assertEquals("GET", RijiHttpSupport.redirectedMethod(303, "POST"));
        assertEquals("POST", RijiHttpSupport.redirectedMethod(307, "POST"));
    }

    @Test
    public void classifiesNetworkFailuresWithoutExposingProviderMessages() {
        assertEquals("TIMEOUT", RijiHttpSupport.networkErrorCode(new SocketTimeoutException("secret")));
        assertEquals("DNS_ERROR", RijiHttpSupport.networkErrorCode(new UnknownHostException("secret")));
        assertEquals("TLS_ERROR", RijiHttpSupport.networkErrorCode(new SSLHandshakeException("secret")));
    }

    @Test
    public void parsesResponseCharsetWithSafeUtf8Fallback() {
        assertEquals(StandardCharsets.UTF_8, RijiHttpSupport.responseCharset("application/json"));
        assertEquals("UTF-16", RijiHttpSupport.responseCharset("text/plain; charset=UTF-16").name());
        assertEquals(StandardCharsets.UTF_8, RijiHttpSupport.responseCharset("text/plain; charset=not-a-charset"));
    }
}
