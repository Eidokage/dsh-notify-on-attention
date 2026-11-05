/**
 * 事件监听与通知派发。
 *
 * 这里把 DSH 的三个真实事件翻译成三条用户看得懂的通知。
 *
 * 事件契约（从 app.asar 里读到的类型声明，不是猜的）：
 *
 *   ctx.on('session/event', (session, event) => {...})
 *
 *   event.type === 'approval/asked'  载荷 { id, toolName, callId?, reason? }
 *   event.type === 'approval/decided' 载荷 { id, outcome }
 *   event.type === 'turn/end'        载荷 { turn, reason }
 *
 * turn/end 的 reason 是个判别联合：
 *   { kind: 'completed' }          —— 正常跑完
 *   { kind: 'aborted', reason }    —— 用户按了停止
 *   { kind: 'blocked', ... }       —— 被卡住
 * 只有 completed 值得提醒；aborted 是用户自己干的事，再提醒就是打扰。
 *
 * 关于「代理提问」：DSH 的事件清单里没有专门的 question 事件，
 * 代理向用户提问是通过调用 ask_user_question 工具实现的，
 * 一次工具调用会先落一条 tool/call（type / name），所以这里监听 tool/call
 * 并判断工具名，作为「代理正在等你回答」的信号。
 */

import { showToast } from './toast.js'

/** 代理向用户提问的工具名。命中即视为「在等你的回答」。 */
const QUESTION_TOOL_NAMES = new Set(['ask_user_question', 'askuserquestion'])

/**
 * 判断 tool/call 事件是不是一次用户提问。
 *
 * tool/call 的载荷里工具名可能在 name，也可能在 tool / toolName，
 * 这里都看一眼，避免因为 DSH 版本差异漏判。
 */
function questionToolName(event) {
  const data = event?.data ?? {}
  const candidates = [data.name, data.toolName, data.tool?.name, data.tool]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && QUESTION_TOOL_NAMES.has(candidate.toLowerCase())) {
      return candidate
    }
  }
  return ''
}

/**
 * 从工具调用里尽力取出一句像人话的摘要，用做通知正文。
 * 取不到就返回空串，调用方会退回到默认文案。
 */
function summarizeToolCall(event) {
  const data = event?.data ?? {}
  const args = data.arguments ?? data.input ?? data.args
  if (typeof args === 'string') return clip(args)
  if (args && typeof args === 'object') {
    // 提问工具的第一个问题最适合当摘要。
    const first = Array.isArray(args.questions) ? args.questions[0] : undefined
    const text = first?.question ?? first?.header ?? args.prompt ?? args.question
    if (typeof text === 'string' && text.trim()) return clip(text)
  }
  return ''
}

/** 把长文本压成一段适合放进通知的短句。 */
function clip(text, limit = 160) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** 从会话对象上尽量取一个能区分「哪个会话」的名字。 */
function sessionLabel(session) {
  const title = session?.title ?? session?.header?.title
  if (typeof title === 'string' && title.trim()) return clip(title, 40)
  const id = session?.id ?? session?.header?.id
  return typeof id === 'string' ? `会话 ${id.slice(0, 8)}` : ''
}

/**
 * 防轰炸：同一类通知在 minIntervalMs 内只发一次。
 *
 * 为什么需要：一次审批可能连带触发多条 approval/asked；一个步骤里也可能
 * 连续多次工具调用。没有节流的话，右下角会连弹七八条一样的通知。
 */
class Throttle {
  constructor(minIntervalMs) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0)
    this.lastAt = new Map()
  }

  /** 返回 true 表示这次放行，false 表示被压掉。 */
  allow(key) {
    const now = Date.now()
    const last = this.lastAt.get(key) ?? 0
    if (now - last < this.minIntervalMs) return false
    this.lastAt.set(key, now)
    return true
  }

  /** 清空记录。插件停用或配置变更时调用，避免旧时间戳压住新通知。 */
  reset() {
    this.lastAt.clear()
  }
}

/**
 * 安装监听。
 *
 * @param {any} ctx DSH 插件上下文
 * @param {() => typeof import('./config.js').DEFAULT_CONFIG} readConfig
 * @returns {() => void} 卸载函数
 */
export function installListeners(ctx, readConfig) {
  const logger = ctx.logger
  const throttle = new Throttle(readConfig().minIntervalMs)

  // 记住哪些审批请求已经提醒过，用来给 approval/decided 找出对应的工具名。
  // 只保留最近的一小批，避免长时间运行后无限增长。
  const askedTools = new Map()
  const ASKED_MEMORY_LIMIT = 50

  const rememberAsked = (id, toolName) => {
    if (!id) return
    askedTools.set(id, toolName)
    while (askedTools.size > ASKED_MEMORY_LIMIT) {
      const oldest = askedTools.keys().next().value
      askedTools.delete(oldest)
    }
  }

  /**
   * 统一的发送入口：先过配置和节流，再决定弹不弹。
   */
  const notify = (key, title, body) => {
    const config = readConfig()
    if (!config.enabled) return
    if (!throttle.allow(key)) {
      logger?.info?.(`[notify] 「${key}」在 ${config.minIntervalMs}ms 内已提醒过，这次跳过。`)
      return
    }
    // 故意不 await：通知是副作用，不该拖慢事件处理。
    void showToast({ title, body, silent: !config.playSound, logger })
  }

  const onSessionEvent = (session, event) => {
    const config = readConfig()
    if (!config.enabled) return
    const type = event?.type
    const data = event?.data ?? {}
    const label = sessionLabel(session)

    if (type === 'approval/asked') {
      if (!config.notifyOnApproval) return
      const toolName = typeof data.toolName === 'string' ? data.toolName : '某个操作'
      rememberAsked(data.id, toolName)
      const reason = typeof data.reason === 'string' && data.reason.trim() ? `：${clip(data.reason, 100)}` : ''
      notify('approval', 'DSH 需要你批准', clip(`${toolName}${reason}${label ? `　（${label}）` : ''}`))
      return
    }

    if (type === 'approval/decided') {
      // 审批结果不单独提醒：用户刚做的决定，马上再弹一条纯属噪音。
      // 这里只把记忆清掉，保持 Map 干净。
      if (data.id) askedTools.delete(data.id)
      return
    }

    if (type === 'tool/call') {
      if (!config.notifyOnQuestion) return
      const toolName = questionToolName(event)
      if (!toolName) return
      const summary = summarizeToolCall(event)
      notify('question', 'DSH 在等你回答', summary || (label ? `有个问题需要你确认（${label}）` : '有个问题需要你确认'))
      return
    }

    if (type === 'turn/end') {
      if (!config.notifyOnTurnEnd) return
      const kind = data.reason?.kind
      // 用户主动中止不该再提醒——那是他自己按的停止键。
      if (kind !== 'completed') return
      notify('turn', 'DSH 这一轮完成了', label ? `${label} 已完成，可以回来看看结果。` : '已完成，可以回来看看结果。')
      return
    }
  }

  // { global: true } 让所有会话的事件都进来，而不只是当前聚焦的那个。
  // 这正是「切走做别的事也能被提醒」的前提。
  const dispose = ctx.on('session/event', onSessionEvent, { global: true })

  return () => {
    try {
      dispose?.()
    } catch (error) {
      logger?.warn?.(`[notify] 卸载事件监听失败：${error instanceof Error ? error.message : String(error)}`)
    }
    throttle.reset()
    askedTools.clear()
  }
}
