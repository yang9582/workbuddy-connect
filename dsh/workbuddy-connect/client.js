/**
 * WorkBuddy Connect 的 Client 半。
 *
 * 1) 输入框下方：两个变体的剩余积分徽章，点开看套餐余量与模型倍率；
 * 2) 设置 → 插件 → WorkBuddy：账号、令牌有效期、积分、套餐与全量模型表。
 *
 * 数据来自 Host 半的同源接口 /workbuddy/status（令牌不出 Host）。
 */
window.__ModuleLoader__.load({
  id: 'workbuddy-connect',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SHORT = { workbuddy: 'WB', 'workbuddy-ai': 'WB AI' };

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
      list: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '180px', overflowY: 'auto' },
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
      grid: { display: 'grid', gridTemplateColumns: '1.6fr 90px 110px 110px', gap: '4px 10px', fontSize: '11px' },
      gridHead: { fontWeight: 600, opacity: 0.6 },
      scroll: { maxHeight: '240px', overflowY: 'auto' },
      kv: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 10px', fontSize: '11px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
    };

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
      const when = new Date(ms).toLocaleString('zh-CN');
      return days >= 0 ? `${when}（剩余 ${days} 天）` : `${when}（已过期）`;
    };

    const rateText = (model) => {
      if (model.rateUnknown === true) return '价格未知';
      if (model.free === true) return '免费';
      const parts = [];
      if (typeof model.multiplier === 'string' && model.multiplier !== '') parts.push(model.multiplier);
      for (const badge of Array.isArray(model.badges) ? model.badges : []) parts.push(String(badge));
      return parts.join(' · ');
    };

    const creditText = (credits) => {
      if (!credits) return '—';
      if (credits.unlimited === true) return '不限量';
      return `${number(credits.total)} 积分`;
    };

    function useStatus() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async (refresh) => {
        setBusy(true);
        try {
          const response = await fetch(`/workbuddy/status${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setData(await response.json());
          setError('');
        } catch (failure) {
          setError(String((failure && failure.message) || failure).slice(0, 160));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        void load(false);
        const timer = setInterval(() => { if (alive) void load(false); }, 60_000);
        return () => { alive = false; clearInterval(timer); };
      }, [load]);

      return { data, error, busy, load };
    }

    function VariantChip({ variant, onOpen }) {
      const bad = variant.ok !== true;
      const title = bad
        ? `${variant.label}：${variant.error || '不可用'}`
        : `${variant.label} ${creditText(variant.credits)}（点击查看明细）`;
      const label = SHORT[variant.key] || variant.label || variant.key;
      const total = bad ? '✕' : (variant.credits && variant.credits.unlimited === true ? '∞' : number(variant.credits && variant.credits.total));
      return h('button', {
        type: 'button', title, onClick: onOpen,
        style: bad ? Object.assign({}, style.chip, style.chipBad) : style.chip,
      }, [
        h('span', { key: 'label', style: style.muted }, label),
        h('span', { key: 'total', style: { fontVariantNumeric: 'tabular-nums' } }, total),
      ]);
    }

    function ModelTable({ models }) {
      return h('div', { style: style.scroll }, [
        h('div', { key: 'head', style: Object.assign({}, style.grid, style.gridHead) }, [
          h('span', { key: 'n' }, '模型'), h('span', { key: 'c' }, '上下文'),
          h('span', { key: 'r' }, '倍率'), h('span', { key: 'b' }, '备注'),
        ]),
        ...models.map((model) => h('div', { key: model.id, style: style.grid }, [
          h('span', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: model.id }, model.name || model.id),
          h('span', { key: 'c', style: style.muted }, contextText(model.contextWindow)),
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
          h('span', { key: 's', style: Object.assign({}, style.muted, { fontSize: '11px' }) }, variant.signIn || (bad ? variant.error : '')),
        ]),
        h('span', { key: 'c', style: { fontSize: '12px', fontVariantNumeric: 'tabular-nums' } }, creditText(variant.credits)),
      ]);

      if (bad) {
        return h('div', { style: style.card }, [header, h('div', { style: style.muted }, variant.error || '不可用')]);
      }

      const kv = h('div', { key: 'kv', style: style.kv }, [
        h('span', { key: 'a1', style: style.muted }, '账号'),
        h('span', { key: 'a2', style: style.mono }, account.uid ? `${String(account.uid).slice(0, 12)}…${account.domain ? ` @ ${account.domain}` : ''}` : '未登录'),
        h('span', { key: 'e1', style: style.muted }, '令牌有效期'),
        h('span', { key: 'e2' }, expiryText(account.expiresAt)),
        h('span', { key: 'm1', style: style.muted }, '模型目录'),
        h('span', { key: 'm2' }, `${variant.catalogSource || '—'} · ${models.length} 个模型`),
        h('span', { key: 'c1', style: style.muted }, '积分更新'),
        h('span', { key: 'c2' }, variant.creditsFetchedAt ? new Date(variant.creditsFetchedAt).toLocaleString('zh-CN') : '—'),
      ]);

      const packagesBlock = packages.length === 0 ? null : h('div', { key: 'pkgs', style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
        h('div', { key: 't', style: Object.assign({}, style.sectionTitle, { marginBottom: '2px' }) }, '套餐余量'),
        ...packages.map((pkg, index) => h('div', { key: `p${index}`, style: style.line }, [
          h('span', { key: 'n', style: style.muted }, pkg.name || '套餐'),
          h('span', { key: 'v', style: { fontVariantNumeric: 'tabular-nums' } },
            `${number(pkg.remain)} / ${number(pkg.size)}` + (pkg.endTimeMs ? ` · ${new Date(pkg.endTimeMs).toLocaleDateString('zh-CN')} 到期` : '')),
        ])),
      ]);

      return h('div', { style: style.card }, [
        header, kv,
        packagesBlock,
        h('div', { key: 'models', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
          h('div', { key: 't', style: style.sectionTitle }, '全部模型'),
          h(ModelTable, { key: 'tbl', models }),
        ]),
      ]);
    }

    function Dock() {
      const { data, error, busy, load } = useStatus();
      const [open, setOpen] = React.useState(false);
      const variants = data && Array.isArray(data.variants) ? data.variants : [];
      if (variants.length === 0 && error === '' && data === null) return null;

      const chips = variants.map((variant) =>
        h(VariantChip, { key: variant.key, variant, onOpen: () => setOpen((value) => !value) }),
      );
      if (variants.length === 0 && error !== '') {
        chips.push(h('span', { key: 'err', style: Object.assign({}, style.chip, style.chipBad), title: error }, 'WorkBuddy ✕'));
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column' } }, [
        h('div', { key: 'chips', style: style.row }, chips),
        open
          ? h('div', { key: 'panel', style: style.panel }, [
              h('div', { key: 'bar', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
                h('span', { key: 't', style: style.sectionTitle }, 'WorkBuddy 余量与倍率'),
                h('button', { key: 'r', type: 'button', style: style.refresh, disabled: busy, onClick: () => { void load(true); } },
                  busy ? '刷新中…' : '刷新'),
              ]),
              ...variants.map((variant) => h('div', { key: variant.key, style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
                h('div', { key: 'h', style: style.line }, [
                  h('span', { key: 'n', style: style.sectionTitle }, variant.label || variant.key),
                  h('span', { key: 'v', style: variant.ok === true ? {} : style.muted }, variant.ok === true ? creditText(variant.credits) : (variant.error || '不可用')),
                ]),
                variant.ok === true
                  ? h('div', { key: 'm', style: Object.assign({}, style.muted, style.line) }, [
                      h('span', { key: 'x' }, '优惠 / 免费模型'),
                      h('span', { key: 'y' }, (variant.models || []).filter((m) => (m.badges || []).length > 0 || m.free === true).slice(0, 4).map(rateText).filter(Boolean).join(' · ') || '—'),
                    ])
                  : null,
              ])),
              h('div', { key: 'foot', style: Object.assign({}, style.line, style.muted) }, [
                h('span', { key: 'hint' }, '倍率仅用于展示，不影响实际计费'),
                h('span', { key: 'at' }, data && data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString('zh-CN') : ''),
              ]),
            ])
          : null,
      ]);
    }

    function SettingsPage() {
      const { data, error, busy, load } = useStatus();
      const variants = data && Array.isArray(data.variants) ? data.variants : [];

      return h('div', { style: style.page }, [
        h('div', { key: 'head', style: style.pageHead }, [
          h('div', { key: 't' }, [
            h('div', { key: 'title', style: style.title }, 'WorkBuddy 接入状态'),
            h('div', { key: 'sub', style: Object.assign({}, style.muted, { fontSize: '11px' }) },
              '模型通过本地桥接接入；这里展示桥接读到的账号、令牌、积分与模型倍率。'),
          ]),
          h('button', { key: 'r', type: 'button', style: style.refresh, disabled: busy, onClick: () => { void load(true); } },
            busy ? '刷新中…' : '刷新'),
        ]),
        error !== '' ? h('div', { key: 'err', style: { color: 'var(--ui-danger, #d9534f)', fontSize: '11px' } }, `读取失败：${error}`) : null,
        variants.length === 0
          ? h('div', { key: 'empty', style: style.muted }, '还没有数据（桥接未启动或未登录）')
          : h('div', { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
              variants.map((variant) => h(VariantCard, { key: variant.key, variant }))),
        h('div', { key: 'foot', style: Object.assign({}, style.muted, { fontSize: '11px' }) },
          '倍率与促销来自 WorkBuddy 服务端，仅用于展示，不影响实际计费。'),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'workbuddy-credits',
          order: 12,
        }, Dock));
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'workbuddy',
          order: 20,
          label: 'WorkBuddy',
        }, SettingsPage));
      },
    };
  },
});
