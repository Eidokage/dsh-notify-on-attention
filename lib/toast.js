/**
 * Windows 系统通知的发送层。
 *
 * 这里只做一件事：把「标题 + 正文」变成一条右下角弹出的 Toast。
 *
 * 三个必须知道的约束（都是实测出来的，不是猜的）：
 *
 * 1. 必须用 powershell.exe（Windows PowerShell 5.1），不能用 pwsh（PowerShell 7）。
 *    pwsh 7 默认不带 WinRT 投影，加载 `Windows.UI.Notifications` 会直接报
 *    "找不到类型"。5.1 自带这层投影，实测可用。
 *
 * 2. Toast 必须挂在一个已注册的 AppUserModelID（AUMID）下，否则 Windows 会
 *    静默丢弃。这里借 Windows PowerShell 自己的 AUMID，好处是不用往注册表里
 *    写任何东西——插件卸载后系统里不留痕迹。
 *
 * 3. XML 必须用单行字符串拼出来再 LoadXml。用 PowerShell here-string（@'...'@）
 *    会因为缩进/换行掺进 XML 而解析失败，报错还很难读。
 *
 * 所有失败都只记录日志、返回 false，绝不向上抛——通知发不出去不能影响对话本身。
 */

import { spawn } from 'node:child_process'

/** Windows PowerShell 自己的 AUMID，用它就不必注册自己的通知应用身份。 */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 单条 Toast 最多等这么久就放弃，避免僵尸进程堆积。 */
const SEND_TIMEOUT_MS = 8000

/**
 * 把文本转义成可安全嵌入 XML 的形式。
 * 通知文案里可能出现角色名、文件路径里的 & < >，不转义会让 LoadXml 直接失败。
 */
function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 构造发送 Toast 的 PowerShell 脚本。
 *
 * @param {string} title 通知标题（第一行，加粗）
 * @param {string} body  通知正文（第二行）
 * @param {boolean} silent 是否静音（不放提示音）
 * @returns {string} 可直接交给 powershell.exe -EncodedCommand 的脚本
 */
function buildScript(title, body, silent) {
  const xml = [
    '<toast duration="short">',
    '<visual><binding template="ToastGeneric">',
    '<text>', escapeXml(title), '</text>',
    '<text>', escapeXml(body), '</text>',
    '</binding></visual>',
    silent ? '<audio silent="true"/>' : '',
    '</toast>',
  ].join('')

  // 必须嵌进 PowerShell 的**单引号**字符串里。
  // 用 JSON.stringify 会生成双引号包裹且把内部的 " 转义成 \"，
  // 而 PowerShell 的双引号字符串里 \" 不是转义——它直接把字符串截断，
  // 于是报「表达式或语句中包含意外的标记 'short">'」。
  // 单引号字符串里只有 ' 需要处理，规则简单得多。
  //
  // XML 里的 ' 已经在 escapeXml 中转成 &apos;，所以这里正常不该出现 '；
  // 仍然兜一层，避免将来改 escapeXml 时这里静默崩掉。
  const xmlLiteral = `'${xml.replace(/'/g, "''")}'`

  return `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xmlText = ${xmlLiteral}
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}').Show($toast)
Write-Output 'SHOWN'
`
}

/**
 * 发一条 Windows 系统通知。
 *
 * @param {{ title: string, body: string, silent?: boolean, logger?: any }} options
 * @returns {Promise<boolean>} 是否成功弹出（失败不抛异常）
 */
export function showToast({ title, body, silent = false, logger }) {
  return new Promise((resolve) => {
    // 非 Windows 平台直接跳过：这个插件本来就是为 Windows 写的，
    // 在别的系统上静默不做事，比抛错更合适。
    if (process.platform !== 'win32') {
      resolve(false)
      return
    }

    const script = buildScript(title, body, silent)
    // -EncodedCommand 接 Base64(UTF-16LE)，可以彻底绕开命令行引号转义问题。
    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      logger?.warn?.(`[notify] 启动 powershell.exe 失败：${error instanceof Error ? error.message : String(error)}`)
      resolve(false)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }

    const timer = setTimeout(() => {
      // 超时就杀掉，避免通知进程挂住拖累 DSH。
      try {
        child.kill()
      } catch {
        /* 已经退出了，忽略 */
      }
      logger?.warn?.('[notify] 发送系统通知超时，已放弃这一条。')
      finish(false)
    }, SEND_TIMEOUT_MS)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      logger?.warn?.(`[notify] 通知进程出错：${error.message}`)
      finish(false)
    })

    child.on('close', (code) => {
      const showed = stdout.includes('SHOWN')
      if (!showed) {
        // 只在真的失败时记一条 warn。系统禁用通知属于预期内的降级，不值得刷屏。
        const detail = stderr.trim().split('\n').slice(0, 2).join(' / ')
        logger?.warn?.(`[notify] 系统通知未弹出（退出码 ${code}）${detail ? `：${detail}` : ''}`)
      }
      finish(showed)
    })
  })
}

/**
 * 检测当前环境能否发系统通知。
 * 用于插件启动时给出一次性的明确提示，而不是让用户对着「没反应」猜。
 */
export function canNotify() {
  return process.platform === 'win32'
}
