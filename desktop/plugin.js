/**
 * workbuddy-status —— Hermes 桌面插件：展示 WorkBuddy / WorkBuddy AI 的
 * 剩余积分与模型倍率（对齐 DSH 里 dsh-workbuddy-connect 的展示）。
 *
 * 数据来源：本机桥接 workbuddy-bridge 的 GET /v1/status
 *   （端口 + 令牌读自桥接目录下的 config.json / config.ai.json）。
 * 展示位置：
 *   - 状态栏右侧：各版本剩余积分（点击展开明细 / 刷新）
 *   - 模型菜单：每个模型行尾部显示倍率与促销徽章（如 `x0.79 · 夜间折扣`）
 *   - 输入框模型 pill：当前会话模型后追加倍率（仅当该会话走 WorkBuddy provider）
 *   - 设置 → 插件 → WorkBuddy 状态：账号、令牌有效期、套餐余量、优惠模型、桥接目录
 *
 * 积分查询会真实打到 WorkBuddy 计费接口：桥接端有 TTL 缓存（默认 60s），
 * 插件只在挂载与手动刷新时查询，不做后台轮询。
 */

import {
  Badge,
  Button,
  Codicon,
  COMPOSER_AREAS,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  GlyphSpinner,
  MODEL_MENU_ROW_AREA,
  PALETTE_AREA,
  ScrollArea,
  Separator,
  STATUSBAR_AREAS,
  host,
  pluginSettingsHref,
  queryClient,
  relativeTime,
  useQuery,
  useQueryClient
} from '@hermes/plugin-sdk'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const BRIDGE_DIR_KEY = 'bridgeDir'
const QUERY_KEY = ['workbuddy-status']

/** 两个桥接实例。providerSlugs 用于匹配模型菜单行给出的 provider slug。 */
const VARIANTS = [
  {
    key: 'workbuddy',
    file: 'config.json',
    label: 'WB',
    title: 'WorkBuddy（国内版）',
    providerSlugs: ['workbuddy', 'custom:workbuddy']
  },
  {
    key: 'workbuddy-ai',
    file: 'config.ai.json',
    label: 'WB AI',
    title: 'WorkBuddy AI（国际版）',
    providerSlugs: ['workbuddy-ai', 'custom:workbuddy-ai']
  }
]

// ─────────────────────────── 小工具 ───────────────────────────

let storage = null

function joinPath(dir, name) {
  const base = String(dir || '').replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** 读本地文本文件（渲染进程通过桌面文件桥）。 */
async function readText(path) {
  const bridge = typeof window === 'undefined' ? undefined : window.hermesDesktop
  if (typeof bridge?.readFileText !== 'function') throw new Error('桌面文件桥不可用')
  const result = await bridge.readFileText(path)
  if (!result || typeof result.text !== 'string') {
    throw new Error(String(result?.message || `读取失败：${path}`))
  }
  return result.text
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'
}

/** 剩余天数（套餐到期时间）。 */
function formatUntil(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  return relativeTime(ms)
}

// ─────────────────────────── 数据层 ───────────────────────────

let instancesPromise = null
/** provider slug → 模型 id → 展示行（倍率/徽章），供同步查询使用。 */
const modelIndex = Object.create(null)
/** runtime session id → provider，供模型 pill 判断当前会话是否走 WorkBuddy。 */
const providerBySession = Object.create(null)
/** 最近一次见到的 WorkBuddy provider（会话映射缺失时的兜底）。 */
let lastProvider = ''
/** pill 贡献的注册句柄：数据到位后重注册，强制该区域重新解析。 */
let pillDisposer = null
/** register() 里的 ctx，供延迟注册使用。 */
let ctxRef = null

const PROVIDER_MAP_KEY = 'providerBySession'
const PROVIDER_MAP_MAX = 12

/** 恢复上次会话 → provider 映射：插件热重载后映射不会丢。 */
function restoreProviderMap() {
  try {
    const saved = storage?.get(PROVIDER_MAP_KEY, null)
    if (!saved || typeof saved !== 'object') return
    for (const [sessionId, provider] of Object.entries(saved)) {
      if (typeof provider === 'string' && provider !== '') providerBySession[sessionId] = provider
    }
  } catch { /* 存储不可用就当没有 */ }
}

function persistProviderMap() {
  try {
    const entries = Object.entries(providerBySession).slice(-PROVIDER_MAP_MAX)
    storage?.set(PROVIDER_MAP_KEY, Object.fromEntries(entries))
  } catch { /* 存储不可用就只在内存里 */ }
}

/** 从 react-query 缓存重建索引：插件热重载后缓存仍在，索引必须随读随建，
 *  否则 `loadSnapshot` 不再触发，菜单/徽章会一直查不到倍率。 */
function indexFromCache() {
  const data = queryClient.getQueryData(QUERY_KEY)
  if (data && Array.isArray(data.instances) && data.results) {
    rebuildIndex(data.instances, data.results)
  }
  return modelIndex
}

function bridgeDirSetting() {
  try {
    return String(storage?.get(BRIDGE_DIR_KEY, '') ?? '').trim()
  } catch {
    return ''
  }
}

/** 候选桥接目录：手动设置 → 插件数据目录 → 旧目录 → 从 Hermes home 逐级向上找。 */
function candidateBridgeDirs(hermesHome) {
  const out = []
  const stored = bridgeDirSetting()
  if (stored !== '') out.push(stored)
  // 插件版数据目录（机器级）：%LOCALAPPDATA%\hermes-workbuddy-bridge
  out.push(joinPath('~', 'AppData', 'Local', 'hermes-workbuddy-bridge'))
  // 旧版目录（legacy，兼容保留）
  out.push(joinPath('~', 'workbuddy-bridge'))
  let path = String(hermesHome || '').trim().replace(/[\\/]+$/, '')
  for (let depth = 0; depth < 6 && path !== ''; depth += 1) {
    out.push(joinPath(path, 'hermes-workbuddy-bridge'))
    out.push(joinPath(path, 'workbuddy-bridge'))
    const parent = path.replace(/[\\/][^\\/]+$/, '')
    if (parent === path) break
    path = parent
  }
  return [...new Set(out)]
}

/** 解析桥接目录与两个实例（port/token）。结果缓存，改设置时清空。 */
async function resolveInstances() {
  if (instancesPromise !== null) return instancesPromise
  instancesPromise = (async () => {
    const profile = await host.request('config.get', { key: 'profile' }).catch(() => null)
    const candidates = candidateBridgeDirs(profile?.home)
    if (candidates.length === 0) throw new Error('无法定位桥接目录，请在设置里手动填写')

    const failures = []
    for (const dir of candidates) {
      const list = []
      for (const variant of VARIANTS) {
        try {
          const config = JSON.parse(await readText(joinPath(dir, variant.file)))
          const port = Number(config?.port)
          const token = String(config?.token ?? '')
          if (!Number.isFinite(port) || token === '') throw new Error('配置缺少 port/token')
          list.push({ ...variant, dir, port, token })
        } catch (error) {
          const message = String(error?.message ?? error)
          list.push({ ...variant, dir, error: message })
          failures.push(`${dir}${variant.file}: ${message}`)
        }
      }
      if (list.some((instance) => instance.error === undefined)) return list
    }
    throw new Error(`未找到桥接配置：${failures.slice(0, 2).join('；')}`)
  })()
  instancesPromise.catch(() => { instancesPromise = null })
  return instancesPromise
}

function resetInstances() {
  instancesPromise = null
}

async function fetchVariant(instance, { refresh = false } = {}) {
  if (instance.error !== undefined) throw new Error(instance.error)
  const url = `http://127.0.0.1:${instance.port}/v1/status${refresh ? '?refresh=1' : ''}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${instance.token}` },
    cache: 'no-store'
  })
  if (!response.ok) throw new Error(`桥接返回 HTTP ${response.status}`)
  return await response.json()
}

function rebuildIndex(instances, results) {
  for (const key of Object.keys(modelIndex)) delete modelIndex[key]
  for (const instance of instances) {
    const result = results[instance.key]
    if (result?.ok !== true) continue
    const rows = Array.isArray(result.data?.models) ? result.data.models : []
    for (const slug of instance.providerSlugs) {
      const table = modelIndex[slug] ?? Object.create(null)
      for (const row of rows) {
        if (typeof row?.id === 'string') table[row.id] = row
      }
      modelIndex[slug] = table
    }
  }
}

async function loadSnapshot({ refresh = false } = {}) {
  const instances = await resolveInstances()
  const results = {}
  await Promise.all(instances.map(async (instance) => {
    try {
      results[instance.key] = { ok: true, data: await fetchVariant(instance, { refresh }) }
    } catch (error) {
      results[instance.key] = { ok: false, error: String(error?.message ?? error) }
    }
  }))
  rebuildIndex(instances, results)
  return { fetchedAt: Date.now(), instances, results }
}

/** provider slug（可能是 `custom:xxx`）→ 该 provider 下的模型展示行。 */
function lookupModel(provider, model) {
  const slug = String(provider || '').trim()
  const id = String(model || '').trim()
  if (slug === '' || id === '') return null
  const index = indexFromCache()
  const direct = index[slug]?.[id]
  if (direct) return direct
  const bare = slug.startsWith('custom:') ? slug.slice('custom:'.length) : `custom:${slug}`
  return index[bare]?.[id] ?? null
}

/** 聚焦会话的模型行：会话 provider 已知就用它；未知时退回唯一命中的目录
 *  （两版共有的 id 不猜，宁可不显示倍率也不显示错倍率）。 */
function lookupFocusedModel(id) {
  const sessionId = typeof host.state?.focusedSessionId?.get === 'function'
    ? host.state.focusedSessionId.get()
    : null
  const known = typeof sessionId === 'string' && sessionId !== '' ? providerBySession[sessionId] : ''
  // 只有草稿态（没有会话 id）才用 profile 当前 provider 兜底：
  // 已知会话一律按它自己的 provider 判定，避免把别的 provider 的模型算错倍率。
  const provider = known || (sessionId ? '' : lastProvider)
  if (provider !== '') {
    const row = lookupModel(provider, id)
    if (row) return row
  }
  const index = indexFromCache()
  const hits = []
  for (const key of Object.keys(index)) {
    const row = index[key]?.[id]
    if (row && !hits.includes(row)) hits.push(row)
  }
  return hits.length === 1 ? hits[0] : null
}

/** 从 host 读当前 provider（`model.options` 是权威来源）：插件刚加载、
 *  session.info 还没来的时候，pill 也能立刻显示倍率。 */
async function syncProviderFromHost() {
  try {
    const sessionId = typeof host.state?.focusedSessionId?.get === 'function'
      ? host.state.focusedSessionId.get()
      : null
    const params = typeof sessionId === 'string' && sessionId !== '' ? { session_id: sessionId } : {}
    const options = await host.request('model.options', params)
    const provider = typeof options?.provider === 'string' ? options.provider.trim() : ''
    if (provider === '') return
    lastProvider = provider
    if (typeof sessionId === 'string' && sessionId !== '') {
      providerBySession[sessionId] = provider
      persistProviderMap()
    }
    syncPillContribution()
  } catch { /* 拿不到就等 session.info */ }
}

/** 一行徽章文本：倍率 + 促销标签（`x0.79 · 夜间折扣`）。 */
function rateText(row) {
  if (!row) return ''
  const parts = []
  if (row.rateUnknown === true) parts.push('价格未知')
  else if (typeof row.multiplier === 'string' && row.multiplier !== '') parts.push(row.multiplier)
  for (const badge of Array.isArray(row.badges) ? row.badges : []) parts.push(String(badge))
  return parts.join(' · ')
}

/** 输入框 pill 的标签：模型名 + 倍率（拿不到倍率时返回 null，核心标签照常）。 */
function pillLabel({ model }) {
  const slug = String(model ?? '').trim()
  if (slug === '') return null
  const row = lookupFocusedModel(slug)
  if (!row) return null
  const rate = row.free === true
    ? '免费'
    : row.rateUnknown === true
      ? '价格未知'
      : (typeof row.multiplier === 'string' ? row.multiplier : '')
  if (rate === '') return null
  return `${row.name ?? slug} · ${rate}`
}

/** 注册（或重注册）pill 贡献。重注册会通知该区域 → pill 立刻用上新的倍率。 */
function syncPillContribution() {
  if (ctxRef === null) return
  pillDisposer?.()
  pillDisposer = ctxRef.register({
    id: 'pill-rate',
    area: COMPOSER_AREAS.modelPill,
    data: { label: pillLabel }
  })
}

function useStatusQuery() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => loadSnapshot({}),
    staleTime: 60_000,
    retry: 0,
    refetchOnWindowFocus: false
  })
}

/** 手动刷新：强制桥接重新查询计费接口（?refresh=1）。 */
function useRefresh() {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    setBusy(true)
    try {
      const data = await loadSnapshot({ refresh: true })
      client.setQueryData(QUERY_KEY, data)
      syncPillContribution()
    } finally {
      setBusy(false)
    }
  }
  return { busy, refresh }
}

// ─────────────────────────── UI ───────────────────────────

const muted = { color: 'var(--ui-text-tertiary)' }
const faint = { color: 'var(--ui-text-quaternary)' }

function Row({ label, children }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-3 text-xs',
    children: [
      jsx('span', { style: muted, children: label }),
      jsx('span', { className: 'truncate text-right tabular-nums', children })
    ]
  })
}

function VariantBlock({ instance, result, onRefresh, busy, expanded }) {
  const data = result?.ok === true ? result.data : null
  const credits = data?.credits ?? null
  const accounts = Array.isArray(credits?.accounts) ? credits.accounts : []
  const promoRows = (Array.isArray(data?.models) ? data.models : []).filter(
    (row) => (Array.isArray(row.badges) && row.badges.length > 0) || row.free === true
  )

  const header = jsxs('div', {
    className: 'flex items-center justify-between gap-2',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1.5 text-xs font-medium',
        children: [
          jsx(Codicon, { name: 'credit-card', size: '0.875rem' }),
          jsx('span', { children: instance.title })
        ]
      }),
      result?.ok === true
        ? jsx(Badge, { variant: 'muted', children: `${formatNumber(credits?.total)} 积分` })
        : jsx(Badge, { variant: 'destructive', children: '不可用' })
    ]
  })

  if (result?.ok !== true) {
    return jsxs('div', {
      className: 'flex flex-col gap-1.5 px-3 py-2',
      children: [
        header,
        jsx('div', { className: 'text-xs', style: muted, children: result?.error ?? '尚未加载' })
      ]
    })
  }

  const detailRows = [
    jsx(Row, {
      label: '账号',
      children: data?.account?.uid ? String(data.account.uid).slice(0, 13) + '…' : '未登录'
    }, 'account'),
    jsx(Row, {
      label: '令牌有效期',
      children: typeof data?.account?.expiresAt === 'string'
        ? relativeTime(Date.parse(data.account.expiresAt))
        : '—'
    }, 'token'),
    credits?.unlimited === true
      ? jsx(Row, { label: '额度', children: '不限量' }, 'unlimited')
      : null,
    typeof credits?.cycleResetTime === 'string'
      ? jsx(Row, { label: '周期重置', children: credits.cycleResetTime }, 'cycle')
      : null
  ].filter(Boolean)

  const packages = accounts.map((account, index) => jsxs('div', {
    className: 'flex items-baseline justify-between gap-3 text-xs',
    children: [
      jsx('span', { className: 'truncate', style: muted, children: account?.packageName ?? '套餐' }),
      jsxs('span', {
        className: 'shrink-0 tabular-nums',
        children: [
          jsx('span', { children: `${formatNumber(account?.remain)} / ${formatNumber(account?.size)}` }),
          account?.endTimeMs ? jsx('span', { style: faint, children: ` · ${formatUntil(account.endTimeMs)}到期` }) : null
        ]
      })
    ]
  }, `pkg-${index}`))

  const promos = expanded
    ? (Array.isArray(data?.models) ? data.models : []).map((row, index) => jsxs('div', {
        className: 'flex items-baseline justify-between gap-3 text-xs',
        children: [
          jsx('span', { className: 'truncate', children: row?.name ?? row?.id }),
          jsx('span', { className: 'shrink-0 tabular-nums', style: muted, children: rateText(row) || '—' })
        ]
      }, `model-${index}`))
    : promoRows.map((row, index) => jsxs('div', {
        className: 'flex items-baseline justify-between gap-3 text-xs',
        children: [
          jsx('span', { className: 'truncate', children: row?.name ?? row?.id }),
          jsx('span', { className: 'shrink-0 tabular-nums', style: muted, children: rateText(row) })
        ]
      }, `promo-${index}`))

  return jsxs('div', {
    className: 'flex flex-col gap-2 px-3 py-2',
    children: [
      header,
      jsxs('div', { className: 'flex flex-col gap-1', children: detailRows }),
      packages.length > 0
        ? jsxs(Fragment, {
            children: [
              jsx(Separator, { className: 'my-0.5' }),
              jsx('div', { className: 'text-[11px] font-medium', style: muted, children: '套餐余量' }),
              jsx('div', { className: 'flex flex-col gap-1', children: packages })
            ]
          })
        : null,
      promos.length > 0
        ? jsxs(Fragment, {
            children: [
              jsx(Separator, { className: 'my-0.5' }),
              jsx('div', {
                className: 'text-[11px] font-medium',
                style: muted,
                children: expanded ? '全部模型倍率' : '优惠中 / 免费模型'
              }),
              jsx('div', { className: 'flex flex-col gap-1', children: promos })
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 pt-0.5',
        children: [
          jsx('span', { className: 'text-[11px]', style: faint, children: data?.creditsFetchedAt ? `更新于 ${relativeTime(Date.parse(data.creditsFetchedAt))}` : '未查询' }),
          onRefresh
            ? jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                disabled: busy === true,
                onClick: () => { void onRefresh() },
                children: busy === true ? jsx(GlyphSpinner, { spinner: 'braille' }) : '刷新'
              })
            : null
        ]
      }),
      data?.creditsError
        ? jsx('div', { className: 'text-[11px]', style: { color: 'var(--ui-danger, var(--ui-text-tertiary))' }, children: `积分读取失败：${data.creditsError}` })
        : null
    ]
  })
}

function summaryText(snapshot, error) {
  if (!snapshot) return error ? '积分不可用' : '积分…'
  return snapshot.instances
    .map((instance) => {
      const result = snapshot.results?.[instance.key]
      if (result?.ok !== true) return `${instance.label} ✕`
      return `${instance.label} ${formatNumber(result.data?.credits?.total)}`
    })
    .join(' · ')
}

function StatusChip() {
  const query = useStatusQuery()
  const { busy, refresh } = useRefresh()
  const snapshot = query.data
  const loading = query.isPending === true && !snapshot

  return jsx(DropdownMenu, {
    children: jsxs(Fragment, {
      children: [
        jsx(DropdownMenuTrigger, {
          asChild: true,
          children: jsxs('button', {
            type: 'button',
            title: 'WorkBuddy 剩余积分（点击查看明细）',
            className: 'flex h-full items-center gap-1 px-1 hover:text-foreground',
            children: [
              busy || loading
                ? jsx(GlyphSpinner, { spinner: 'braille', className: 'opacity-60' })
                : jsx(Codicon, { name: 'credit-card', size: '0.8125rem' }),
              jsx('span', { className: 'tabular-nums', children: summaryText(snapshot, query.error) })
            ]
          })
        }),
        jsx(DropdownMenuContent, {
          align: 'end',
          className: 'w-96 p-0',
          children: jsxs('div', {
            className: 'flex flex-col',
            children: [
              jsx(ScrollArea, {
                className: 'max-h-96',
                children: jsxs('div', {
                  className: 'flex flex-col',
                  children: (snapshot?.instances ?? VARIANTS).flatMap((instance, index) => {
                    const block = jsx(VariantBlock, {
                      instance,
                      result: snapshot?.results?.[instance.key],
                      onRefresh: refresh,
                      busy
                    }, instance.key)
                    return index === 0 ? [block] : [jsx(Separator, {}, `${instance.key}-sep`), block]
                  })
                })
              }),
              jsx(DropdownMenuSeparator, {}),
              jsxs('div', {
                className: 'flex items-center justify-between gap-2 px-3 py-2',
                children: [
                  jsx('span', { className: 'text-[11px]', style: faint, children: '倍率仅为展示，不影响实际计费' }),
                  jsx(Button, {
                    size: 'xs',
                    variant: 'ghost',
                    onClick: () => { host.navigate(pluginSettingsHref('workbuddy:details')) },
                    children: '详情设置'
                  })
                ]
              })
            ]
          })
        })
      ]
    })
  })
}

function SettingsPage() {
  const query = useStatusQuery()
  const { busy, refresh } = useRefresh()
  const [dir, setDir] = useState(() => bridgeDirSetting())

  const saveDir = () => {
    const next = dir.trim()
    if (storage) storage.set(BRIDGE_DIR_KEY, next)
    resetInstances()
    void refresh()
  }

  const snapshot = query.data
  const instances = snapshot?.instances ?? VARIANTS

  return jsxs('div', {
    className: 'flex flex-col gap-3 p-4 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: 'WorkBuddy 剩余积分与模型倍率' }),
          jsx(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: busy,
            onClick: () => { void refresh() },
            children: busy ? '刷新中…' : '刷新'
          })
        ]
      }),
      jsx('div', {
        className: 'text-xs',
        style: muted,
        children: '数据来自插件自带的 WorkBuddy 桥接（/v1/status）。积分每次刷新都会真实查询 WorkBuddy 计费接口，桥接端默认缓存 60 秒。'
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1 rounded border p-2',
        style: { borderColor: 'var(--ui-stroke-secondary)' },
        children: [
          jsx('div', { className: 'text-[11px] font-medium', style: muted, children: '桥接目录（留空 = 自动：%LOCALAPPDATA%\\hermes-workbuddy-bridge）' }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('input', {
                className: 'h-7 min-w-0 flex-1 rounded border bg-transparent px-2 text-xs',
                style: { borderColor: 'var(--ui-stroke-secondary)' },
                placeholder: snapshot?.instances?.[0]?.dir ?? '',
                value: dir,
                onChange: (event) => setDir(event.target.value)
              }),
              jsx(Button, { size: 'xs', variant: 'outline', onClick: saveDir, children: '保存并刷新' })
            ]
          })
        ]
      }),
      jsx('div', {
        className: 'flex flex-col rounded border',
        style: { borderColor: 'var(--ui-stroke-secondary)' },
        children: instances.flatMap((instance, index) => {
          const block = jsx(VariantBlock, {
            instance,
            result: snapshot?.results?.[instance.key],
            onRefresh: refresh,
            busy,
            expanded: true
          }, instance.key)
          return index === 0 ? [block] : [jsx(Separator, {}, `${instance.key}-sep`), block]
        })
      }),
      jsx('div', {
        className: 'text-[11px]',
        style: faint,
        children: '展示位置：状态栏右侧积分徽章 · 模型菜单每行的倍率/促销徽章 · 输入框模型名后的倍率。'
      })
    ]
  })
}

// ─────────────────────────── 插件 ───────────────────────────

export default {
  id: 'workbuddy',
  name: 'WorkBuddy 积分与倍率',
  register(ctx) {
    storage = ctx.storage ?? null
    ctxRef = ctx
    restoreProviderMap()

    // 会话 provider 映射：模型 pill 只在该会话走 WorkBuddy provider 时追加倍率
    ctx.onEvent('session.info', (event) => {
      const payload = event?.payload
      const sessionId = typeof event?.session_id === 'string' ? event.session_id : payload?.session_id
      const provider = payload?.provider
      if (typeof sessionId === 'string' && sessionId !== '' && typeof provider === 'string' && provider !== '') {
        providerBySession[sessionId] = provider
        lastProvider = provider
        persistProviderMap()
      }
    })

    // 1) 状态栏：剩余积分
    ctx.register({
      id: 'credits',
      area: STATUSBAR_AREAS.right,
      order: 120,
      toggleLabel: 'WorkBuddy 积分',
      render: () => jsx(StatusChip, {})
    })

    // 2) 模型菜单：每行尾部显示倍率 + 促销徽章
    ctx.register({
      id: 'model-rate',
      area: MODEL_MENU_ROW_AREA,
      data: {
        decorate: ({ provider, model }) => {
          const row = lookupModel(provider, model)
          const text = rateText(row)
          return text === '' ? null : { badge: text }
        }
      }
    })

    // 3) 输入框模型 pill：当前会话走 WorkBuddy 时在模型名后追加倍率。
    //    先注册（数据未到时 label 返回 null，核心标签照常），数据到位后重注册一次
    //    让该区域重新解析 —— pill 的 useMemo 不会因为索引变化自己重算。
    syncPillContribution()

    // 4) ⌘K 命令：手动刷新积分
    ctx.register({
      id: 'refresh',
      area: PALETTE_AREA,
      data: {
        id: 'workbuddy-status.refresh',
        label: '刷新 WorkBuddy 积分',
        keywords: ['workbuddy', '积分', 'credits', '倍率'],
        run: async () => {
          const data = await loadSnapshot({ refresh: true })
          queryClient.setQueryData(QUERY_KEY, data)
          syncPillContribution()
          const total = data.instances
            .map((instance) => {
              const result = data.results[instance.key]
              return result?.ok === true
                ? `${instance.label} ${formatNumber(result.data?.credits?.total)}`
                : `${instance.label} ✕`
            })
            .join(' · ')
          host.notify({ kind: 'info', message: `WorkBuddy 积分：${total}` })
        }
      }
    })

    // 5) 设置 → 插件：明细页
    ctx.registerSettingsPage?.({
      id: 'details',
      title: 'WorkBuddy 状态',
      icon: 'credit-card',
      render: () => jsx(SettingsPage, {})
    })

    // 6) 挂载即取一次数据（与状态栏共用 react-query 缓存，不会重复请求）。
    //    同时问一次 host 当前的 provider（权威来源），拿到后重注册 pill 贡献，
    //    让倍率立刻出现在输入框模型名后面。
    void syncProviderFromHost()
    void queryClient
      .ensureQueryData({ queryKey: QUERY_KEY, queryFn: () => loadSnapshot({}), staleTime: 60_000 })
      .then(() => syncPillContribution())
      .catch(() => { /* 桥接不可用时状态栏会显示错误 */ })
  }
}
