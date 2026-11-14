/* dsh-team-hierarchy —— 客户端半区
 *
 * 在「设置 → 团队岗位」挂一个分区：给小组长 / 普工 / 技术员各配
 * provider + 模型 + 推理档位。留空表示继承上级。
 *
 * 读写走 ctx.configForms.get('team-hierarchy')（ConfigFormController）：
 *   subscribe(listener) / getSnapshot() -> { value, writable } / mutate(ops)
 *
 * provider 和模型的下拉数据来自 llm 的 Remote 接口
 * （ctx.remote.llm.listProviders / discoverModels）；读不到就降级成输入框，
 * 页面不因为拉不到目录而失效。
 *
 * 手写 bundle：不经过 tsdown，只 require 平台模块表里的 react。
 * 模块 id 必须是完整包名。
 */
window.__ModuleLoader__.load({
  id: 'dsh-team-hierarchy',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;

    var NS = 'team-hierarchy';

    var ROLES = [
      { key: 'lead', label: '小组长', hint: '一条战线的负责人：拆解、验收、压缩上报。' },
      { key: 'worker', label: '普工', hint: '只干拆好的活。默认 low 档，够用就行。' },
      { key: 'tech', label: '技术员', hint: '查资料、验方案。默认 high 档。' },
    ];

    var EFFORTS = ['off', 'low', 'high', 'max'];

    var S = {
      root: {
        display: 'flex', flexDirection: 'column', gap: '16px',
        padding: '4px 2px 24px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.65', color: 'inherit',
      },
      title: { margin: '0', fontSize: '15px', fontWeight: '600' },
      hint: { margin: '0', opacity: '0.7', fontSize: '12px' },
      card: {
        display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '14px', borderRadius: '10px',
        border: '1px solid rgba(127,127,127,0.22)', background: 'rgba(127,127,127,0.04)',
      },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      roleName: { margin: '0', fontSize: '14px', fontWeight: '600' },
      roleHint: { margin: '0', fontSize: '12px', opacity: '0.65' },
      row: { display: 'grid', gridTemplateColumns: '88px 1fr', alignItems: 'center', gap: '10px' },
      label: { fontSize: '12.5px', opacity: '0.8' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '7px',
        border: '1px solid rgba(127,127,127,0.28)', background: 'rgba(127,127,127,0.06)',
        color: 'inherit', font: 'inherit', fontSize: '12.5px', outline: 'none',
      },
      select: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '7px',
        border: '1px solid rgba(127,127,127,0.28)', background: '#1a1f26',
        color: 'inherit', font: 'inherit', fontSize: '12.5px', outline: 'none',
        // 原生下拉的弹出层由 Chromium 自己画，color-scheme 只影响控件本身；
        // 弹出层的底色来自每个 option 的 inline style。
        colorScheme: 'dark',
      },
      footer: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      button: {
        padding: '7px 16px', borderRadius: '7px', border: '1px solid rgba(59,130,246,0.5)',
        background: 'rgba(59,130,246,0.16)', color: 'inherit', font: 'inherit',
        fontSize: '12.5px', fontWeight: '600', cursor: 'pointer',
      },
      disabled: { opacity: '0.45', cursor: 'not-allowed' },
      note: { margin: '0', fontSize: '12px', opacity: '0.85', minHeight: '16px' },
      warn: { margin: '0', fontSize: '12.5px', opacity: '0.9', color: '#e0a458' },
    };

    var EMPTY = {};
    var hostCtx = null;

    /** 原生 option 的弹出层只认 inline 底色，这里统一给。 */
    var OPT_STYLE = { background: '#1a1f26', color: '#e8eef5' };

    function option(key, value, label) {
      return h('option', { key: key, value: value, style: OPT_STYLE }, label);
    }

    /** 订阅共享配置表单的草稿/已接受值。 */
    function useFormSnapshot(form) {
      var useSync = React.useSyncExternalStore;
      var subscribe = React.useCallback(
        function (listener) { return form.subscribe(listener); },
        [form],
      );
      var read = React.useCallback(function () { return form.getSnapshot(); }, [form]);
      if (typeof useSync === 'function') return useSync(subscribe, read);
      var state = React.useState(read());
      var value = state[0];
      var setValue = state[1];
      React.useEffect(function () {
        return subscribe(function () { setValue(read()); });
      }, [subscribe]);
      React.useEffect(function () { setValue(read()); });
      return value;
    }

    /** Remote 结果可能是裸值，也可能包在 { value } / { ok, value } 里。 */
    function unwrapRemote(raw) {
      if (raw === undefined || raw === null) return undefined;
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== 'object') return raw;
      if (raw.value !== undefined) return raw.value;
      if (raw.data !== undefined) return raw.data;
      if (raw.result !== undefined) return raw.result;
      return raw;
    }

    /**
     * 拉取这台机器上已添加的 provider 与模型。
     * 返回 [{ id, name, models: [{ id, name }] }]；拿不到返回空数组。
     *
     * 注意：Cordis 对没在 inject 里声明的服务，访问 ctx.xxx 会直接抛错，
     * 不是返回 undefined。所以这里每一处访问都必须包住，否则组件在挂载阶段
     * 就崩掉、被槽位兜底吞成一片空白。
     */
    function fetchCatalog() {
      var remote;
      try {
        remote = hostCtx ? hostCtx.remote : null;
      } catch {
        return Promise.resolve([]);
      }
      if (!remote) return Promise.resolve([]);

      var llm;
      try {
        llm = remote.llm;
      } catch {
        return Promise.resolve([]);
      }
      if (!llm || typeof llm.listProviders !== 'function') return Promise.resolve([]);

      return Promise.resolve()
        .then(function () { return llm.listProviders(); })
        .then(function (raw) {
          var providers = unwrapRemote(raw) || [];
          if (!Array.isArray(providers)) return [];
          var normalized = providers.map(function (p) {
            var id = String((p && (p.id ?? p.provider ?? p.name)) || '');
            var name = String((p && (p.name ?? p.label ?? id)) || id);
            var models = [];
            var rawModels = (p && (p.models ?? p.modelList ?? p.supportedModels)) || [];
            if (Array.isArray(rawModels)) {
              models = rawModels.map(function (m) {
                var mid = String((m && (m.id ?? m.model ?? m.name)) || m || '');
                var mname = String((m && (m.name ?? m.label ?? mid)) || mid);
                return { id: mid, name: mname };
              }).filter(function (m) { return m.id !== ''; });
            }
            return { id: id, name: name, models: models };
          }).filter(function (p) { return p.id !== ''; });
          return normalized;
        })
        .catch(function () { return []; });
    }

    function draftFrom(hostValue) {
      var out = {};
      for (var i = 0; i < ROLES.length; i += 1) {
        var k = ROLES[i].key;
        out[k] = {
          provider: String(hostValue[k + 'Provider'] || ''),
          model: String(hostValue[k + 'Model'] || ''),
          effort: String(hostValue[k + 'Effort'] || (k === 'worker' ? 'low' : 'high')),
        };
      }
      return out;
    }

    function Section(props) {
      var form = props.form || currentForm;
      if (!form) {
        return h('div', { style: S.root },
          h('p', { style: S.title }, '团队岗位配置'),
          h('p', { style: S.warn }, '配置服务还没就绪（configForms 不可用），稍后再打开这个页面试试。'));
      }

      var snap = useFormSnapshot(form) || EMPTY;
      var hostValue = snap.value || EMPTY;
      var ready = Boolean(snap.value);
      var writable = snap.writable !== false;

      var draftState = React.useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noteState = React.useState('');
      var note = noteState[0];
      var setNote = noteState[1];
      var dirtyState = React.useState(false);
      var dirty = dirtyState[0];
      var setDirty = dirtyState[1];
      var catalogState = React.useState(null);
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var initedRef = React.useRef(false);

      // catalogJson 由 Host 算好写进配置；只有它还是空的时候才回落到 Remote。
      // 否则每次打开设置页都会白跑一次注定拿不到的调用。
      React.useEffect(function () {
        if (!ready) return undefined;
        var fromConfig = [];
        try {
          var rawCatalog = JSON.parse(String(hostValue.catalogJson || '[]'));
          if (Array.isArray(rawCatalog)) fromConfig = rawCatalog;
        } catch {
          fromConfig = [];
        }
        if (fromConfig.length > 0) return undefined;
        var alive = true;
        fetchCatalog().then(function (list) { if (alive) setCatalog(list); });
        return function () { alive = false; };
      }, [ready, String(hostValue.catalogJson || '')]);

      React.useEffect(function () {
        if (!ready) return;
        if (!initedRef.current) {
          initedRef.current = true;
          setDraft(draftFrom(hostValue));
          return;
        }
        if (!dirty) setDraft(draftFrom(hostValue));
      }, [ready, JSON.stringify(hostValue), dirty]);

      if (!draft) {
        return h('div', { style: S.root },
          h('p', { style: S.title }, '团队岗位配置'),
          h('p', { style: S.hint }, ready ? '读取中…' : '等 Host 配置就绪…'));
      }

      function setField(role, field, value) {
        setDirty(true);
        setDraft(function (prev) {
          var next = {};
          for (var k in prev) next[k] = Object.assign({}, prev[k]);
          next[role][field] = value;
          return next;
        });
      }

      function modelsOf(providerId) {
        if (!effectiveCatalog) return [];
        for (var i = 0; i < effectiveCatalog.length; i += 1) {
          if (effectiveCatalog[i].id === providerId) return effectiveCatalog[i].models || [];
        }
        return [];
      }

      function save() {
        if (busy || !writable) return;
        var ops = [];
        for (var i = 0; i < ROLES.length; i += 1) {
          var k = ROLES[i].key;
          var v = draft[k];
          var p = v.provider.trim();
          var m = v.model.trim();
          if ((p !== '') !== (m !== '')) {
            setNote(ROLES[i].label + '：provider 和模型必须同时选，或者同时留空。');
            return;
          }
          ops.push({ op: 'set', path: [k + 'Provider'], value: p });
          ops.push({ op: 'set', path: [k + 'Model'], value: m });
          ops.push({ op: 'set', path: [k + 'Effort'], value: v.effort });
        }
        setBusy(true);
        setNote('正在保存…');
        Promise.resolve()
          .then(function () { return form.mutate(ops); })
          .then(function (accepted) {
            setBusy(false);
            if (accepted === false) {
              setNote('保存被 Host 拒绝，已回读最新值。');
              setDirty(false);
              return;
            }
            setNote('已保存。下一次派活就按新配置走，已经在跑的子会话不受影响。');
            setDirty(false);
          })
          .catch(function (error) {
            setBusy(false);
            setNote('保存失败：' + String((error && error.message) || error));
          });
      }

      // Host 会把自己的 llm 目录算成 catalogJson 写进 Config；configForms 一定能读到。
      // Remote 那条只作为兜底，读不到也不影响。
      var parsedConfigCatalog = [];
      try {
        var rawCat = JSON.parse(String(hostValue.catalogJson || '[]'));
        if (Array.isArray(rawCat)) parsedConfigCatalog = rawCat;
      } catch {
        parsedConfigCatalog = [];
      }
      var effectiveCatalog = parsedConfigCatalog.length > 0
        ? parsedConfigCatalog
        : (Array.isArray(catalog) ? catalog : []);
      var hasCatalog = effectiveCatalog.length > 0;
      var cards = [];
      for (var i = 0; i < ROLES.length; i += 1) {
        // 必须用 let：var 在这里是函数作用域，三轮渲染共用一个变量，
        // 所有 onChange 会捕获到循环结束后的最后一个角色。
        let role = ROLES[i];
        let v = draft[role.key];
        var modelOptions = modelsOf(v.provider);

        var providerControl;
        if (hasCatalog) {
          providerControl = h('select', {
            style: S.select, value: v.provider,
            onChange: function (e) {
              var nextProvider = e.target.value;
              setDirty(true);
              setDraft(function (prev) {
                var next = {};
                for (var k in prev) next[k] = Object.assign({}, prev[k]);
                next[role.key].provider = nextProvider;
                next[role.key].model = '';
                return next;
              });
            },
          }, [option('', '', '留空 = 继承上级')].concat(
            effectiveCatalog.map(function (p) { return option(p.id, p.id, p.name); }),
          ));
        } else {
          providerControl = h('input', {
            style: S.input, value: v.provider, placeholder: '留空 = 继承上级',
            onChange: function (e) { setField(role.key, 'provider', e.target.value); },
          });
        }

        var modelControl;
        if (v.provider === '') {
          // provider 还没选时模型栏不可用。做成禁用的下拉而不是输入框：
          // 三行外观一致，也不会让人以为控件坏了。
          modelControl = h('select', {
            style: Object.assign({}, S.select, { opacity: 0.5, cursor: 'not-allowed' }),
            value: '',
            disabled: true,
          }, [option('', '', '先在上面选 provider')]);
        } else if (modelOptions.length > 0) {
          modelControl = h('select', {
            style: S.select, value: v.model,
            onChange: function (e) { setField(role.key, 'model', e.target.value); },
          }, [option('', '', '留空 = 继承上级')].concat(
            modelOptions.map(function (m) { return option(m.id, m.id, m.name); }),
          ));
        } else {
          modelControl = h('input', {
            style: S.input, value: v.model, placeholder: '留空 = 继承上级',
            onChange: function (e) { setField(role.key, 'model', e.target.value); },
          });
        }

        cards.push(h('div', { key: role.key, style: S.card },
          h('div', { style: S.cardHead },
            h('p', { style: S.roleName }, role.label),
            h('p', { style: S.roleHint }, role.hint),
          ),
          h('div', { style: S.row }, h('span', { style: S.label }, 'provider'), providerControl),
          h('div', { style: S.row }, h('span', { style: S.label }, '模型'), modelControl),
          h('div', { style: S.row },
            h('span', { style: S.label }, '推理档位'),
            h('select', {
              style: S.select, value: v.effort,
              onChange: function (e) { setField(role.key, 'effort', e.target.value); },
            }, EFFORTS.map(function (x) { return option(x, x, x); })),
          ),
        ));
      }

      return h('div', { style: S.root },
        h('p', { style: S.title }, '团队岗位配置'),
        h('p', { style: S.hint },
          '每个岗位用哪个模型、默认多少推理强度。留空表示继承上级——不填也行，下级会跟着上级走。',
        ),
        hasCatalog
          ? h('p', { style: S.hint }, 'provider 列表读自这台机器上已添加的配置；选完 provider 后再选模型。')
          : h('p', { style: S.warn },
            '读不到模型目录（llm 的 Remote 接口没响应），下面暂时是输入框。'
            + '可以先用项目经理会话里的「看看岗位配置」查出 provider 和模型 id，手填进去。'),
        cards,
        h('div', { style: S.footer },
          h('button', {
            type: 'button',
            style: busy || !writable ? Object.assign({}, S.button, S.disabled) : S.button,
            disabled: busy || !writable,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          h('span', { style: S.hint }, dirty ? '有未保存的修改' : ''),
        ),
        h('p', { style: S.note }, note),
      );
    }

    // remote 必须显式注入：官方 ui-settings 文档写的做法就是「inject the remote service」。
    // 不注入时访问 ctx.remote 会抛错，只能被 catch 掉，数据就永远拿不到。
    var inject = ['slots', 'configForms', 'remote'];

    var currentForm = null;

    function apply(ctx) {
      hostCtx = ctx;
      currentForm = ctx.configForms.get(NS);
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'team-hierarchy',
          order: 62,
          label: function () { return '团队岗位'; },
          inject: function () { return { form: currentForm }; },
        }, Section);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
