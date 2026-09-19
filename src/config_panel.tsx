/**
 * 設定パネル。Swing GUI の Config Editor（TreeTableCafe）に相当する。
 *
 * <p>値は ws-protocol の parameter で読み書きし、構造と型は `/config_layout` から受け取る。
 * parameter は JSON なので値しか運べず、0 が整数なのか小数なのか、
 * 文字列が自由入力なのか enum の定数名なのかを判別できないため、型を別立てで貰う。
 *
 * <p>ここは部品を並べるだけにしてある。
 * <ul>
 *   <li>Foxglove との受信・サービス呼び出し・ステータス行 → `config_hooks.ts`</li>
 *   <li>表（Swing に寄せた見た目と、その場での編集） → `config_table.tsx`</li>
 *   <li>ファイル操作 → `config_file_ops.tsx`</li>
 *   <li>木の構築・絞り込み・値の変換（純関数） → `config_tree.ts`</li>
 * </ul>
 */

import {
  PanelExtensionContext,
  ParameterValue,
  SettingsTree,
  SettingsTreeAction,
} from "@foxglove/studio";
import * as React from "react";
import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";

import { FILE_OPS_CSS, FileOps } from "./config_file_ops";
import {
  useConfigFiles,
  useConfigStream,
  useServiceCaller,
  useStatusMessages,
} from "./config_hooks";
import { ConfigTable, TABLE_CSS } from "./config_table";
import { allGroupPaths, buildTree, countLeaves, filterTree } from "./config_tree";
import { colors, inputStyle, useIsDarkTheme } from "./panel_theme";

/** パネルに永続化する状態 */
interface PanelState {
  topic: string;
  /**
   * 枝のパス -> 開いているか。
   *
   * <p>既定はどこも開かない。1段目を開くと枝とその配下の葉が入り混じって縦に伸び、
   * ルートに何があるかが読み取れなくなる。畳んでおけば最初の画面が章立てになる。
   */
  expanded: { [path: string]: boolean };
  /** 名前の代わりに完全なパスを出すか */
  showPaths: boolean;
  /** 名前の列の幅[px]。見出しの境界をドラッグして変える */
  nameWidth: number;
}

const defaultState: PanelState = {
  topic: "/config_layout",
  expanded: {},
  showPaths: false,
  nameWidth: 220,
};

/** パネル右上の歯車から開く設定。トピック名と、パスの表示切り替え */
function usePanelSettings(
  context: PanelExtensionContext,
  state: PanelState,
  setState: React.Dispatch<React.SetStateAction<PanelState>>,
): void {
  useEffect(() => {
    const settings: SettingsTree = {
      nodes: {
        general: {
          label: "General",
          fields: {
            topic: { label: "トピック名", input: "string", value: state.topic },
            showPaths: { label: "完全な名前を表示", input: "boolean", value: state.showPaths },
          },
        },
      },
      actionHandler: (action: SettingsTreeAction) => {
        if (action.action !== "update") {
          return;
        }
        const path = action.payload.path.join(".");
        if (path === "general.topic") {
          setState((prev) => ({ ...prev, topic: action.payload.value as string }));
        } else if (path === "general.showPaths") {
          setState((prev) => ({ ...prev, showPaths: action.payload.value === true }));
        }
      },
    };
    context.updatePanelSettingsEditor(settings);
  }, [context, setState, state.showPaths, state.topic]);
}

const ConfigPanel: React.FC<{ context: PanelExtensionContext }> = ({ context }) => {
  const [state, setState] = useState<PanelState>(defaultState);
  const [query, setQuery] = useState("");
  const [showFileOps, setShowFileOps] = useState(false);

  const isDark = useIsDarkTheme(context.panelElement);
  const { nodes, parameters, serverStatus } = useConfigStream(context, state.topic);
  const { statuses, pushStatus } = useStatusMessages();
  const callService = useServiceCaller(context, pushStatus);
  const { files, refresh: refreshFiles } = useConfigFiles(context);
  usePanelSettings(context, state, setState);

  // --- 保存状態 -------------------------------------------------------------

  useLayoutEffect(() => {
    const saved = context.initialState as Partial<PanelState> | undefined;
    if (saved) {
      setState((prev) => ({ ...prev, ...saved, expanded: saved.expanded ?? prev.expanded }));
    }
  }, [context]);

  useLayoutEffect(() => {
    context.saveState(state);
  }, [context, state]);

  // --- 木 -------------------------------------------------------------------

  // 並びは宣言順のまま。Swing や config.json と順番が一致する
  const tree = useMemo(() => buildTree(nodes ?? []), [nodes]);
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);

  // 絞り込み中は一致した行を持つ枝をすべて開く。
  // 畳んだままだと「一致したのに何も出ない」に見える
  const expanded = useMemo(() => {
    if (query.trim().length === 0) {
      return state.expanded;
    }
    const open: { [path: string]: boolean } = {};
    for (const path of allGroupPaths(visible)) {
      open[path] = true;
    }
    return open;
  }, [query, state.expanded, visible]);

  const toggleGroup = useCallback((path: string) => {
    setState((prev) => ({
      ...prev,
      expanded: { ...prev.expanded, [path]: prev.expanded[path] !== true },
    }));
  }, []);

  const setNameWidth = useCallback((width: number) => {
    setState((prev) => (prev.nameWidth === width ? prev : { ...prev, nameWidth: width }));
  }, []);

  // --- 書き込み -------------------------------------------------------------

  const handleSet = useCallback(
    (path: string, value: ParameterValue) => {
      try {
        context.setParameter(path, value);
      } catch (error) {
        pushStatus("error", `${path} の設定に失敗: ${String(error)}`);
      }
    },
    [context, pushStatus],
  );

  const handleError = useCallback(
    (message: string) => {
      pushStatus("error", message);
    },
    [pushStatus],
  );

  // --- 描画 -----------------------------------------------------------------

  const writable = serverStatus?.allowControl !== false;
  const total = countLeaves(tree);

  return (
    <div
      style={{
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        fontFamily: "inherit",
        fontSize: 12,
        height: "100%",
        padding: 8,
      }}
    >
      <style>{TABLE_CSS + FILE_OPS_CSS}</style>

      {/* 常時出すのは絞り込みだけ。ファイル操作は設定ファイル名のボタンで開閉する */}
      <div style={{ alignItems: "center", display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          type="text"
          placeholder="名前で絞り込む"
          style={{ ...inputStyle(isDark), flex: "1 1 auto", padding: "2px 6px", width: "auto" }}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <span style={{ opacity: 0.7, whiteSpace: "nowrap" }}>
          {query.trim().length > 0 ? `${countLeaves(visible)} / ${total}` : `${total}`}
        </span>
        <button
          className="rdccfg-btn"
          title="ファイル操作"
          onClick={() => {
            setShowFileOps((prev) => !prev);
          }}
        >
          {serverStatus?.configName ?? "?"}
          {serverStatus?.dirty === true ? " *" : ""}
        </button>
      </div>

      {!writable && (
        <div style={{ color: colors.error, marginBottom: 6 }}>
          config.foxgloveAllowControl が false のため読み取り専用です
        </div>
      )}

      {showFileOps && (
        <FileOps
          files={files}
          writable={writable}
          isDark={isDark}
          callService={callService}
          pushStatus={pushStatus}
          onFilesChanged={refreshFiles}
        />
      )}

      {statuses.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {statuses.map((s) => (
            <div
              key={s.id}
              style={{ color: s.kind === "error" ? colors.error : undefined, lineHeight: 1.5 }}
            >
              {s.text}
            </div>
          ))}
        </div>
      )}

      {nodes == undefined ? (
        <div style={{ opacity: 0.7 }}>{state.topic} を待っています…</div>
      ) : (
        <ConfigTable
          panelElement={context.panelElement}
          items={visible}
          expanded={expanded}
          parameters={parameters}
          disabled={!writable}
          showPaths={state.showPaths}
          nameWidth={state.nameWidth}
          isDark={isDark}
          onToggle={toggleGroup}
          onNameWidthChange={setNameWidth}
          onSet={handleSet}
          onError={handleError}
        />
      )}
    </div>
  );
};

export function initConfigPanel(context: PanelExtensionContext): () => void {
  ReactDOM.render(
    <StrictMode>
      <ConfigPanel context={context} />
    </StrictMode>,
    context.panelElement,
  );
  return () => {
    ReactDOM.unmountComponentAtNode(context.panelElement);
  };
}
