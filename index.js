/**
 * Host 半区：只做一件事——把三个岗位的模型配置声明成可编辑的 volatile 字段，
 * 让设置面板能改，改了立刻生效，不用重启。
 *
 * 配置给了谁：delegate.js 在另一个插件实例里跑，读不到这里的 Config 参数。
 * 所以这里把 config 引用挂到 globalThis，delegate 侧按 volatile ref 现读最新值。
 * 这是同进程共享，不是跨进程。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-team-hierarchy'

/**
 * schemastery 是配置 schema 的 DSL。宿主安装目录里的包在 app.asar 内，
 * 第三方插件用 ESM import 解析不到，所以用 vendor 副本静态导入。
 * 静态导入的好处：拿不到就直接在插件行上报错，而不是悄悄变成 Config=undefined。
 */
import z from './vendor/schemastery.mjs'

export const inject = ['llm', 'configEditor']

function roleFields() {
  const out = {}
  for (const role of ['lead', 'worker', 'tech']) {
    out[`${role}Provider`] = z.string().default('').volatile()
      .description(`${role} 用的 provider id；留空表示继承上级。必须和下面的模型同时填或同时留空。`)
    out[`${role}Model`] = z.string().default('').volatile()
      .description(`${role} 用的模型 id；留空表示继承上级。`)
    out[`${role}Effort`] = z.string().default(role === 'worker' ? 'low' : 'high').volatile()
      .description(`${role} 的默认推理档位：off / low / high / max。`)
  }
  // 由 Host 自己算好写进来，Clients 侧只读不写。这样设置页不需要调 Remote 也能拿到
  // 这台机器上已添加的 provider 和模型。
  out.catalogJson = z.string().default('[]').volatile()
    .description('自动生成：本机已添加的 provider 与模型目录（JSON）。不用手填。')
  return out
}

export const Config = z.object(roleFields())

/** volatile 引用解包；普通值原样返回。 */
export function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** delegate 侧按这个键取配置引用。 */
const SLOT = '__dshTeamHierarchyConfig'

export function apply(ctx, config) {
  globalThis[SLOT] = config ?? {}
  ctx.effect(() => () => {
    if (globalThis[SLOT] === config) delete globalThis[SLOT]
  })

  /**
   * 把这台机器上已添加的 provider 与模型算成 JSON，写回自己的 volatile 字段。
   * 为什么绕这么一圈：Clients 侧在设置页拿不到 llm 的 Remote 命名空间，
   * 但一定能读 configForms 里的 Config 值。所以让 Host 算、Client 读。
   */
  // role_config 工具跑在另一个插件实例里，写不到这里的 Config。
  // 把写入器挂出去，让两个入口改的是同一份配置——以前它们各写各的，
  // UI 的值会永远压住 role_config 改的值，组长因此起不来。
  globalThis.__dshTeamWriteRoles = async (patch) => {
    const editor = ctx.configEditor
    const entry = ctx.fiber?.entry
    if (editor === undefined || entry === undefined) throw new Error('配置写入器不可用')
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
  }
  ctx.effect(() => () => {
    delete globalThis.__dshTeamWriteRoles
  })

  async function refreshCatalog() {
    try {
      // 两套来源都要读：
      //   listProviders            —— 已注册 adapter 的 provider
      //   listConfigurableProviders —— 用户在「模型」设置里手动添加的（中转站这类）
      const sources = []
      try {
        sources.push(...(ctx.llm.listProviders() ?? []))
      } catch {
        /* 该来源不可用 */
      }
      try {
        sources.push(...(ctx.llm.listConfigurableProviders() ?? []))
      } catch {
        /* 该来源不可用 */
      }

      const byId = new Map()
      for (const info of sources) {
        const id = String(info?.id ?? info?.provider ?? info?.name ?? info?.settingsNs ?? '')
        if (id === '') continue
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            name: String(info?.name ?? info?.label ?? id),
            models: Array.isArray(info?.models) ? info.models : undefined,
          })
        }
      }

      const catalog = []
      for (const entry of byId.values()) {
        let models = entry.models
        if (models === undefined) {
          try {
            models = (await ctx.llm.listModels(entry.id)) ?? []
          } catch {
            models = []
          }
        }
        const normalized = (models ?? [])
          .map((m) => ({
            id: String(m?.id ?? m?.model ?? ''),
            name: String(m?.name ?? m?.label ?? m?.id ?? m?.model ?? ''),
          }))
          .filter((m) => m.id !== '')
        // 只收真正能列出模型的 provider：内置候选里没配 key 的拉不出模型，
        // 把它们留在列表里只会让用户在一堆没启用的名字里挑。
        if (normalized.length === 0) continue
        catalog.push({ id: entry.id, name: entry.name, models: normalized })
      }

      // 排序后再序列化：listModels 的返回顺序若不稳定，json 每次都不同，
      // 就会每 60 秒白写一次 profile 配置。
      catalog.sort((a, b) => a.id.localeCompare(b.id))
      for (const item of catalog) item.models.sort((x, y) => x.id.localeCompare(y.id))

      const json = JSON.stringify(catalog)
      if (unwrap(config?.catalogJson) === json) return

      const editor = ctx.configEditor
      const entry = ctx.fiber?.entry
      if (editor === undefined || entry === undefined) return
      await editor.edit(entry, (current) => ({ ...current, catalogJson: json }))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-team-hierarchy] 刷新模型目录失败：${String(error?.message ?? error)}`)
    }
  }

  const first = setTimeout(() => {
    void refreshCatalog()
  }, 2000)
  const repeat = setInterval(() => {
    void refreshCatalog()
  }, 60000)
  ctx.effect(() => () => {
    clearTimeout(first)
    clearInterval(repeat)
  })

  ctx.logger?.info?.(
    `[dsh-team-hierarchy] 岗位配置已挂载，状态目录 ${join(homedir(), '.dsh')}`,
  )
}
