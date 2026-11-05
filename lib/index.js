/**
 * dsh-notify-on-attention —— 在需要你介入时弹 Windows 系统通知。
 *
 * DSH 加载插件时调用一次 apply()。所有副作用都挂在 ctx.effect 里，
 * 这样插件停用时 DSH 会调用我们返回的清理函数，不留残余监听。
 */

import { loadConfig } from './config.js'
import { installListeners } from './listeners.js'
import { canNotify } from './toast.js'

export const name = 'dsh-notify-on-attention'

/**
 * @param {any} ctx DSH 插件上下文
 */
export function apply(ctx) {
  const logger = ctx.logger

  // 无法发通知的平台（非 Windows）直接说明并退出，别让用户对着「没反应」猜。
  if (!canNotify()) {
    logger?.info?.('[notify] 当前系统不是 Windows，系统通知功能不启用。')
    return
  }

  ctx.effect(() => {
    const config = loadConfig(undefined, logger)

    if (!config.enabled) {
      logger?.info?.('[notify] 已在配置里关闭（enabled=false），不挂任何监听。')
      return () => {}
    }

    const channels = [
      config.notifyOnQuestion ? '提问' : '',
      config.notifyOnApproval ? '审批' : '',
      config.notifyOnTurnEnd ? '轮次完成' : '',
    ].filter(Boolean)

    logger?.info?.(
      `[notify] 已启用：${channels.length > 0 ? channels.join('、') : '（三类提醒全关）'}` +
        `${config.playSound ? '，带提示音' : '，静音'}`,
    )

    const dispose = installListeners(ctx, () => config)
    return () => {
      dispose()
      logger?.info?.('[notify] 已停用，监听已移除。')
    }
  })
}

/**
 * 插件对象形式。DSH 两种装配方式（具名导出 / 对象导出）都接受，
 * 这里两种都给，顺手让烟测有一个稳定的模块入口可以直接断言。
 */
export const plugin = { name, apply }
