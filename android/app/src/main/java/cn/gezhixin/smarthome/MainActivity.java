package cn.gezhixin.smarthome;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final String HOME_URL = "https://home.gezhixin.cn:4430/";

    private WebView webView;
    private TextView errorView;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(245, 245, 245));
        getWindow().setNavigationBarColor(Color.rgb(245, 245, 245));

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        errorView = new TextView(this);
        errorView.setText("网络连接失败\n点击重新加载");
        errorView.setTextColor(Color.rgb(70, 90, 78));
        errorView.setTextSize(15);
        errorView.setGravity(17);
        errorView.setBackgroundColor(Color.rgb(245, 245, 245));
        errorView.setVisibility(View.GONE);
        errorView.setOnClickListener(v -> loadHome());

        ProgressBar progress = new ProgressBar(this);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(48, 48);
        progressParams.gravity = 17;

        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        root.addView(errorView, new FrameLayout.LayoutParams(-1, -1));
        root.addView(progress, progressParams);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + " SmartHomeAndroid/1.0");

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                errorView.setVisibility(View.GONE);
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    progress.setVisibility(View.GONE);
                    errorView.setVisibility(View.VISIBLE);
                }
            }
        });
        loadHome();
    }

    private void loadHome() {
        errorView.setVisibility(View.GONE);
        webView.loadUrl(HOME_URL);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
