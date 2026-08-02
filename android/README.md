# 智能家居 Android 客户端

这是一个轻量原生 WebView 客户端，默认加载生产 H5：

`https://home.gezhixin.cn:4430/`

客户端不重复实现空调、电视或摄像头协议，登录、设备权限和功能始终与 Web/H5 保持一致。摄像头实时 MJPEG 画面通过现有 HTTPS 页面加载。

## 构建

在 Android SDK 33 和 Build Tools 33.0.2 环境执行：

```bash
./gradlew assembleDebug
```

生成文件：`app/build/outputs/apk/debug/app-debug.apk`。

正式签名请在本地提供签名配置，不要把 `keystore.properties`、JKS 或 APK 上传到 Git。
