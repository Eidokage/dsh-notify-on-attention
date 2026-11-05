/**
 * 烟测：验证插件在没有任何 DSH 运行时的情况下也能被加载、配置能解析、
 * 事件能被正确翻译成通知、Toast 脚本的编码约定没被改坏。
 *
 * 刻意不依赖任何测试框架——`npm test` 直接 node 跑，clone 下来就能验。
 * 这里不弹真实通知（那需要有人坐在电脑前看），只断言「该弹的时候发出了调用、
 * 不该弹的时候一次都没发」。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG, loadConfig, mergeConfig } from '../lib/config.js'
import { buildCommandArgs, canNotify, decodeCommandArgs } from '../lib/toast.js'
import { installListeners } from '../lib/listeners.js'
import { plugin as pluginEntry } from '../lib/index.js'

let passed = 0

function test(title, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    console.error(`  ✗ ${title}`)
    throw error
  }
}

/** 静默 logger，避免测试输出被插件的日志刷屏。 */
function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

/** 造一个能记录通知调用的假 ctx。 */
function fakeCtx() {
  const handlers = []
  const disposers = []
  return {
    ctx: {
      logger: quietLogger(),
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      on(type, handler) {
        handlers.push({ type, handler })
        return () => {
          const index = handlers.findIndex((item) => item.handler === handler)
          if (index >= 0) handlers.splice(index, 1)
        }
      },
    },
    handlers,
    emit(type, event, session = { title: '测试会话' }) {
      for (const item of handlers.slice()) {
        if (item.type === type) item.handler(session, event)
      }
    },
    /**
     * 模拟 DSH 停用插件：先调用 effect 返回的清理函数，再把 remaining 里
     * 残留的监听逐个摘掉。真实宿主会做后者，测试替身必须照做，
     * 否则「卸载后事件不再进来」这条断言测的是替身的 bug 而不是插件的。
     */
    disposeAll() {
      for (const dispose of disposers.splice(0)) dispose()
      handlers.length = 0
    },
  }
}

/** 造一组假通知发送器，返回收到的调用列表。 */
function recorder() {
  const calls = []
  const send = (payload) => {
    calls.push(payload)
    return Promise.resolve(true)
  }
  send.calls = calls
  return send
}

function config(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides }
}

console.log('dsh-notify-on-attention 烟测\n')

console.log('配置解析')
test('export 的默认配置是不可变模板，改副本不影响默认值', () => {
  const copy = config()
  copy.enabled = false
  assert.equal(DEFAULT_CONFIG.enabled, true, '默认配置被外部改动污染了')
})

test('未知键与类型不符的键退回默认值并记 warn', () => {
  const warns = []
  const merged = mergeConfig({ enabled: false, playSound: 'yes', 拼错的键: 1 }, { warn: (m) => warns.push(m) })
  assert.equal(merged.enabled, false, '合法键应生效')
  assert.equal(merged.playSound, DEFAULT_CONFIG.playSound, '类型不符应退回默认值')
  assert.equal(warns.length, 2, `应记 2 条 warn，实际 ${warns.length}`)
})

test('顶层不是对象时整体退回默认值', () => {
  assert.equal(mergeConfig([1, 2, 3]).enabled, true, '数组应被拒绝')
  assert.equal(mergeConfig(null).enabled, true, 'null 应被拒绝')
  assert.equal(mergeConfig('x').enabled, true, '字符串应被拒绝')
})

test('配置文件不存在时静默返回默认值', () => {
  const merged = loadConfig(join(tmpdir(), 'dsh-notify-no-such-file-xyz.json'), quietLogger())
  assert.deepEqual(merged, { ...DEFAULT_CONFIG })
})

test('配置文件不是合法 JSON 时不抛异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-'))
  try {
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{ this is not json')
    const merged = loadConfig(path, quietLogger())
    assert.deepEqual(merged, { ...DEFAULT_CONFIG })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\n事件翻译')
test('approval/asked 命中时发审批通知', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config(), send)
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a1', toolName: 'shell' } })
  assert.equal(send.calls.length, 1)
  assert.equal(send.calls[0].title, 'DSH 需要你批准')
  fake.disposeAll()
})

test('approval/decided 不单独提醒', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config(), send)
  fake.emit('session/event', { type: 'approval/decided', data: { id: 'a1', outcome: 'allow' } })
  assert.equal(send.calls.length, 0, '审批结果不该再弹通知')
  fake.disposeAll()
})

test('tool/call 命中 ask_user_question 时发提问通知', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config(), send)
  fake.emit('session/event', {
    type: 'tool/call',
    data: { name: 'ask_user_question', arguments: { questions: [{ question: '要继续吗？' }] } },
  })
  assert.equal(send.calls.length, 1)
  assert.equal(send.calls[0].title, 'DSH 在等你回答')
  assert.match(send.calls[0].body, /要继续吗/, '正文应带上第一个问题')
  fake.disposeAll()
})

test('普通工具调用不提醒', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config(), send)
  fake.emit('session/event', { type: 'tool/call', data: { name: 'read_file' } })
  assert.equal(send.calls.length, 0)
  fake.disposeAll()
})

test('turn/end 只有 completed 才提醒，aborted 不提醒', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config(), send)
  fake.emit('session/event', { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  assert.equal(send.calls.length, 0, '用户自己按的停止键不该再提醒')
  fake.emit('session/event', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(send.calls.length, 1)
  fake.disposeAll()
})

test('节流：同类通知在 minIntervalMs 内只发第一条', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config({ minIntervalMs: 60000 }), send)
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a1', toolName: 'shell' } })
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a2', toolName: 'shell' } })
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a3', toolName: 'shell' } })
  assert.equal(send.calls.length, 1, `应只发 1 条，实际 ${send.calls.length}`)
  fake.disposeAll()
})

test('节流按类别独立：提问与审批互不压制', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config({ minIntervalMs: 60000 }), send)
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a1', toolName: 'shell' } })
  fake.emit('session/event', { type: 'tool/call', data: { name: 'ask_user_question' } })
  assert.equal(send.calls.length, 2, '两类通知应各自放行一次')
  fake.disposeAll()
})

test('配置关闭后一条都不发', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config({ enabled: false }), send)
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a1', toolName: 'shell' } })
  fake.emit('session/event', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(send.calls.length, 0)
  fake.disposeAll()
})

test('单个开关关掉只影响那一类', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config({ notifyOnApproval: false, minIntervalMs: 0 }), send)
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a1', toolName: 'shell' } })
  fake.emit('session/event', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(send.calls.length, 1, '关掉审批后应只剩轮次完成那条')
  assert.equal(send.calls[0].title, 'DSH 这一轮完成了')
  fake.disposeAll()
})

test('卸载后不再收到事件', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config(), send)
  fake.disposeAll()
  fake.emit('session/event', { type: 'approval/asked', data: { id: 'a1', toolName: 'shell' } })
  assert.equal(send.calls.length, 0, '卸载后监听应已移除')
})

test('静音配置会透传成 silent', () => {
  const fake = fakeCtx()
  const send = recorder()
  installListeners(fake.ctx, () => config({ playSound: false }), send)
  fake.emit('session/event', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(send.calls[0].silent, true)
  fake.disposeAll()
})

console.log('\nToast 编码')
test('脚本以 UTF-16LE + Base64 传递，Post-Shown 标记存在', () => {
  const args = buildCommandArgs('标题', '正文', false)
  assert.equal(args[0], '-NoProfile')
  assert.ok(args.includes('-EncodedCommand'), '必须走 -EncodedCommand')
  const script = decodeCommandArgs(args)
  assert.match(script, /Windows\.UI\.Notifications/, '脚本应引用 WinRT 通知类型')
  assert.match(script, /Write-Output 'SHOWN'/, '应输出 SHOWN 作为成功标记')
})

test('XML 特殊字符被转义', () => {
  const script = decodeCommandArgs(buildCommandArgs('a & b', '<c> "d"', false))
  assert.ok(script.includes('&amp;'), '& 未转义会让 LoadXml 失败')
  assert.ok(script.includes('&lt;'), '< 未转义会让 LoadXml 失败')
  assert.ok(!script.includes('<c>'), '原始标签不应出现在 XML 里')
})

test('silent 时写入 audio silent', () => {
  const loud = decodeCommandArgs(buildCommandArgs('t', 'b', false))
  const quiet = decodeCommandArgs(buildCommandArgs('t', 'b', true))
  assert.ok(!loud.includes('audio silent'), '非静音不该带 audio silent')
  assert.ok(quiet.includes('audio silent'), '静音应带 audio silent')
})

console.log('\n模块契约')
test('index 至少导出 apply 与 name', () => {
  assert.equal(typeof pluginEntry, 'object', 'index 应导出 plugin 对象供烟测使用')
  assert.equal(typeof pluginEntry.apply, 'function', 'index 必须导出 apply')
  assert.equal(typeof pluginEntry.name, 'string', 'index 必须导出 name')
})

test('canNotify 返回布尔值，不抛异常', () => {
  assert.equal(typeof canNotify(), 'boolean')
})

console.log(`\n烟测通过：${passed} 项`)
