# dsh-notify-on-attention

DSH 插件：在**需要你介入**的时候弹 Windows 系统通知。DSH 工作期间可以切去干别的活。

---

## 什么时候会弹

| 时机 | 事件来源 | 默认 |
|---|---|---|
| 提问等你回答 | `tool/call` 且工具名是 `ask_user_question` | 开 |
| 需要你批准某个操作 | `approval/asked` | 开 |
| 一轮对话正常跑完 | `turn/end` 且 `reason.kind === 'completed'` | 开 |

**不会弹的情况**

- 用户按了停止键（`turn/end` 的 `reason.kind` 是 `aborted`）
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

### 自动化烟测

```powershell
npm test
```

不需要装任何依赖（没有测试框架，直接 `node` 跑），clone 下来即可验证。

烟测刻意**不弹真实通知**——那需要有人坐在电脑前看，没法自动化，也不该在 CI 机器上乱弹。它断言的是「该弹的时候发出了发送调用、不该弹的时候一次都没发」：

| 覆盖点 | 断言内容 |
|---|---|
| 配置解析 | 缺文件/坏 JSON/顶层非对象/未知键/类型不符，一律退回默认值且不抛异常 |
| 事件翻译 | 三类事件各自触发、`approval/decided` 与 `aborted` 不触发、普通工具调用不触发 |
| 节流 | 同类通知在 `minIntervalMs` 内只发一条，且**不同类别互不压制** |
| 开关 | `enabled` 与三个单项开关各管各的 |
| 卸载 | 插件停用后事件不再进来 |
| 编码约定 | 脚本确实按 UTF-16LE + Base64 走 `-EncodedCommand`、`SHOWN` 标记存在、XML 特殊字符被转义 |

为了能测这些，`lib/` 做了三处**不改变行为**的改动：`config.js` 拆出 `mergeConfig()`（喂对象比落盘造文件好测）、`listeners.js` 的 `installListeners()` 接受可注入的发送函数、`toast.js` 拆出 `buildCommandArgs()`/`decodeCommandArgs()`、`index.js` 追加 `export const plugin = { name, apply }`。默认参数与运行时行为完全不变。

一次改动的真实验证记录：把 `listeners.js` 里 `if (kind !== 'completed') return` 改成恒 false，烟测立刻红在「用户自己按的停止键不该再提醒」；把 `config.js` 的 `config[key] = value` 改回 `config[key] = DEFAULT_CONFIG[key]`，立刻红在「合法键应生效」。说明这些断言不是摆设。

---

## 已知限制

- **只有 Windows 能用**。非 Windows 平台上插件会记一条 info 日志后不做事。
- **通知来源显示为 Windows PowerShell**。因为借用了它的 AUMID，而没有注册独立的应用身份。要显示成「DSH」需要往注册表写 `HKCU\Software\Classes\AppUserModelId`，本插件刻意不这么做，卸载后不留痕迹比图标好看更重要。
- `suppressWhenForeground` 目前是保留项。真要做需要调 `GetForegroundWindow` 比对 DSH 窗口句柄，每次事件一次跨进程调用，收益不值这个代价。
- 通知内容不包含会话的完整历史，只有标题 + 一句摘要。想更详细的信息请回到 DSH 看。

---

## 关于作者与 AI 协作

这个插件的代码由 AI 助手（Claude / DeepSeek-Harness）在人类需求驱动下写成，人类负责定方向、验收与拍板。写在这里不是免责声明，是因为它对使用者的判断有意义：

**值得信任的部分**

- 三个「踩过的坑」不是编的——`powershell.exe` 5.1 与 `pwsh` 7 的 WinRT 投影差异、借用 PowerShell AUMID 不写注册表、XML 用单引号拼而非 `JSON.stringify`，都是实际跑出来的报错，代码注释里写了失败现象和原因，你可以自己复现验证。
- 「不弹的情况」是刻意设计的判断（`aborted` 是用户自己按的停止键、`approval/decided` 是刚做完的决定），不是漏实现。
- `npm test` 的 21 项断言都是有意义的，且做过破坏性验证（见上节）。

**需要你自己把关的部分**

- 事件契约来自对 app.asar 类型声明的阅读，不是官方文档。DSH 升版后若事件载荷变了，插件会**静默不弹**而不是报错——因为所有失败路径都只记日志。留意日志里的 `[notify]`。
- 权限面：插件会 `spawn('powershell.exe', ...)`。虽然是固定参数（脚本内容由本插件生成，用户文本只进 XML 文本节点且已转义），但如果你对「插件能起进程」这件事本身有顾虑，这个判断该由你来做。
- 没有在干净环境里做过完整回归。你的机器就是第一个真实测试环境。

---

## 许可证

[MIT](LICENSE) © 2026 Eidokage
