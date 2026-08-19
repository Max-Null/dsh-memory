window.__ModuleLoader__.load({
  id: "@max-null/dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var inject = ["slots", "locale", "remote", "remote.memory"];
var STRINGS = {
  zh: {
    tabMemory: "\u8BB0\u5FC6",
    memorySearch: "\u641C\u7D22\u8BB0\u5FC6\u2026",
    empty: "\u9ED1\u6697\u4E2D\u672A\u89C1\u7075\u5149",
    confirm: "\u786E\u8BA4",
    forget: "\u5220\u9664",
    groupPending: "\u5F85\u5BA1\u6838",
    groupOnDemand: "\u5DF2\u5BA1\u6838 \xB7 \u6309\u9700",
    groupInjected: "\u5E38\u9A7B\u6CE8\u5165",
    injectSwitch: "\u5E38\u9A7B\u6CE8\u5165",
    approveFirst: "\u5BA1\u6838\u901A\u8FC7\u540E\u53EF\u5E38\u9A7B\u6CE8\u5165",
    allNamespaces: "\u5168\u90E8",
    nsGlobal: "\u5168\u5C40",
    nsProject: "\u9879\u76EE",
    organizeMemory: "\u6574\u7406\u8BB0\u5FC6",
    confirmAll: "\u5168\u90E8\u786E\u8BA4",
    suggested: "\u5F85\u5BA1\u6838",
    approved: "\u5DF2\u5BA1\u6838",
    refresh: "\u5237\u65B0"
  },
  en: {
    tabMemory: "Memory",
    memorySearch: "Search memory\u2026",
    empty: "No spark in the dark",
    confirm: "Confirm",
    forget: "Forget",
    groupPending: "Pending review",
    groupOnDemand: "Approved \xB7 on demand",
    groupInjected: "Always injected",
    injectSwitch: "Inject every turn",
    approveFirst: "Approve to enable injection",
    allNamespaces: "All",
    nsGlobal: "Global",
    nsProject: "Project",
    organizeMemory: "Organize memory",
    confirmAll: "Approve all",
    suggested: "Suggested",
    approved: "Approved",
    refresh: "Refresh"
  }
};
var localeId = "zh";
var localeListeners = /* @__PURE__ */ new Set();
function adoptLocale(id) {
  const next = id === "en" ? "en" : "zh";
  if (next === localeId) return;
  localeId = next;
  localeListeners.forEach((l) => l());
}
function fmt(tpl, vars = {}) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}
function useT() {
  const [id, setId] = (0, import_react.useState)(localeId);
  (0, import_react.useEffect)(() => {
    const l = () => {
      setId(localeId);
    };
    localeListeners.add(l);
    return () => {
      localeListeners.delete(l);
    };
  }, []);
  return (key, vars) => fmt(STRINGS[id][key] ?? STRINGS.zh[key], vars);
}
var ssid = {
  accent: "#4FC3F7",
  wrap: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", overflowY: "auto", height: "100%", boxSizing: "border-box" },
  card: {
    background: "var(--dsw-alias-bg-layer-1, #131a26)",
    border: "1px solid var(--dsw-alias-border-l2, #1e2836)",
    borderRadius: 10,
    padding: "10px 12px"
  },
  title: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #67748a)", marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" },
  text: { fontSize: 12.5, color: "var(--dsw-alias-label-primary, #d8e0ea)", lineHeight: 1.55 },
  muted: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #67748a)" },
  empty: { padding: "28px 12px", textAlign: "center", fontSize: 12.5, color: "var(--dsw-alias-label-secondary, #67748a)" },
  btn: {
    padding: "3px 12px",
    fontSize: 11.5,
    background: "none",
    border: "1px solid var(--dsw-alias-border-l2, #1e2836)",
    borderRadius: 6,
    color: "var(--dsw-alias-label-primary, #d8e0ea)",
    cursor: "pointer"
  }
};
var ORGANIZE_PROMPT = "\u8BF7\u6574\u7406\u6211\u7684\u8BB0\u5FC6\u5E93\uFF1A\u7528 memory_list \u67E5\u770B\u5168\u90E8\u8BB0\u5FC6\uFF0C\u5408\u5E76\u91CD\u590D\u6216\u53EF\u5F52\u5E76\u7684\u6761\u76EE\uFF0C\u7CBE\u7B80\u5197\u957F\u5185\u5BB9\uFF0C\u4E3A\u6BCF\u6761\u8865\u5145\u6216\u4FEE\u6B63 keywords\uFF1B\u5BF9\u8FC7\u65F6\u3001\u9519\u8BEF\u6216\u5DF2\u53D8\u5316\u7684\u5185\u5BB9\u7528 memory_update \u4FEE\u6B63\uFF08\u4F1A\u91CD\u7F6E\u4E3A\u5F85\u5BA1\u6838\uFF09\uFF0C\u9700\u8981\u5220\u9664\u7684\u7528 memory_forget\uFF0C\u9700\u8981\u65B0\u589E\u7684\u7528 memory_save\u3002\u5224\u65AD\u5185\u5BB9\u662F\u5426\u8FC7\u65F6\u7684\u65B9\u6CD5\uFF1A\u628A\u8BB0\u5FC6\u91CC\u63D0\u5230\u7684\u5DE5\u5177\u540D/\u6570\u91CF\u4E0E\u4F60\u5F53\u524D\u5B9E\u9645\u53EF\u7528\u7684\u8BB0\u5FC6\u5DE5\u5177\u5BF9\u7167\u2014\u2014\u4F60\u5F53\u524D\u53EF\u7528\uFF1Amemory_save / memory_list / memory_search / memory_confirm / memory_forget / memory_update\uFF08\u5171 6 \u4E2A\uFF09\uFF1B\u82E5\u8BB0\u5FC6\u4E2D\u7684\u5DE5\u5177\u5217\u8868\u3001\u6570\u91CF\u3001\u6D41\u7A0B\u4E0E\u6B64\u4E0D\u7B26\u5373\u4E3A\u8FC7\u65F6\uFF0C\u7528 memory_update \u4FEE\u6B63\u3002\u6539\u52A8\u5168\u90E8\u843D\u5728 suggested \u7B49\u5F85\u5BA1\u6838\uFF08\u4E0D\u8981\u8C03\u7528 memory_confirm\uFF09\uFF0C\u5B8C\u6210\u540E\u7528\u4E00\u53E5\u8BDD\u6C47\u62A5\u6574\u7406\u7ED3\u679C\u3002";
function MemoryView(props) {
  const t = useT();
  const [records, setRecords] = (0, import_react.useState)([]);
  const [query, setQuery] = (0, import_react.useState)("");
  const [namespace, setNamespace] = (0, import_react.useState)(null);
  const [refreshing, setRefreshing] = (0, import_react.useState)(false);
  const [organizing, setOrganizing] = (0, import_react.useState)(false);
  const reload = async () => {
    try {
      setRecords(await props.remote.list());
    } catch {
      setRecords([]);
    }
  };
  const refreshFromDisk = async () => {
    setRefreshing(true);
    try {
      const value = await props.remote.reload();
      setRecords(value);
    } catch {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };
  (0, import_react.useEffect)(() => {
    if (props.visible) void reload();
  }, [props.visible]);
  const toggleInjected = async (record) => {
    if (record.status !== "approved") return;
    try {
      await props.remote.setInjected(record.id, !record.injected);
    } catch {
    }
    await reload();
  };
  const confirmAll = async () => {
    const pending = records.filter((record) => record.status === "suggested");
    if (pending.length === 0) return;
    await Promise.all(pending.map((record) => props.remote.confirm(record.id).catch(() => null)));
    await reload();
  };
  const organize = async () => {
    if (organizing) return;
    setOrganizing(true);
    try {
      const sessions = props.ctx.get?.("sessions");
      const conversation = props.ctx.get?.("conversation");
      if (sessions === void 0 || conversation?.input?.for === void 0) {
        throw new Error("sessions/conversation unavailable");
      }
      const sessionId = await sessions.create({});
      sessions.open(sessionId);
      let input;
      for (let i = 0; i < 50; i++) {
        try {
          const actx = sessions.scope(sessionId);
          if (actx !== void 0) {
            input = conversation.input.for(actx);
            if (input !== void 0) break;
          }
        } catch {
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (input === void 0) throw new Error("composer input not ready");
      input.setDraft(ORGANIZE_PROMPT);
      input.submit();
    } catch (error) {
      console.warn("[dsh-memory] organize memory failed:", error);
    } finally {
      setOrganizing(false);
    }
  };
  const q = query.trim().toLowerCase();
  const byNs = namespace === null ? records : records.filter((record) => record.namespace === namespace);
  const filtered = byNs.filter((record) => q === "" || record.content.toLowerCase().includes(q));
  const groups = [
    { key: "pending", label: t("groupPending"), items: filtered.filter((record) => record.status === "suggested") },
    { key: "ondemand", label: t("groupOnDemand"), items: filtered.filter((record) => record.status === "approved" && !record.injected) },
    { key: "injected", label: t("groupInjected"), items: filtered.filter((record) => record.status === "approved" && record.injected) }
  ].filter((group) => group.items.length > 0);
  return (0, import_react.createElement)(
    "div",
    { style: ssid.wrap },
    (0, import_react.createElement)(
      "div",
      { style: { display: "flex", gap: 6 } },
      (0, import_react.createElement)("button", {
        type: "button",
        title: t("organizeMemory"),
        onClick: () => {
          void organize();
        },
        disabled: organizing,
        style: { ...ssid.btn, color: ssid.accent, borderColor: ssid.accent }
      }, organizing ? "\u2026" : t("organizeMemory")),
      (0, import_react.createElement)("input", {
        value: query,
        onChange: (event) => {
          setQuery(event.target.value);
        },
        placeholder: t("memorySearch"),
        style: {
          flex: 1,
          padding: "6px 10px",
          fontSize: 12.5,
          boxSizing: "border-box",
          background: "var(--dsw-alias-bg-layer-1, #0f141d)",
          border: "1px solid var(--dsw-alias-border-l2, #1e2836)",
          borderRadius: 8,
          color: "var(--dsw-alias-label-primary, #d8e0ea)",
          outline: "none"
        }
      }),
      (0, import_react.createElement)("button", {
        type: "button",
        title: t("refresh"),
        onClick: () => {
          void refreshFromDisk();
        },
        disabled: refreshing,
        style: ssid.btn
      }, refreshing ? "\u2026" : "\u21BB")
    ),
    (0, import_react.createElement)(
      "div",
      { style: { display: "flex", gap: 4 } },
      [null, "global", "project"].map((ns) => (0, import_react.createElement)("button", {
        key: ns ?? "all",
        onClick: () => {
          setNamespace(ns);
        },
        style: { flex: 1, ...ssid.btn, ...namespace === ns ? { color: ssid.accent, borderColor: ssid.accent } : {} }
      }, ns === null ? t("allNamespaces") : ns === "global" ? t("nsGlobal") : t("nsProject")))
    ),
    groups.length === 0 ? (0, import_react.createElement)("div", { style: ssid.empty }, t("empty")) : groups.map((group) => (0, import_react.createElement)(
      "div",
      { key: group.key, style: { display: "flex", flexDirection: "column", gap: 6 } },
      (0, import_react.createElement)(
        "div",
        { style: ssid.title },
        (0, import_react.createElement)("span", null, group.label),
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6 } },
          group.key === "pending" && group.items.length > 0 ? (0, import_react.createElement)("button", {
            type: "button",
            title: t("confirmAll"),
            onClick: () => {
              void confirmAll();
            },
            style: { ...ssid.btn, padding: "1px 8px", fontSize: 10.5 }
          }, t("confirmAll")) : null,
          (0, import_react.createElement)("span", null, `${group.items.length}`)
        )
      ),
      group.items.map((record) => (0, import_react.createElement)(
        "div",
        { key: record.id, style: ssid.card },
        (0, import_react.createElement)("div", { style: ssid.text }, record.content),
        (0, import_react.createElement)(
          "div",
          { style: { ...ssid.muted, marginTop: 6 } },
          `${record.namespace} \xB7 ${record.status === "approved" ? t("approved") : t("suggested")}${record.injected ? ` \xB7 ${t("groupInjected")}` : ""}`
        ),
        (0, import_react.createElement)(
          "div",
          { style: { display: "flex", gap: 6, marginTop: 8, alignItems: "center" } },
          (0, import_react.createElement)("button", {
            type: "button",
            title: record.status === "approved" ? t("injectSwitch") : t("approveFirst"),
            disabled: record.status !== "approved",
            onClick: () => {
              void toggleInjected(record);
            },
            style: {
              ...ssid.btn,
              ...record.injected ? { color: ssid.accent, borderColor: ssid.accent } : {},
              opacity: record.status !== "approved" ? 0.4 : 1,
              cursor: record.status !== "approved" ? "not-allowed" : "pointer"
            }
          }, record.injected ? `\u2713 ${t("injectSwitch")}` : t("injectSwitch")),
          record.status === "suggested" ? (0, import_react.createElement)("button", {
            style: ssid.btn,
            onClick: () => {
              void props.remote.confirm(record.id).then(() => reload());
            }
          }, t("confirm")) : null,
          (0, import_react.createElement)("button", {
            style: ssid.btn,
            onClick: () => {
              void props.remote.forget(record.id).then(() => reload());
            }
          }, t("forget"))
        )
      ))
    ))
  );
}
function apply(ctx) {
  const face = ctx;
  const locale = face.get?.("locale");
  const initial = locale?.getLocale?.()?.active;
  if (typeof initial === "string") adoptLocale(initial);
  face.on?.("locale/change", (snap) => {
    adoptLocale(snap?.active);
  });
  const root = ctx;
  if (root.inject === void 0) return;
  root.inject(["betterSidebar"], (sidebarCtx) => {
    const service = sidebarCtx.betterSidebar;
    if (service?.registerTab === void 0) return;
    const memory = ctx.remote?.memory;
    if (memory === void 0) return;
    const tabCtx = ctx;
    service.registerTab({
      id: "@max-null/dsh-memory:memory",
      title: () => STRINGS[localeId].tabMemory,
      order: 60,
      single: true,
      component: ({ visible }) => (0, import_react.createElement)(MemoryView, {
        visible,
        remote: memory,
        ctx: tabCtx
      })
    });
  });
}
    return module.exports;
  },
});

