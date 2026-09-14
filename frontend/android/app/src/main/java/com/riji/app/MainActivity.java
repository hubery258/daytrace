package com.riji.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // BridgeActivity creates its Bridge from this builder in super.onCreate().
        // Register local plugins first or the JavaScript bridge cannot discover them.
        registerPlugin(RijiSecureStoragePlugin.class);
        registerPlugin(RijiHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
