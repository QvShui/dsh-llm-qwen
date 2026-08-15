/**
 * dsh-llm-qwen — browser half.
 *
 * Registers a "Qwen (DashScope)" page under 设置 (settings.section) with an
 * API-key field, because the shipped Models page only curates the
 * `llm-deepseek` and `llm-pi-ai` namespaces for inline editing — a
 * composition-provided third-party provider row only gets a "edit
 * settings.yaml" hint there. This section gives the plugin's own users a
 * frontend to set/change the key, writing through the same public
 * credentials remote the Models page uses (`connection.api.credentials`).
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })`, the same
 * shape client-modules serves for every `dsh.client` package.
 */
window.__ModuleLoader__.load({
  id: "dsh-llm-qwen",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    /** The credential reference this section manages (the plugin's default). */
    const KEY_REF = "DASHSCOPE_API_KEY";

    const fieldStyle = {
      display: "flex",
      flexDirection: "column",
      gap: 12,
    };
    const inputStyle = {
      width: "100%",
      boxSizing: "border-box",
      padding: "8px 10px",
      borderRadius: 8,
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
    };
    const buttonStyle = {
      alignSelf: "flex-start",
      padding: "8px 16px",
      borderRadius: 18,
      border: "none",
      cursor: "pointer",
      background: "var(--dsw-alias-button-primary-fill)",
      color: "var(--dsw-alias-label-primary-foreground)",
      font: "inherit",
    };
    const mutedStyle = { margin: 0, fontSize: 12, opacity: 0.65, lineHeight: 1.6 };

    /**
     * The Qwen key-management page. Reads the stored-credential status on
     * mount and saves typed keys through the public credentials remote.
     */
    function QwenKeySection(props) {
      const api = props.api;
      const [status, setStatus] = React.useState(undefined);
      const [draft, setDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const [error, setError] = React.useState(null);

      const loadStatus = () => {
        let stale = false;
        api.credentials.describe({ refs: [KEY_REF] }).then((res) => {
          if (stale || !res.result.ok) return;
          setStatus(res.result.value.credentials[KEY_REF]);
        }).catch(() => {});
        return () => {
          stale = true;
        };
      };
      React.useEffect(loadStatus, [api]);

      const save = async () => {
        const value = draft.trim();
        if (value.length === 0) return;
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
          const res = await api.credentials.set({ ref: KEY_REF, value });
          if (!res.result.ok) {
            setError(res.result.error ? res.result.error.message : "保存失败");
            return;
          }
          setDraft("");
          setSaved(true);
          const st = await api.credentials.describe({ refs: [KEY_REF] });
          if (st.result.ok) setStatus(st.result.value.credentials[KEY_REF]);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      };

      const configured = status !== undefined && status.configured === true;
      const statusText = status === undefined
        ? "读取凭证状态…"
        : configured
          ? "已配置" + (status.source ? `（来源：${status.source}）` : "")
          : "未配置";

      return React.createElement(
        "div",
        { style: fieldStyle },
        React.createElement(
          "p",
          { style: mutedStyle },
          "通义千问（DashScope）API Key。凭证引用名：",
          React.createElement("code", null, KEY_REF),
          " — ",
          statusText,
          "。保存后立即生效，无需重启。"
        ),
        React.createElement("input", {
          type: "password",
          autoComplete: "off",
          value: draft,
          disabled: busy,
          placeholder: configured ? "留空保持当前 key，输入新 key 覆盖" : "粘贴你的 DashScope API key",
          "aria-label": "Qwen API Key",
          onChange: (event) => setDraft(event.target.value),
          style: inputStyle,
        }),
        saved
          ? React.createElement("p", {
              style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-success-primary)" },
            }, "已保存。")
          : null,
        error !== null
          ? React.createElement("p", {
              style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary)" },
            }, String(error))
          : null,
        React.createElement(
          "button",
          {
            type: "button",
            disabled: busy || draft.trim().length === 0,
            onClick: save,
            style: buttonStyle,
          },
          busy ? "保存中…" : "保存 API Key"
        ),
        React.createElement(
          "p",
          { style: mutedStyle },
          "也可以直接编辑 ~/.dsh/.credentials.yaml 的 ",
          React.createElement("code", null, KEY_REF),
          " 行，或在启动环境中导出同名变量（环境变量优先级最高）。"
        )
      );
    }

    const name = "dsh-llm-qwen";
    const inject = ["slots", "connection"];

    /** Register the Qwen page once the settings.section declaration exists. */
    function apply(ctx) {
      const slots = ctx.get("slots");
      const connection = ctx.get("connection");
      if (slots === undefined || connection === undefined) return;
      slots.inject("settings.section", () => slots.register(
        {
          name: "settings.section",
          id: "llm-qwen",
          order: 30,
          label: () => "Qwen (DashScope)",
          inject: () => ({ api: connection.api }),
        },
        QwenKeySection,
      ));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
