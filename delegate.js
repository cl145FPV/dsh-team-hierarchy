/**
 * 派活工具（挂在项目经理和小组长的预设里）。
 *
 * 和官方 @deepseek-ai/dsh-tool-subagent 的区别只有一个：
 * 子会话用哪个 provider / 模型 / 推理档位，从设置里「团队岗位」那一份配置现读，
 * 不是写死在 preset 的 config 里。
 *
 * 配置存在 Host 插件的 volatile Config 里；这里通过 globalThis 上的引用现读，
 * 所以改完不用重启，下一次派活就生效。
 */
export const name = 'dsh-team-hierarchy/delegate'
// subagents 必须走 inject：ctx.get('subagents') 拿到的对象不完整，
// startActivation 会读到空的东西。官方工具也是 inject 注入后直接用 ctx.subagents。
export const inject = ['tools', 'subagents', 'llm']

const ROLES = ['pm', 'lead', 'worker', 'tech', 'review']

const EFFORTS = ['off', 'low', 'high', 'max']

/** Host 半区把 Config 引用挂在这个键上；这里按 volatile ref 现读最新值。 */
const CONFIG_SLOT = '__dshTeamHierarchyConfig'

function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** 设置面板里配的岗位模型。UI 改了立刻生效，因为 ref 是现读的。 */
function roleFromConfig(role) {
  const config = globalThis[CONFIG_SLOT]
  if (!config) return { provider: '', model: '', effort: '' }
  const pick = (key) => String(unwrap(config[`${role}${key}`]) ?? '').trim()
  return { provider: pick('Provider'), model: pick('Model'), effort: pick('Effort') }
}

export function apply(ctx, config) {
  const childRole = String(config?.childRole ?? '')
  const childPreset = String(config?.childPreset ?? '')
  const toolName = String(config?.toolName ?? '')
  const maxDepth = Number.isInteger(config?.maxDepth) ? config.maxDepth : 2

  if (childRole === '' || childPreset === '' || toolName === '') {
    throw new Error('delegate 插件需要 config.childRole / config.childPreset / config.toolName')
  }
  if (!ROLES.includes(childRole)) {
    throw new Error(`config.childRole 必须是 ${ROLES.join(' / ')} 之一，收到 "${childRole}"`)
  }

  const definition = {
    name: toolName,
    description:
      `把一个子任务交给下级（预设 ${childPreset}）。子会话看不到你这段对话，所以 prompt 必须自包含。`
      + `它的模型和推理档位由设置里「团队岗位」的 ${childRole} 那一项决定；`
      + `你也可以用 effort 参数只覆盖这一单的档位（off/low/high/max）。`
      + '调用后立即返回，子会话完成后会有完成通知。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description: '这段任务的一句话标题，会显示在子会话列表里。',
        },
        name: {
          type: 'string',
          description: '可选的子会话短名，小写字母数字连字符，最多 32 字符。省了就自动编号。',
        },
        prompt: {
          type: 'string',
          description:
            '子会话的全部输入。它看不到你的对话，所以目标、路径、验收标准、禁止项、回报要求都要写全。',
        },
        effort: {
          type: 'string',
          enum: EFFORTS,
          description:
            '可选，只覆盖这一单的推理档位。不传就用该角色在设置里配的默认档位。'
            + 'off 适合纯机械执行，low 适合套路活，high 需要判断，max 极难。',
        },
        reuse: {
          type: 'string',
          description:
            '可选。要接手的已存在下级的名字（team_status 里看到的那个）。'
            + '给了它就把任务追加给那个会话、复用它已有的上下文，不新开；'
            + '不给就新建一个。同战线接着干、或者复核上一轮的问题时用它。',
        },
      },
      required: ['description', 'prompt'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec?.agent
      if (parent === undefined) throw new Error('没有调用者')

      // 复用分支：不新建会话，把任务追加给一个已经存在的下级。
      // 判不判断复用是调用方的事（它看得到 team_status），这里只负责执行。
      if (typeof args?.reuse === 'string' && args.reuse.trim() !== '') {
        const reuseName = args.reuse.trim()
        const subagents = ctx.subagents
        if (subagents === undefined) throw new Error('subagents 服务不可用')

        // 用 listDescendants 而不是 listChildren：在预设 scope 里后者拿到的对象上没有，
        // 前者是 team_status 一直在用的，确认可用。depth === 1 就是直接下级。
        let rows = []
        try {
          rows = (await subagents.listDescendants(parent.id)) ?? []
        } catch (error) {
          throw new Error(`读下级列表失败：${String(error?.message ?? error)}`)
        }
        const reuseable = rows.filter(
          (r) => r.kind === 'child' && r.depth === 1 && r.mode === 'continuable',
        )
        const target = reuseable.find((r) => String(r.label ?? '') === reuseName)
        if (target === undefined) {
          const names = reuseable.map((r) => String(r.label ?? r.id)).join('、')
          throw new Error(
            `找不到叫「${reuseName}」的可复用下级。`
            + `要传的是它的显示标题（team_status 里那一整串），不是内部短名。`
            + `现在能复用的有：${names === '' ? '（没有）' : names}`,
          )
        }
        await subagents.sendMessage(
          parent,
          target.id,
          [{ type: 'text', text: String(args.prompt) }],
          { signal: exec.signal },
        )
        return `已把任务追加给 ${reuseName}（复用它的上下文，没有新开会话）。它完成后会有通知。`
      }

      // 只认设置里那一份配置。roles.json 是早期版本的产物，已经不再写入，
      // 再拿它兜底只会让被清空的项悄悄复活成旧值。
      const fromUi = roleFromConfig(childRole)
      const provider = fromUi.provider
      const model = fromUi.model
      const roleEffort = fromUi.effort

      const agentOptions = {}
      if (provider !== '') agentOptions.provider = provider
      if (model !== '') agentOptions.model = model
      const effort = args?.effort ?? roleEffort
      if (typeof effort === 'string' && effort !== '') {
        agentOptions.reasoningEffort = effort
      }
      if ((agentOptions.provider === undefined) !== (agentOptions.model === undefined)) {
        throw new Error(
          `${childRole} 的 provider 和 model 必须同时给或同时留空（当前 provider=${provider || '空'} model=${model || '空'}）`,
        )
      }

      // 派活前预检 route：模型不支持这个档位时，子会话会「启动即死」，
      // 而调用方只看到一句「已派出」。官方的 tool-subagent 就是靠这一步拦住的。
      if (agentOptions.provider !== undefined && agentOptions.model !== undefined) {
        const llm = ctx.llm
        if (llm !== undefined && typeof llm.resolveCallConfig === 'function') {
          try {
            await llm.resolveCallConfig(
              {
                provider: agentOptions.provider,
                model: agentOptions.model,
                ...(agentOptions.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: agentOptions.reasoningEffort }),
              },
              exec.signal,
            )
          } catch (error) {
            throw new Error(
              `派活前预检没过：${agentOptions.provider}/${agentOptions.model}`
              + `${agentOptions.reasoningEffort ? ` 不支持推理档位 "${agentOptions.reasoningEffort}"` : ''}。`
              + `\n原因：${String(error?.message ?? error)}`
              + `\n去 设置 → 团队岗位 改掉这个岗位的模型或档位，或者给这一单传一个它能用的 effort。`,
            )
          }
        }
      }

      const subagents = ctx.subagents
      if (subagents === undefined) throw new Error('subagents 服务不可用')

      const safeList = () => {
        try {
          return typeof subagents.list === 'function' ? subagents.list() : '(list 不可用)'
        } catch {
          return '(list 抛错)'
        }
      }

      // 和官方实现对齐：provider 必须先真实注册，深度上限交给服务解析而不是硬塞数字。
      const spawnProvider = subagents.getProvider('spawn')
      if (spawnProvider === undefined) {
        throw new Error(`spawn provider 还没注册；当前已注册的是 ${JSON.stringify(safeList())}`)
      }
      const resolvedMaxDepth = subagents.resolveMaxDepth(maxDepth)

      const request = {
        prompt: [{ type: 'text', text: String(args.prompt) }],
        parent,
        agentPreset: childPreset,
        ...(resolvedMaxDepth === undefined ? {} : { maxDepth: resolvedMaxDepth }),
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      }

      let activation
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          label: String(args.description),
          ...(args.name === undefined ? {} : { name: String(args.name) }),
          // 必须展开：startActivation 读的是 spec.parent / spec.prompt / spec.agentPreset，
          // 整个塞进 spec.request 会让 spec.parent 变成 undefined。
          ...request,
          signal: exec.signal,
          delivery: 'parent',
        })
      } catch (error) {
        // 把现场交回去：这层错了只能靠这里看到真因。
        const detail = {
          message: String(error?.message ?? error),
          code: error?.code,
          stack: String(error?.stack ?? '').split('\n').slice(0, 8).join('\n'),
          parentHasId: parent?.id === undefined ? '(无 id)' : 'ok',
          parentId: parent?.id,
          hasSession: parent?.session !== undefined,
          sessionId: parent?.session?.id,
          signalIsAbort: exec?.signal instanceof AbortSignal,
          agentPreset: childPreset,
          childRole,
          agentOptions,
          resolvedMaxDepth,
          providerPresent: spawnProvider !== undefined,
          providers: safeList(),
        }
        throw new Error(`派活失败：${JSON.stringify(detail, null, 2)}`)
      }

      // 记下这个子会话是哪个岗位，team_status 写快照时要用。
      // 进程内映射，重启后旧子会话就没有角色了（显示为 —，可接受）。
      try {
        const childId = activation && (activation.childId ?? activation.id)
        if (childId !== undefined) {
          const map = globalThis.__dshTeamChildRoles ?? (globalThis.__dshTeamChildRoles = {})
          map[String(childId)] = { role: childRole, label: String(args.description) }
        }
      } catch {
        /* 旁路，失败不影响派活 */
      }

      const usedModel = agentOptions.model ?? '（继承上级）'
      const used = agentOptions.reasoningEffort ?? '（该角色默认）'
      return `已派出 ${activation.name}（预设 ${childPreset}，模型 ${usedModel}，档位 ${used}）。它完成后会有通知。`
    },
  }

  ctx.effect(() => ctx.tools.register(definition))
}
