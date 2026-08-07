# 家庭智能设备控制服务

在 `192.168.0.146` 上运行的智能家居 Web/H5 与 HTTP API。格力空调、
索尼电视、奥普浴霸和米家插座优先使用局域网控制；A.O.史密斯净水机通过
AI‑LiNK 官方云服务授权接入；燃气热水器当前通过华为智慧生活管理。

## 功能

- 自动发现并绑定格力空调
- 查询开关、模式、温度、风速和扫风状态
- 控制开关、模式、0.5℃ 目标温度、风速、扫风、灯光、静音、睡眠和定时任务
- KFR-35GW（型号 ID `10014`）：防直吹、强劲风、健康、辅热
- KFR-72LW（型号 ID `110007e000019`）：强劲风、健康、独立下出风
- 索尼 BRAVIA 电视：实体遥控器式 Web/H5 界面，支持开关机、方向/确认、
  返回、主页、电视、输入、设置、选项、菜单、音量、静音和 HDMI 直达切换
- 格力空调和索尼电视均支持由 146 服务器持久化执行定时开关机
- 奥普 Q360A-Pro 浴霸和米家智能插座 3：扫码绑定米家后本地控制
- 欧普照明：局域网开关、亮度和色温调节
- 天猫精灵：独立页面显示 `192.168.0.113`、`192.168.0.135` 的在线状态
- AliGenie 云云技能网关：通过标准 OAuth2 将格力空调、米家插座和欧普照明
  发布给天猫精灵，实现语音开关、温度、模式和亮度控制
- 追觅 X30：独立 Web/H5 控制页面，支持清扫、暂停、停止、回充、寻找设备、
  一键集尘、清洗/烘干拖布、吸力、清洁模式、拖布湿度和清洗强度
- 追觅 X30 基站与智能设置：断点续扫、地毯增压、智能避障、童锁、勿扰、
  自动补水、自动加清洁液、自动集尘、智能洗拖布和静音烘干；页面仅显示
  实机协议确认支持的字段，并显示耗材、水箱和基站状态
- A.O.史密斯 DR1600HF2 净水机：手机号、腾讯安全验证和短信验证码完成
  一次性 AI‑LiNK 授权；凭据以 `0600` 权限保存在服务器数据目录
- A.O.史密斯 JSQ31-VJSAi 燃气热水器：识别 `192.168.0.108` 的局域网
  在线状态，并单独显示华为智慧生活云授权状态；设备未开放局域网控制端口，
  未取得华为云授权前不显示无效的开关和温度控件
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

AliGenie 开放平台创建“智能家居”标准技能后，填写以下地址：

- 账户授权连接：`https://home.gezhixin.cn:4430/aligenie/oauth/authorize`
- Access Token URL：`https://home.gezhixin.cn:4430/aligenie/oauth/token`
- 开发者网关：`https://home.gezhixin.cn:4430/aligenie/gateway`
- Client ID / Client Secret：来自服务器 `.env` 中的 `ALIGENIE_CLIENT_ID` 和
  `ALIGENIE_CLIENT_SECRET`

用户在天猫精灵 App 中绑定技能时，授权页使用家庭访问密码确认，不需要向阿里提供
家庭密码或设备密钥。

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

## 迭代记录

### 2026-08-08：好太太智能晾衣机

- 接入 `192.168.0.107`（`40:2A:8F:56:45:28`）对应的好太太云端设备，支持升、降、停、照明与除菌。
- Web/H5 增加独立控制页、最佳收衣点和行程校准；未校准时禁止自动定位。
- 授权密码只在登录请求期间使用，服务器仅将令牌保存到 Git 忽略的 `data/hotata.json`。
- 协议适配参考 [C3H3-AI/ha-hotata-airer](https://github.com/C3H3-AI/ha-hotata-airer)（CC BY-NC 4.0），本项目为非商业家庭使用并已作修改。

### 2026-07-31：追觅 X30 完整控制与设备拆页

- 修复 Dreamehome 命令请求 ID 导致的偶发离线问题，增加刷新令牌续期和请求重试。
- 根据 X30 实机协议探测结果接入 51 个可读取能力，补充清洁、基站、智能设置、
  水箱状态和耗材余量。
- 增加 `/api/dreame/setting`，并扩展基站动作接口；所有设置都进行型号能力检查
  和值域校验。
- 天猫精灵与追觅扫地机器人拆分为两个独立界面，Web/H5 功能保持一致。
- 追觅摄像头仍使用 Dreamehome 的加密视频通道，网页不伪造不可用的实时画面。

### 2026-07-30：照明、米家和云端设备接入

- 接入欧普照明局域网控制，并增加亮度、色温和开关状态同步。
- 增加天猫精灵局域网在线监测，保留后续阿里云开发者授权控制入口。
- 接入奥普 Q360A-Pro 浴霸和米家智能插座 3，采用米家扫码授权，避免保存账号密码。
- 增加史密斯 DR1600HF2 净水机 AI‑LiNK 授权流程，以及 JSQ31-VJSAi
  燃气热水器的局域网识别和华为智慧生活授权状态页。

### 2026-07-29：电视、空调和统一界面

- 完成三台格力空调的型号差异化控制：0.5℃ 温度步进、扫风/定格、睡眠、
  防直吹、强劲、健康、辅热和客厅独立下出风。
- Web 与 H5 改为即时生效控制，并按设备能力隐藏无关字段。
- 接入索尼 BRAVIA 电视，制作实体遥控器式面板、快捷应用、前台应用识别、
  截图、一键清理和电视定时开关机。
- 将空调与电视定时任务统一到一个任务页面，并完善家庭访问密码与安全 Cookie 登录。
