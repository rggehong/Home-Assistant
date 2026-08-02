# 索尼电视无线调试守护

该 APK 安装在索尼 Android TV 上，用于在开机后后台保持“无线调试”启用。它不会打开设置页面，也不会保存 ADB 配对码、密钥或家庭账号。

## 工作方式

- 响应 `LOCKED_BOOT_COMPLETED`、`BOOT_COMPLETED` 和应用升级事件。
- 立即设置 `adb_enabled=1` 与 `adb_wifi_enabled=1`。
- Wi-Fi 可用后再次检查，并每 15 分钟做一次低开销兜底检查。
- 146 服务器仍通过 ADB mDNS 自动发现电视的动态端口。

## 构建

```bash
./gradlew assembleDebug
```

## 一次性安装

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant cn.gezhixin.smarthome.tvagent android.permission.WRITE_SECURE_SETTINGS
adb shell am start -n cn.gezhixin.smarthome.tvagent/.AgentActivity
```

电视恢复出厂设置或卸载本应用后，需要重新安装并授予权限。
