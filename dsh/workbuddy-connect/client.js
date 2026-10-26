/**
 * WorkBuddy Connect 的 Client 半：在输入框下方显示两个变体的剩余积分，
 * 点开可见套餐余量与模型倍率/促销。数据来自 Host 半的同源接口 /workbuddy/status。
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
        color: 'inherit', cursor: 'pointer', fontSize: '11px', height: '20px', padding: '0 8px',
      },
    };

    const number = (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';

    const rateText = (model) => {
      if (model.rateUnknown === true) return '价格未知';
      if (model.free === true) return '免费';
      const parts = [];
      if (typeof model.multiplier === 'string' && model.multiplier !== '') parts.push(model.multiplier);
      for (const badge of Array.isArray(model.badges) ? model.badges : []) parts.push(String(badge));
      return parts.join(' · ');
    };

    function VariantChip({ variant, onOpen }) {
      const bad = variant.ok !== true;
      const title = bad
        ? `${variant.label}：${variant.error || '不可用'}`
        : `${variant.label} 剩余 ${number(variant.credits && variant.credits.total)}（点击查看明细）`;
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

    function VariantDetail({ variant }) {
      if (variant.ok !== true) {
        return h('div', { style: Object.assign({}, style.line, style.muted) }, [
          h('span', { key: 'name' }, variant.label || variant.key),
          h('span', { key: 'err' }, variant.error || '不可用'),
        ]);
      }
      const credits = variant.credits || {};
      const packages = Array.isArray(credits.packages) ? credits.packages : [];
      const models = Array.isArray(variant.models) ? variant.models : [];
      const interesting = models
        .filter((model) => (Array.isArray(model.badges) && model.badges.length > 0) || model.free === true || model.rateUnknown === true)
        .slice(0, 8);
      // 没有促销时展示倍率最低的几个，至少让用户看到"哪个便宜"
      const ranked = (interesting.length > 0 ? interesting : models.slice().sort((a, b) => {
        const toNumber = (model) => {
          const match = /x([\d.]+)/.exec(String(model.multiplier || ''));
          return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
        };
        return toNumber(a) - toNumber(b);
      }).slice(0, 8));

      const rows = [];
      rows.push(h('div', { key: 'head', style: style.cardHead }, [
        h('span', { key: 't', style: style.sectionTitle }, variant.label || variant.key),
        h('span', { key: 'v', style: { fontSize: '11px', fontVariantNumeric: 'tabular-nums' } },
          credits.unlimited === true ? '不限量' : `${number(credits.total)} 积分`),
      ]));
      if (packages.length > 0) {
        rows.push(h('div', { key: 'pkgs', style: style.list }, packages.map((pkg, index) =>
          h('div', { key: `pkg-${index}`, style: style.line }, [
            h('span', { key: 'n', style: style.muted }, pkg.name || '套餐'),
            h('span', { key: 'v' }, `${number(pkg.remain)} / ${number(pkg.size)}`),
          ]),
        )));
      }
      if (ranked.length > 0) {
        rows.push(h('div', { key: 'models', style: style.list }, ranked.map((model) =>
          h('div', { key: model.id, style: style.line }, [
            h('span', { key: 'n', style: Object.assign({}, style.muted, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, model.name || model.id),
            h('span', { key: 'v', style: { flexShrink: 0 } }, rateText(model) || '—'),
          ]),
        )));
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, rows);
    }

    function StatusDock() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async (refresh) => {
        setBusy(true);
        try {
          const response = await fetch(`/workbuddy/status${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setData(await response.json());
          setError('');
        } catch (failure) {
          setError(String((failure && failure.message) || failure).slice(0, 120));
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
                h('button', {
                  key: 'refresh', type: 'button', style: style.refresh, disabled: busy,
                  onClick: () => { void load(true); },
                }, busy ? '刷新中…' : '刷新'),
              ]),
              ...variants.map((variant) => h(VariantDetail, { key: variant.key, variant })),
              h('div', { key: 'foot', style: Object.assign({}, style.line, style.muted) }, [
                h('span', { key: 'hint' }, '倍率仅用于展示，不影响实际计费'),
                h('span', { key: 'at' }, data && data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString('zh-CN') : ''),
              ]),
            ])
          : null,
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'workbuddy-credits',
          order: 12,
        }, StatusDock));
      },
    };
  },
});
