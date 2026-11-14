/**
 * 团队工具（挂在项目经理的预设里）：
 *
 *   ledger_update —— 更新项目账本的一行
 *   ledger_read   —— 读回整本账
 *   team_status   —— 看整棵团队的实时状态
 *
 * 为什么账本不在上下文里：PM 的上下文一旦压缩就会失忆。
 * 账本落在项目目录的 .dsh-team/ledger.json，PM 随时读回来，压缩多少次都不怕。
 *
 * 为什么手写工具定义而不 import @deepseek-ai/dsh-tools：
 * 第三方插件目录解析不到 dsh 安装目录里的包（ESM 读不了 app.asar）。
 * tools.register() 只校验 output.render / output.schema，参数用标准 JSON Schema 即可，
 * 所以不需要 defineTool。
 */
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-team-hierarchy/tools'
export const inject = ['tools', 'llm', 'subagents', 'workingDirectory']

const LANE_STATUS = ['planning', 'running', 'blocked', 'done', 'dropped']

function unwrapVolatile(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export function apply(ctx) {
  /** 账本落在被服务会话自己的工作目录下，跟着项目走。 */
  function ledgerDir(exec) {
    let base = process.cwd()
    try {
      const wd = ctx.workingDirectory
      const session = exec?.agent?.session
      if (wd !== undefined && session !== undefined) base = wd.get(session)
    } catch {
      /* 拿不到工作目录就用进程 cwd */
    }
    return path.join(base, '.dsh-team')
  }

  function ledgerFile(exec) {
    return path.join(ledgerDir(exec), 'ledger.json')
  }

  function readLedger(exec) {
    const file = ledgerFile(exec)
    if (!fs.existsSync(file)) return { lanes: {} }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' && parsed.lanes ? parsed : { lanes: {} }
    } catch {
      return { lanes: {} }
    }
  }

  function writeLedger(exec, ledger) {
    const file = ledgerFile(exec)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(ledger, null, 2), 'utf8')
  }

  function renderLedger(ledger) {
    const lanes = Object.values(ledger.lanes ?? {})
    if (lanes.length === 0) return '账本是空的。还没有开过战线。'
    lanes.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const cell = (v) => String(v ?? '-').replace(/\|/g, '/').replace(/\n/g, ' ')
    const lines = [
      '| 战线 | 状态 | 进展 | 风险 | 下一步 |',
      '| --- | --- | --- | --- | --- |',
      ...lanes.map((r) => {
        const title = r.title ? `${r.id} · ${r.title}` : r.id
        return `| ${cell(title)} | ${cell(r.status)} | ${cell(r.progress)} | ${cell(r.risk)} | ${cell(r.next)} |`
      }),
    ]
    return lines.join('\n')
  }

  const ledgerRead = {
    name: 'ledger_read',
    description:
      '读取项目账本。账本记着每一条战线的状态、一句话进展、风险和下一步，'
      + '它存在磁盘上而不在你的上下文里——所以即使你被压缩过、会话重开过，读回来就全知道。'
      + '回答用户进度问题之前、或者派新活之前，先读一遍。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return renderLedger(readLedger(exec))
    },
  }

  const ledgerUpdate = {
    name: 'ledger_update',
    description:
      '新增或更新账本里的战线。这是你在长项目里唯一可靠的记忆。'
      + '一次调用传 lanes 写多条——收工时把这一轮改了状态的战线一次写完，不要一条一轮。'
      + 'progress 只写一句话，不要写过程。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lanes: {
          type: 'array',
          description:
            '要写的战线，至少一条。把这一次要改的全部放进来——'
            + '一条战线一个元素，不要为每条单独调一次工具。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '战线编号。' },
              title: { type: 'string', description: '战线一句话名字。' },
              status: { type: 'string', enum: LANE_STATUS, description: '状态。' },
              progress: { type: 'string', description: '一句话进展。' },
              risk: { type: 'string', description: '一句话风险。' },
              next: { type: 'string', description: '一句话下一步。' },
            },
            required: ['id', 'status'],
          },
        },
      },
      required: ['lanes'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const batch = Array.isArray(args?.lanes) ? args.lanes : []
      if (batch.length === 0) throw new Error('lanes 不能为空，至少写一条战线')
      const ledger = readLedger(exec)
      ledger.lanes ??= {}
      const touched = []
      for (const entry of batch) {
        const status = String(entry?.status ?? '').trim()
        if (!LANE_STATUS.includes(status)) {
          throw new Error(`status 必须是 ${LANE_STATUS.join(' / ')} 之一，收到 "${status}"`)
        }
        const id = String(entry?.id ?? '').trim()
        if (id === '') throw new Error('id 不能为空')
        const prev = ledger.lanes[id] ?? { id }
        const add = (key) => (entry?.[key] === undefined ? {} : { [key]: entry[key] })
        ledger.lanes[id] = {
          ...prev,
          id,
          ...add('title'),
          status,
          ...add('progress'),
          ...add('risk'),
          ...add('next'),
          updated: Date.now(),
        }
        touched.push(id)
      }
      writeLedger(exec, ledger)
      return `已更新 ${touched.join('、')}。\n\n${renderLedger(ledger)}`
    },
  }

  const teamStatus = {
    name: 'team_status',
    description:
      '看整棵团队的实时状态：每个下级会话的层级、名字、是否在跑。'
      + '派活之前用它看谁空着；收工之后用它确认没人还在跑。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec?.agent
      if (agent === undefined) return '没有调用者。'
      const subagents = ctx.subagents
      if (subagents === undefined) return 'subagents 服务不可用。'
      let rows
      try {
        rows = await subagents.listDescendants(agent.id)
      } catch (error) {
        return `读团队树失败：${String(error?.message ?? error)}`
      }
      const usable = rows.filter((r) => r.kind === 'child')
      if (usable.length === 0) return '现在你下面没有任何下级。'
      const lines = usable
        .sort((a, b) => a.depth - b.depth || String(a.id).localeCompare(String(b.id)))
        .map((r) => {
          const indent = '  '.repeat(Math.max(0, r.depth - 1))
          const label = r.label ?? r.id
          const state = r.activity === 'running' ? '跑着' : '空闲'
          return `${indent}- ${label}（${r.mode}，${state}${r.hasChildren ? '，还有下级' : ''}）`
        })
      const running = usable.filter((r) => r.activity === 'running').length
      const verdict = running === 0
        ? '可以收工：没有下级还在跑。'
        : `不能收工：还有 ${running} 个下级在跑，用 wait_agent 继续等，别提前宣布完成。`
      return `共 ${usable.length} 个下级，${running} 个在跑：\n\n${lines.join('\n')}\n\n${verdict}`
    },
  }

  const roleConfig = {
    name: 'role_config',
    description:
      '查看或修改四个岗位（pm 项目经理 / lead 小组长 / worker 普工 / tech 技术员）使用的模型与推理档位。'
      + 'action=show 列出每个岗位当前配置，以及这台机器上已添加的 provider 和它们的模型；'
      + 'action=set 改一个岗位。provider 和 model 同时留空表示继承上级的模型。'
      + '改完对之后新派出去的子会话生效，已经在跑的不受影响。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'set'], description: 'show 看，set 改。' },
        role: {
          type: 'string',
          enum: ['pm', 'lead', 'worker', 'tech'],
          description: 'set 时必填：改哪个岗位。',
        },
        provider: { type: 'string', description: 'set 时用；留空字符串表示继承上级。' },
        model: { type: 'string', description: 'set 时用；留空字符串表示继承上级。' },
        effort: {
          type: 'string',
          enum: ['off', 'low', 'high', 'max'],
          description: 'set 时用：该岗位的默认推理档位。',
        },
        assignments: {
          type: 'array',
          description:
            '一次改多个岗位。给了这个就忽略上面的 role/provider/model/effort 单条字段。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', enum: ['lead', 'worker', 'tech', 'pm'], description: '改哪个岗位。' },
              provider: { type: 'string', description: 'provider id；留空字符串表示继承上级。' },
              model: { type: 'string', description: '模型 id；留空字符串表示继承上级。' },
              effort: { type: 'string', enum: ['off', 'low', 'high', 'max'], description: '档位。' },
            },
            required: ['role'],
          },
        },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const ROLES = ['lead', 'worker', 'tech', 'pm']
      const EFFORT_DEFAULT = { pm: 'high', lead: 'high', worker: 'low', tech: 'high' }

      // 读的和 delegate 读的是同一份：Host 插件的 Config。
      // 以前这里读 roles.json，delegate 却优先读 Config，两份值打架，
      // role_config set 完了派活还是老值。
      const hostConfig = globalThis.__dshTeamHierarchyConfig ?? {}
      const pick = (role, suffix) => String(unwrapVolatile(hostConfig[role + suffix]) ?? '').trim()

      var lines_note = ''
      const view = {}
      for (const role of ROLES) {
        view[role] = {
          provider: pick(role, 'Provider'),
          model: pick(role, 'Model'),
          effort: pick(role, 'Effort') || EFFORT_DEFAULT[role],
        }
      }

      if (args?.action === 'set') {
        const batch = Array.isArray(args.assignments) && args.assignments.length > 0
          ? args.assignments
          : [{ role: args.role, provider: args.provider, model: args.model, effort: args.effort }]
        const write = globalThis.__dshTeamWriteRoles
        if (typeof write !== 'function') {
          throw new Error('Host 配置写入器不可用（Host 插件没起来）')
        }
        const patch = {}
        const changed = []
        for (const item of batch) {
          const role = String(item?.role ?? '').trim()
          if (!ROLES.includes(role)) throw new Error(`role 必须是 ${ROLES.join(' / ')} 之一，收到 "${role}"`)
          const next = { ...view[role] }
          if (item.provider !== undefined) next.provider = String(item.provider).trim()
          if (item.model !== undefined) next.model = String(item.model).trim()
          if (item.effort !== undefined) next.effort = String(item.effort).trim()
          if ((next.provider !== '') !== (next.model !== '')) {
            throw new Error(`${role}：provider 和 model 必须同时给或同时留空`)
          }
          patch[role + 'Provider'] = next.provider
          patch[role + 'Model'] = next.model
          patch[role + 'Effort'] = next.effort
          view[role] = next
          changed.push(role)
        }
        await write(patch)
        lines_note = `已写入：${changed.join('、')}。`
      } else {
        lines_note = ''
      }

      const lines = ['## 岗位配置', '', '| 岗位 | provider | 模型 | 档位 |', '| --- | --- | --- | --- |']
      for (const role of ROLES) {
        const cfg = view[role]
        const p = cfg.provider === '' ? '（继承上级）' : cfg.provider
        const m = cfg.model === '' ? '（继承上级）' : cfg.model
        lines.push(`| ${role} | ${p} | ${m} | ${cfg.effort || '-'} |`)
      }

      if (args?.action === 'show') {
        lines.push('', '## 这台机器上已添加的 provider 与模型')
        // 和设置面板下拉用同一套合并逻辑，否则两边看到的列表不一样。
        const merged = []
        try {
          merged.push(...(ctx.llm.listProviders() ?? []))
        } catch {
          /* 来源不可用 */
        }
        try {
          merged.push(...(ctx.llm.listConfigurableProviders() ?? []))
        } catch {
          /* 来源不可用 */
        }
        const seen = new Set()
        const providers = []
        for (const info of merged) {
          const pid = String(info?.id ?? info?.provider ?? info?.name ?? info?.settingsNs ?? '')
          if (pid === '' || seen.has(pid)) continue
          seen.add(pid)
          providers.push(info)
        }
        if (providers.length === 0) lines.push('', '（没有已注册的 provider）')
        for (const info of providers) {
          const pid = String(info?.id ?? info?.provider ?? info?.name ?? '?')
          let models = []
          try {
            models = (await ctx.llm.listModels(pid)) ?? []
          } catch {
            models = []
          }
          const ids = models.map((m) => String(m?.id ?? m?.model ?? '?')).join(', ')
          lines.push(`- \`${pid}\`：${ids === '' ? '（读不到模型列表）' : ids}`)
        }
      }

      if (typeof lines_note === 'string' && lines_note !== '') {
        lines.push('', lines_note)
      }

      return lines.join('\n')
    },
  }

  ctx.effect(() => {
    const disposers = [ledgerRead, ledgerUpdate, teamStatus, roleConfig].map((definition) =>
      ctx.tools.register(definition),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
