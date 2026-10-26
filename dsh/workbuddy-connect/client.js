/**
 * WorkBuddy Connect 的 Client 半。
 *
 * 1) 输入框下方：两个变体的剩余积分徽章，点开看套餐余量与模型倍率；
 * 2) 设置 → 插件 → WorkBuddy：账号、令牌有效期、积分、套餐与全量模型表；
 * 3) 模型选择器（trigger / 菜单当前值 / 菜单行）：模型名后追加倍率与促销徽章。
 *
 * 数据来自 Host 半的同源接口 /workbuddy/status（令牌不出 Host）。
 * 文案走 Client locale 服务（namespace: workbuddy）。
 */
window.__ModuleLoader__.load({
  id: 'workbuddy-connect',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'workbuddy';
    const SHORT = { workbuddy: 'WB', 'workbuddy-ai': 'WB AI' };
    const PROVIDERS = new Set(['workbuddy', 'workbuddy-ai']);

    const EN = {
      title: 'WorkBuddy credits & rates',
      credits: 'credits',
      unlimited: 'unlimited',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      rateUnknown: 'price unknown',
      free: 'free',
      footer: 'Rates are display-only and do not change billing.',
      settingsTitle: 'WorkBuddy connection',
      settingsHint: 'Models come through the local bridge; account, token, credits and rates are read from it.',
      account: 'Account',
      signIn: 'Sign-in',
      tokenExpiry: 'Token expires',
      catalog: 'Model catalog',
      contextPolicy: 'Context policy',
      contextPolicyMax: 'Use the largest available window',
      contextPolicyDefault: 'Use the upstream default window',
      creditsUpdated: 'Credits updated',
      packages: 'Plan balance',
      allModels: 'All models',
      model: 'Model',
      context: 'Context',
      rate: 'Rate',
      badges: 'Notes',
      remainingDays: 'in {days} days',
      expired: 'expired',
      readFailed: 'Failed to read',
      empty: 'No data yet (bridge not running or not signed in)',
      notInPlan: 'Not available',
    };

    const ZH = {
      title: 'WorkBuddy 余量与倍率',
      credits: '积分',
      unlimited: '不限量',
      refresh: '刷新',
      refreshing: '刷新中…',
      rateUnknown: '价格未知',
      free: '免费',
      footer: '倍率仅用于展示，不影响实际计费。',
      settingsTitle: 'WorkBuddy 接入状态',
      settingsHint: '模型通过本地桥接接入；这里展示桥接读到的账号、令牌、积分与模型倍率。',
      account: '账号',
      signIn: '登录态',
      tokenExpiry: '令牌有效期',
      catalog: '模型目录',
      contextPolicy: '上下文策略',
      contextPolicyMax: '使用可选最大窗口',
      contextPolicyDefault: '使用上游默认窗口',
      creditsUpdated: '积分更新',
      packages: '套餐余量',
      allModels: '全部模型',
      model: '模型',
      context: '上下文',
      rate: '倍率',
      badges: '备注',
      remainingDays: '剩余 {days} 天',
      expired: '已过期',
      readFailed: '读取失败',
      empty: '还没有数据（桥接未启动或未登录）',
      notInPlan: '不可用',
    };

    let translate = null;
    function t(key, fallback) {
      if (translate === null) return fallback;
      try {
        const value = translate(key);
        return typeof value === 'string' && value !== '' && value !== key ? value : fallback;
      } catch {
        return fallback;
      }
    }

    // ─────────────────────────── 共享状态 ───────────────────────────
    // 模型菜单行可能一次渲染十几个，必须共享一次请求，不能每行各发一个。
    const store = { data: null, error: '', busy: false, loaded: false, inflight: null, listeners: new Set() };

    function notify() {
      for (const listener of store.listeners) {
        try { listener(); } catch { /* 单个订阅者出错不影响其它 */ }
      }
    }

    function refresh(force) {
      if (!force && store.inflight !== null) return store.inflight;
      store.busy = true;
      notify();
      store.inflight = (async () => {
        try {
          const response = await fetch(`/workbuddy/status${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          store.data = await response.json();
          store.error = '';
        } catch (failure) {
          store.error = String((failure && failure.message) || failure).slice(0, 160);
        } finally {
          store.busy = false;
          store.loaded = true;
          store.inflight = null;
          notify();
        }
      })();
      return store.inflight;
    }

    function useStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const listener = () => force((value) => value + 1);
        store.listeners.add(listener);
        if (!store.loaded) void refresh(false);
        return () => { store.listeners.delete(listener); };
      }, []);
      return store;
    }

    // ─────────────────────────── 小工具 ───────────────────────────
    const number = (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';

    const contextText = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
      return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}K`;
    };

    const expiryText = (iso) => {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return String(iso || '—');
      const days = Math.round((ms - Date.now()) / 86_400_000);
      const when = new Date(ms).toLocaleString();
      return days >= 0
        ? `${when}（${t('remainingDays', '剩余 {days} 天').replace('{days}', String(days))}）`
        : `${when}（${t('expired', '已过期')}）`;
    };

    const rateText = (model) => {
      if (!model) return '';
      if (model.rateUnknown === true) return t('rateUnknown', '价格未知');
      if (model.free === true) return t('free', '免费');
      const parts = [];
      if (typeof model.multiplier === 'string' && model.multiplier !== '') parts.push(model.multiplier);
      for (const badge of Array.isArray(model.badges) ? model.badges : []) parts.push(String(badge));
      return parts.join(' · ');
    };

    const creditText = (credits) => {
      if (!credits) return '—';
      if (credits.unlimited === true) return t('unlimited', '不限量');
      return `${number(credits.total)} ${t('credits', '积分')}`;
    };

    const variantFor = (key) => {
      const variants = store.data && Array.isArray(store.data.variants) ? store.data.variants : [];
      return variants.find((variant) => variant.key === key) || null;
    };

    const modelRateFor = (providerId, modelId) => {
      const variant = variantFor(providerId);
      if (!variant || variant.ok !== true) return null;
      const models = Array.isArray(variant.models) ? variant.models : [];
      return models.find((model) => model.id === modelId) || null;
    };

    // ─────────────────────────── 样式 ───────────────────────────
    const style = {
      row: {
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        fontSize: '11px', lineHeight: '18px', color: 'inherit', opacity: 0.85,
        padding: '2px 2px 0',
      },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        border: '1px solid rgba(127,127,127,0.35)', borderRadius: '999px',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
        padding: '0 8px', height: '20px', fontSize: '11px', lineHeight: '18px',
      },
      chipBad: { borderStyle: 'dashed', opacity: 0.6 },
      muted: { opacity: 0.6 },
      panel: {
        marginTop: '4px', border: '1px solid rgba(127,127,127,0.3)', borderRadius: '8px',
        padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '8px',
        background: 'rgba(127,127,127,0.06)', maxWidth: '520px',
      },
      sectionTitle: { fontSize: '11px', fontWeight: 600, opacity: 0.75 },
      cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' },
      line: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '11px' },
      refresh: {
        border: '1px solid rgba(127,127,127,0.35)', borderRadius: '6px', background: 'transparent',
        color: 'inherit', cursor: 'pointer', fontSize: '11px', height: '22px', padding: '0 10px',
      },
      page: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0', fontSize: '12px' },
      pageHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' },
      title: { fontSize: '13px', fontWeight: 600 },
      card: {
        border: '1px solid rgba(127,127,127,0.3)', borderRadius: '8px', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: '8px',
      },
      grid: { display: 'grid', gridTemplateColumns: '1.6fr 90px 140px 110px', gap: '4px 10px', fontSize: '11px' },
      gridHead: { fontWeight: 600, opacity: 0.6 },
      scroll: { maxHeight: '240px', overflowY: 'auto' },
      kv: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 10px', fontSize: '11px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
    };

    // ─────────────────────────── 模型标签装饰 ───────────────────────────
    /**
     * 占据 conversation.input.model.label：同一席位同时服务
     * trigger（输入框里的当前模型）、menu（菜单当前值）、option（菜单里的每行模型）。
     * 非 WorkBuddy provider 原样显示目录名，不叠加任何东西。
     */
    function ModelLabel(props) {
      // hooks 必须无条件按同一顺序调用，否则 provider 切换时会触发 hook 顺序错误
      useStore();
      try {
        const providerId = props && props.provider ? String(props.provider.id || '') : '';
        const model = (props && props.model) || {};
        const base = String(model.name || model.displayName || model.id || '');
        if (!PROVIDERS.has(providerId)) return h('span', null, base);
        const rate = rateText(modelRateFor(providerId, String(model.id || '')));
        if (rate === '') return h('span', null, base);
        return h('span', { style: { whiteSpace: 'nowrap' } }, [
          h('span', { key: 'n' }, base),
          h('span', { key: 'sep', style: style.muted }, ' · '),
          h('span', { key: 'r', style: style.muted }, rate),
        ]);
      } catch {
        const model = (props && props.model) || {};
        return h('span', null, String(model.name || model.id || ''));
      }
    }

    // ─────────────────────────── 输入框积分徽章 ───────────────────────────
    function VariantChip({ variant, onOpen }) {
      const bad = variant.ok !== true;
      const title = bad
        ? `${variant.label}：${variant.error || t('notInPlan', '不可用')}`
        : `${variant.label} ${creditText(variant.credits)}`;
      const label = SHORT[variant.key] || variant.label || variant.key;
      const total = bad
        ? '✕'
        : (variant.credits && variant.credits.unlimited === true ? '∞' : number(variant.credits && variant.credits.total));
      return h('button', {
        type: 'button', title, onClick: onOpen,
        style: bad ? Object.assign({}, style.chip, style.chipBad) : style.chip,
      }, [
        h('span', { key: 'label', style: style.muted }, label),
        h('span', { key: 'total', style: { fontVariantNumeric: 'tabular-nums' } }, total),
      ]);
    }

    function Dock() {
      const state = useStore();
      const [open, setOpen] = React.useState(false);
      const variants = state.data && Array.isArray(state.data.variants) ? state.data.variants : [];
      if (variants.length === 0 && state.error === '' && state.data === null) return null;

      const chips = variants.map((variant) =>
        h(VariantChip, { key: variant.key, variant, onOpen: () => setOpen((value) => !value) }),
      );
      if (variants.length === 0 && state.error !== '') {
        chips.push(h('span', {
          key: 'err', title: state.error,
          style: Object.assign({}, style.chip, style.chipBad),
        }, 'WorkBuddy ✕'));
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column' } }, [
        h('div', { key: 'chips', style: style.row }, chips),
        open
          ? h('div', { key: 'panel', style: style.panel }, [
              h('div', { key: 'bar', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
                h('span', { key: 't', style: style.sectionTitle }, t('title', 'WorkBuddy 余量与倍率')),
                h('button', {
                  key: 'r', type: 'button', style: style.refresh, disabled: state.busy,
                  onClick: () => { void refresh(true); },
                }, state.busy ? t('refreshing', '刷新中…') : t('refresh', '刷新')),
              ]),
              ...variants.map((variant) => h('div', { key: variant.key, style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
                h('div', { key: 'h', style: style.line }, [
                  h('span', { key: 'n', style: style.sectionTitle }, variant.label || variant.key),
                  h('span', { key: 'v', style: variant.ok === true ? {} : style.muted },
                    variant.ok === true ? creditText(variant.credits) : (variant.error || t('notInPlan', '不可用'))),
                ]),
                variant.ok === true
                  ? h('div', { key: 'm', style: Object.assign({}, style.muted, style.line) }, [
                      h('span', { key: 'x' }, t('packages', '套餐余量')),
                      h('span', { key: 'y' }, (variant.models || [])
                        .filter((model) => (model.badges || []).length > 0 || model.free === true)
                        .slice(0, 4).map(rateText).filter(Boolean).join(' · ') || '—'),
                    ])
                  : null,
              ])),
              h('div', { key: 'foot', style: Object.assign({}, style.line, style.muted) }, [
                h('span', { key: 'hint' }, t('footer', '倍率仅用于展示，不影响实际计费。')),
                h('span', { key: 'at' }, state.data && state.data.fetchedAt
                  ? new Date(state.data.fetchedAt).toLocaleTimeString() : ''),
              ]),
            ])
          : null,
      ]);
    }

    // ─────────────────────────── 设置页 ───────────────────────────
    function ModelTable({ models, policy }) {
      const contextCell = (model) => {
        const choices = Array.isArray(model.supportedContextWindows) ? model.supportedContextWindows : [];
        if (choices.length < 2) return contextText(model.contextWindow);
        const options = choices.map((value) => contextText(value)).join(' / ');
        const effective = policy === 'max' ? Math.max(...choices) : model.contextWindow;
        return `${contextText(effective)}（${options}）`;
      };
      return h('div', { style: style.scroll }, [
        h('div', { key: 'head', style: Object.assign({}, style.grid, style.gridHead) }, [
          h('span', { key: 'n' }, t('model', '模型')),
          h('span', { key: 'c' }, t('context', '上下文')),
          h('span', { key: 'r' }, t('rate', '倍率')),
          h('span', { key: 'b' }, t('badges', '备注')),
        ]),
        ...models.map((model) => h('div', { key: model.id, style: style.grid }, [
          h('span', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: model.id }, model.name || model.id),
          h('span', { key: 'c', style: style.muted }, contextCell(model)),
          h('span', { key: 'r' }, rateText(model) || '—'),
          h('span', { key: 'b', style: style.muted }, (model.badges || []).join(' / ')),
        ])),
      ]);
    }

    function VariantCard({ variant }) {
      const bad = variant.ok !== true;
      const credits = variant.credits || {};
      const packages = Array.isArray(credits.packages) ? credits.packages : [];
      const models = Array.isArray(variant.models) ? variant.models : [];
      const account = variant.account || {};

      const header = h('div', { key: 'head', style: style.cardHead }, [
        h('div', { key: 't', style: { display: 'flex', gap: '8px', alignItems: 'baseline' } }, [
          h('span', { key: 'n', style: { fontWeight: 600 } }, variant.label || variant.key),
          h('span', { key: 's', style: Object.assign({}, style.muted, { fontSize: '11px' }) },
            variant.signIn || (bad ? variant.error : '')),
        ]),
        h('span', { key: 'c', style: { fontSize: '12px', fontVariantNumeric: 'tabular-nums' } }, creditText(variant.credits)),
      ]);

      if (bad) {
        return h('div', { style: style.card }, [header, h('div', { style: style.muted }, variant.error || t('notInPlan', '不可用'))]);
      }

      const kv = h('div', { key: 'kv', style: style.kv }, [
        h('span', { key: 'a1', style: style.muted }, t('account', '账号')),
        h('span', { key: 'a2', style: style.mono }, account.uid
          ? `${String(account.uid).slice(0, 12)}…${account.domain ? ` @ ${account.domain}` : ''}`
          : '—'),
        h('span', { key: 'e1', style: style.muted }, t('tokenExpiry', '令牌有效期')),
        h('span', { key: 'e2' }, expiryText(account.expiresAt)),
        h('span', { key: 'm1', style: style.muted }, t('catalog', '模型目录')),
        h('span', { key: 'm2' }, `${variant.catalogSource || '—'} · ${models.length}`),
        h('span', { key: 'p1', style: style.muted }, t('contextPolicy', '上下文策略')),
        h('span', { key: 'p2' }, variant.contextWindowPolicy === 'max'
          ? t('contextPolicyMax', '使用可选最大窗口')
          : t('contextPolicyDefault', '使用上游默认窗口')),
        h('span', { key: 'c1', style: style.muted }, t('creditsUpdated', '积分更新')),
        h('span', { key: 'c2' }, variant.creditsFetchedAt ? new Date(variant.creditsFetchedAt).toLocaleString() : '—'),
      ]);

      const packagesBlock = packages.length === 0 ? null : h('div', { key: 'pkgs', style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
        h('div', { key: 't', style: Object.assign({}, style.sectionTitle, { marginBottom: '2px' }) }, t('packages', '套餐余量')),
        ...packages.map((pkg, index) => h('div', { key: `p${index}`, style: style.line }, [
          h('span', { key: 'n', style: style.muted }, pkg.name || '—'),
          h('span', { key: 'v', style: { fontVariantNumeric: 'tabular-nums' } },
            `${number(pkg.remain)} / ${number(pkg.size)}` + (pkg.endTimeMs ? ` · ${new Date(pkg.endTimeMs).toLocaleDateString()}` : '')),
        ])),
      ]);

      return h('div', { style: style.card }, [
        header, kv,
        packagesBlock,
        h('div', { key: 'models', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
          h('div', { key: 't', style: style.sectionTitle }, t('allModels', '全部模型')),
          h(ModelTable, { key: 'tbl', models, policy: variant.contextWindowPolicy }),
        ]),
      ]);
    }

    function SettingsPage() {
      const state = useStore();
      const variants = state.data && Array.isArray(state.data.variants) ? state.data.variants : [];
      return h('div', { style: style.page }, [
        h('div', { key: 'head', style: style.pageHead }, [
          h('div', { key: 't' }, [
            h('div', { key: 'title', style: style.title }, t('settingsTitle', 'WorkBuddy 接入状态')),
            h('div', { key: 'sub', style: Object.assign({}, style.muted, { fontSize: '11px' }) },
              t('settingsHint', '模型通过本地桥接接入；这里展示桥接读到的账号、令牌、积分与模型倍率。')),
          ]),
          h('button', {
            key: 'r', type: 'button', style: style.refresh, disabled: state.busy,
            onClick: () => { void refresh(true); },
          }, state.busy ? t('refreshing', '刷新中…') : t('refresh', '刷新')),
        ]),
        state.error !== ''
          ? h('div', { key: 'err', style: { color: 'var(--ui-danger, #d9534f)', fontSize: '11px' } },
              `${t('readFailed', '读取失败')}：${state.error}`)
          : null,
        variants.length === 0
          ? h('div', { key: 'empty', style: style.muted }, t('empty', '还没有数据（桥接未启动或未登录）'))
          : h('div', { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
              variants.map((variant) => h(VariantCard, { key: variant.key, variant }))),
        h('div', { key: 'foot', style: Object.assign({}, style.muted, { fontSize: '11px' }) },
          t('footer', '倍率仅用于展示，不影响实际计费。')),
      ]);
    }

    // ─────────────────────────── 装配 ───────────────────────────
    const BUILD = '2.1.0+label-locale';
    let activeLocale = 'en';

    function registerLocale(ctx) {
      let active = 'en';
      try {
        const snapshot = ctx.locale.getLocale();
        if (snapshot && typeof snapshot.active === 'string' && snapshot.active !== '') active = snapshot.active;
      } catch { /* 拿不到就用 en */ }
      activeLocale = active;
      const ids = new Set(['en', active]);
      for (const id of ids) {
        const dict = String(id).toLowerCase().startsWith('zh') ? ZH : EN;
        try {
          ctx.effect(() => ctx.locale.register(NS, id, dict));
        } catch { /* 重复注册或非法 tag：降级为内置文案 */ }
      }
      try {
        translate = ctx.locale.bind(NS);
      } catch {
        translate = null;
      }
    }

    /** 把本次 apply 的注册结果回报给 Host（/workbuddy/beacon 可查），用于区分"旧模块"与"注册失败"。 */
    function postBeacon(report) {
      try {
        void fetch('/workbuddy/client-beacon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            build: BUILD,
            locale: activeLocale,
            slots: report,
            href: typeof location === 'undefined' ? '' : String(location.href),
          }),
        }).catch(() => {});
      } catch { /* 诊断信息尽力而为 */ }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        registerLocale(ctx);

        const report = [];
        const inject = (slot, options, component) => {
          const entry = { slot, injected: false, registered: false, error: '' };
          report.push(entry);
          try {
            ctx.slots.inject(slot, () => {
              try {
                const dispose = ctx.slots.register(Object.assign({ name: slot }, options), component);
                entry.registered = true;
                return dispose;
              } catch (error) {
                entry.error = String((error && error.message) || error).slice(0, 200);
                throw error;
              }
            });
            entry.injected = true;
          } catch (error) {
            entry.error = String((error && error.message) || error).slice(0, 200);
          }
        };

        inject('conversation.composer.dock', { id: 'workbuddy-credits', order: 12 }, Dock);
        inject('settings.plugins.tab', { id: 'workbuddy', order: 20, label: 'WorkBuddy' }, SettingsPage);
        inject('conversation.input.model.label', {}, ModelLabel);

        // 只取一次：积分查询会真的打到计费接口，不做轮询；需要时用卡片上的"刷新"。
        void refresh(false);
        // 延迟一拍，等 inject 的延迟回调跑完再自报
        setTimeout(() => postBeacon(report), 0);
      },
    };
  },
});
