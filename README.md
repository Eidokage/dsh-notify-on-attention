# dsh-notify-on-attention

DSH 插件：在**需要你介入**的时候弹 Windows 系统通知。DSH 工作期间可以切去干别的活。

---

## 什么时候会弹

| 时机 | 事件来源 | 默认 |
|---|---|---|
| 提问等你回答 | `tool/call` 且工具名是 `ask_user_question` | 开 |
| 需要你批准某个操作 | `approval/asked` | 开 |
| 一轮对话正常跑完 | `turn/end` 且 `reason.kind === 'completed'` | 开 |

**不会弹的情况（故意的）**

- 你自己按了停止键（`turn/end` 的 `reason.kind` 是 `aborted`）
- 审批结果出来时（`approval/decided`）
- 普通工具调用（读文件、跑命令等）

---

## 配置

配置文件：`C:\Users\<你>\.dsh\notify-on-attention.json`

**这个文件不存在也能正常工作**，不存在就用下面的默认值。

```json
{
  "enabled": true,
  "notifyOnQuestion": true,
  "notifyOnApproval": true,
  "notifyOnTurnEnd": true,
  "playSound": true,
  "suppressWhenForeground": false,
  "minIntervalMs": 4000
}
```

| 键 | 作用 |
|---|---|
| `enabled` | 总开关，`false` 时下面三项全部失效 |
| `notifyOnQuestion` | 代理提问时提醒 |
| `notifyOnApproval` | 需要审批时提醒 |
| `notifyOnTurnEnd` | 一轮对话完成时提醒 |
| `playSound` | 是否播放系统提示音 |
| `suppressWhenForeground` | 目前是保留项，实际未生效（判断前台窗口代价较大，默认不做） |
| `minIntervalMs` | 同类通知的最小间隔，用来防轰炸。一次审批连带触发多条时只会弹第一条 |

配置写坏了不会炸插件：JSON 不合法、类型不对、键名拼错，都会记一条 `warn` 日志后退回默认值。

也可以用环境变量 `DSH_NOTIFY_CONFIG` 把配置文件指到别处。

---

## 工作原理

`ctx.on('session/event', handler, { global: true })` —— `{ global: true }` 让**所有**会话的事件都进来，而不只是当前聚焦的那个。这是「切走也能被提醒」的前提。

拿到事件后按 `event.type` 分发，载荷在 `event.data`。

发送通知走 PowerShell：

```
powershell.exe -NoProfile -NonInteractive -EncodedCommand <Base64(UTF-16LE 脚本)>
```

脚本用 `.NET` 的 WinRT 投影调 `Windows.UI.Notifications.ToastNotificationManager`。

### 注意事项（都有注释）

1. **必须用 `powershell.exe`（5.1），不能用 `pwsh`（7）**
   pwsh 7 默认不带 WinRT 投影，加载 `Windows.UI.Notifications` 会报「找不到类型」。

2. **Toast 必须挂在已注册的 AppUserModelID 下**
   借用 Windows PowerShell 自己的 AUMID，好处是**不用往注册表写任何东西**，卸载后系统里不留痕迹。

3. **XML 要用单引号拼进 PowerShell，不能用 `JSON.stringify`**
   后者生成双引号包裹的字符串并把内部 `"` 转义成 `\"`，而 PowerShell 双引号字符串里 `\"` 不是转义，直接把字符串截断，报「表达式或语句中包含意外的标记」。

---

## 安装 / 卸载

```powershell
# 安装
dsh plugin --profile desktop add "D:\workspace\dsh-notify-on-attention"

# 查看
dsh plugin --profile desktop list

# 卸载
dsh plugin --profile desktop remove dsh-notify-on-attention
```

装完/改完配置都要**重启 DSH** 才生效。

`package.json` 里的 `dsh.bundle.patch` 和 `cordis.patch.yml` 是必须的。没有它们，DSH 会把插件当普通依赖装进来（会警告 `declares no dsh.bundle`），**代码根本不会被加载**。

---

## 验证方式

本插件装好后，让 DSH 做一件事即可自然触发：
- 让它问你一个问题 → 弹「DSH 在等你回答」
- 让它跑一个需要审批的命令 → 弹「DSH 需要你批准」
- 让它正常答完一轮 → 弹「DSH 这一轮完成了」

如果三条都没弹：先在 `C:\Users\Fox\.dsh\profiles\desktop` 的日志里搜 `[notify]`，看是配置关掉了、还是系统通知被禁用了。

---

## 已知限制

- **只有 Windows 能用**。非 Windows 平台上插件会记一条 info 日志后不做事。
- **通知来源显示为 Windows PowerShell**。因为借用了它的 AUMID，而没有注册独立的应用身份。要显示成「DSH」需要往注册表写 `HKCU\Software\Classes\AppUserModelId`，本插件刻意不这么做，卸载后不留痕迹比图标好看更重要。
- `suppressWhenForeground` 目前是保留项。真要做需要调 `GetForegroundWindow` 比对 DSH 窗口句柄，每次事件一次跨进程调用，收益不值这个代价。
- 通知内容不包含会话的完整历史，只有标题 + 一句摘要。想更详细的信息请回到 DSH 看。
