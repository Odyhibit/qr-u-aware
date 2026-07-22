package com.odyhibit.qruaware;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeBarcodeDetectorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
