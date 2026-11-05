/**
 * 配置读取层。
 *
 * 配置刻意做成一个朴素的 JSON 文件，而不是塞进 DSH 的 profile 配置里——
 * profile 的 cordis.patch.yml 会被应用重写，把手写配置放进去迟早被冲掉。
 *
 * 默认位置：<用户目录>/.dsh/notify-on-attention.json
 * 也可以用环境变量 DSH_NOTIFY_CONFIG 指向别的文件。
 *
 * 设计原则：配置读坏了不能炸插件。解析失败就退回默认值并记一条 warn，
 * 让用户看得见「我写的配置没生效」，而不是让整个插件消失。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 三类提醒各自的默认开关与文案。 */
export const DEFAULT_CONFIG = {
  /** 总开关：false 时下面三项全部失效。 */
  enabled: true,

  /** 代理主动向你提问时（工具调用 ask_user_question / 需要你补充信息）。 */
  notifyOnQuestion: true,

  /** 需要你批准某个操作时（approval/asked）。 */
  notifyOnApproval: true,

  /**
   * 一轮对话结束时（turn/end）。
   * 注意这里只报「完成」，用户中止（aborted）的不报——那是他自己按的停止键，
   * 再弹一条通知只会烦人。
   */
  notifyOnTurnEnd: true,

  /** 是否播放系统提示音。专注环境中关掉更舒服。 */
  playSound: true,

  /**
   * 窗口在前台时不打扰。
   * 为 true 时，如果 DSH 窗口正被聚焦则跳过通知。
   * Windows 上判断前台窗口需要额外调用，代价不小，默认关闭。
   */
  suppressWhenForeground: false,

  /** 同类通知的最小间隔（毫秒），用于防轰炸。 */
  minIntervalMs: 4000,
}

/** 配置文件的默认路径。 */
export function defaultConfigPath() {
  return process.env.DSH_NOTIFY_CONFIG || join(homedir(), '.dsh', 'notify-on-attention.json')
}

/**
 * 读取配置。缺失的键用默认值补全，类型不对的键退回默认值。
 *
 * @param {string} [filePath]
 * @param {any} [logger]
 * @returns {typeof DEFAULT_CONFIG & { deviceName?: string }}
 */
export function loadConfig(filePath = defaultConfigPath(), logger) {
  const config = { ...DEFAULT_CONFIG }

  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    // 文件不存在是最常见的情况，属于正常状态，不报警。
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[notify] 读取配置失败（${filePath}），改用默认配置：${error?.message ?? error}`)
    }
    return config
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger?.warn?.(`[notify] 配置文件不是合法 JSON（${filePath}），改用默认配置：${error?.message ?? error}`)
    return config
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger?.warn?.(`[notify] 配置文件顶层必须是对象（${filePath}），改用默认配置。`)
    return config
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in DEFAULT_CONFIG)) {
      // 未知键多半是拼错了，明确提示比默默忽略好。
      logger?.warn?.(`[notify] 配置里有未知的键「${key}」，已忽略。`)
      continue
    }
    const expected = typeof DEFAULT_CONFIG[key]
    if (typeof value !== expected) {
      logger?.warn?.(`[notify] 配置项「${key}」应为 ${expected}，实际是 ${typeof value}，已忽略。`)
      continue
    }
    config[key] = value
  }

  return config
}
