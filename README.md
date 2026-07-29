# 格力空调局域网控制服务

在 `192.168.0.146` 上运行的本地 HTTP API，通过格力 Wi-Fi 模块的 UDP
局域网协议发现、绑定并控制空调，不依赖格力云服务。

## 功能

- 自动发现并绑定格力空调
- 查询开关、模式、温度、风速和扫风状态
- 控制开关、模式、目标温度、风速、扫风、灯光、静音和强力模式
- Bearer Token / `X-API-Token` 鉴权
- Swagger API 文档：`http://192.168.0.146:8765/docs`

## 安装

```bash
cd /opt/gree-ac-control
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp config.example.env .env
```

编辑 `.env`，设置随机 API Token。空调必须已通过格力+或对应厂商 App
接入与服务器相同的 Wi-Fi 网络。

```bash
sudo cp systemd/gree-ac-control.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gree-ac-control
```

## 调用示例

```bash
TOKEN='请从服务器上的 /opt/gree-ac-control/.env 读取'

curl -H "Authorization: Bearer $TOKEN" \
  http://192.168.0.146:8765/api/devices

curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"power":true,"mode":"cool","target_temperature":26,"fan_speed":"auto"}' \
  http://192.168.0.146:8765/api/devices/设备ID/command
```

控制字段：

- `mode`: `auto`、`cool`、`dry`、`fan`、`heat`
- `fan_speed`: `auto`、`low`、`medium_low`、`medium`、`medium_high`、`high`
- `vertical_swing`: `default`、`full`、`upper`、`upper_middle`、`middle`、`lower_middle`、`lower`
- `horizontal_swing`: `default`、`full`、`left`、`left_center`、`center`、`right_center`、`right`

首次联调建议只调用设备列表接口。确认状态读取正确后，再发送控制命令。

