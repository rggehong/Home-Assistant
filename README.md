# 格力空调局域网控制服务

在 `192.168.0.146` 上运行的本地 HTTP API，通过格力 Wi-Fi 模块的 UDP
局域网协议发现、绑定并控制空调，不依赖格力云服务。

## 功能

- 自动发现并绑定格力空调
- 查询开关、模式、温度、风速和扫风状态
- 控制开关、模式、0.5℃ 目标温度、风速、扫风、灯光、静音、睡眠和定时任务
- KFR-35GW（型号 ID `10014`）：防直吹、强劲风、健康、辅热
- KFR-72LW（型号 ID `110007e000019`）：强劲风、健康、独立下出风
- 索尼 BRAVIA 电视：实体遥控器式 Web/H5 界面，支持开关机、方向/确认、
  返回、主页、电视、输入、设置、选项、菜单、音量、静音和 HDMI 直达切换
- 格力空调和索尼电视均支持由 146 服务器持久化执行定时开关机
- Web/H5 家庭访问密码登录，使用安全 Cookie 保持登录 30 天
- Bearer Token / `X-API-Token` 鉴权继续供自动化 API 调用
- Swagger API 文档：`http://192.168.0.146:8765/docs`
- Web 控制台：`https://home.gezhixin.cn:4430`

## 安装

```bash
cd /opt/gree-ac-control
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp config.example.env .env
```

编辑 `.env`，设置随机 API Token。空调必须已通过格力+或对应厂商 App
接入与服务器相同的 Wi-Fi 网络。

索尼电视通过局域网 REST API 接入。请在电视的 IP 控制设置中启用预共享密钥和
简易 IP 控制，并仅在服务器 `.env` 中设置 `SONY_TV_PSK`。

建议同时设置 `GREE_WEB_PASSWORD` 作为网页端更易输入的家庭访问密码，并设置独立随机
`GREE_SESSION_SECRET`。如果没有设置 `GREE_WEB_PASSWORD`，网页首次登录会兼容使用
`GREE_API_TOKEN`，成功后由 HttpOnly Cookie 保持登录 30 天，浏览器不再保存 Token。

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
- `anti_direct`：卧室机型的向上避人预设；开启时将上下导风板固定向上
- `turbo`：强劲风
- `health`：健康模式
- `auxiliary_heat`：辅热（仅卧室机型）
- `lower_outlet`：独立下出风（仅客厅机型，不影响上下扫风）

首次联调建议只调用设备列表接口。确认状态读取正确后，再发送控制命令。
