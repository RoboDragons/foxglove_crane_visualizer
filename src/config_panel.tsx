/**
 * 設定パネル。Swing GUI の Config Editor（TreeTableCafe）に相当する。
 *
 * <p>値は ws-protocol の parameter で読み書きし、構造と型は `/config_layout` から受け取る。
 * parameter は JSON なので値しか運べず、0 が整数なのか小数なのか、
 * 文字列が自由入力なのか enum の定数名なのかを判別できないため、型を別立てで貰う。
 *
 * <p><b>操作パネル（ui_control_panel）とは役割が違う。</b>
 * あちらは試合運用向けに絞り込み、危険な操作に確認を挟む。
 * こちらは調整とデバッグ向けで、求められるのは網羅性と検索性。
 */

import {
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  ParameterValue,
  SettingsTree,
  SettingsTreeAction,
  Subscription,
} from "@foxglove/studio";
import * as React from "react";
import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactDOM from "react-dom";

import {
  ConfigKind,
  ConfigNode,
  TreeGroup,
  TreeItem,
  allGroupPaths,
  buildTree,
  countLeaves,
  defaultExpanded,
  elementKind,
  emptyElement,
  filterTree,
  formatValue,
  isArrayKind,
  normalizeLayout,
  parseValue,
  toArray,
} from "./config_tree";
import { colors, inputStyle, optionStyle, useIsDarkTheme } from "./panel_theme";

const DEFAULT_TOPIC = "/config_layout";
/** サーバー状態のトピック。未保存かどうかと書き込み許可を読む */
const STATUS_TOPIC = "/server_status";

const SVC_SAVE = "/config/save";
const SVC_SAVE_AS = "/config/save_as";
const SVC_LOAD = "/config/load";
const SVC_LIST = "/config/list";
const SVC_RESTART = "/server/restart";

/** 確認付きボタンを構えたままにする時間[ms]。操作パネルと揃える */
const CONFIRM_TIMEOUT_MS = 4000;
/** ステータス行を残す時間[ms]。エラーは消さない */
const STATUS_FADE_MS = 6000;

/** パネルに永続化する状態 */
interface PanelState {
  topic: string;
  /** 枝のパス -> 開いているか。畳んだ状態を憶える */
  expanded: { [path: string]: boolean };
  /** 完全な名前（パス）を各行に出すか */
  showPaths: boolean;
}

const defaultState: PanelState = {
  topic: DEFAULT_TOPIC,
  expanded: {},
  showPaths: false,
};

type StatusKind = "info" | "error" | "pending";

interface Status {
  id: number;
  kind: StatusKind;
  text: string;
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// 応答の読み取り
// ---------------------------------------------------------------------------

function isFailure(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response != undefined &&
    (response as Record<string, unknown>)["success"] === false
  );
}

function messageOf(response: unknown): string {
  if (typeof response !== "object" || response == undefined) {
    return "";
  }
  const message = (response as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : "";
}

/** `/config/list` の応答からファイル名を読む */
function filesOf(response: unknown): string[] {
  if (typeof response !== "object" || response == undefined) {
    return [];
  }
  const files = (response as Record<string, unknown>)["files"];
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/** `/server_status` から必要な3つだけ読む */
interface ServerStatus {
  configName: string;
  dirty: boolean;
  allowControl: boolean;
}

function normalizeStatus(message: unknown): ServerStatus | undefined {
  if (typeof message !== "object" || message == undefined) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  // proto3 の既定値は省略されて届くので、欠けていれば偽として扱う。
  // allow_control だけは「届いていない = 不明」なので許可側に倒す。
  // 禁止側に倒すと、古いサーバーに繋いだときに全部の入力欄が死ぬ
  const name = record["configName"] ?? record["config_name"];
  const dirty = record["configDirty"] ?? record["config_dirty"];
  const allow = record["allowControl"] ?? record["allow_control"];
  return {
    configName: typeof name === "string" ? name : "",
    dirty: dirty === true,
    allowControl: allow !== false,
  };
}

// ---------------------------------------------------------------------------
// スタイル
// ---------------------------------------------------------------------------

const rootStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 12,
  height: "100%",
  overflowY: "auto",
  padding: 8,
  boxSizing: "border-box",
};

const rowStyle: React.CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: 8,
  // 名前と入力欄。名前側は広がりすぎないように上限を置く
  gridTemplateColumns: "minmax(120px, 1fr) minmax(140px, 1.4fr)",
  padding: "3px 6px",
};

const groupHeaderStyle: React.CSSProperties = {
  alignItems: "center",
  background: colors.surface,
  border: "none",
  cursor: "pointer",
  display: "flex",
  font: "inherit",
  gap: 6,
  padding: "4px 6px",
  textAlign: "left",
  width: "100%",
  color: "inherit",
};

const badgeStyle: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: 3,
  fontSize: 10,
  opacity: 0.85,
  padding: "0 4px",
  whiteSpace: "nowrap",
};

const PANEL_CSS = `
.rdccfg-btn {
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: ${colors.surfaceStrong};
  border: 1px solid ${colors.border};
  border-radius: 999px;
  padding: 3px 10px;
}
.rdccfg-btn:hover:not(:disabled) { background: ${colors.surface}; }
.rdccfg-btn:disabled { cursor: default; opacity: 0.5; }
.rdccfg-btn.danger { border-color: ${colors.danger}; color: ${colors.danger}; }
.rdccfg-row:hover { background: ${colors.surface}; }
`;

// ---------------------------------------------------------------------------
// 入力欄
// ---------------------------------------------------------------------------

/**
 * 確定してから書き込むテキスト入力。
 *
 * <p>🔴 <b>1文字ごとに書いてはいけない。</b> サーバーは書き込んだ値を購読者へ
 * ブロードキャストで返すため、往復の間に自分の入力が古い値で巻き戻る。
 *
 * <p>そこで「編集中はローカルの文字列を出し、確定で送って捨てる」形にする。
 * 捨てれば次に届いた値がそのまま表示になるので、<b>楽観的更新を自前で持たない</b>。
 * これは書き込みが拒否されたとき（foxgloveAllowControl が false）にも効く。
 * サーバーは書き込まずに現在値を返すので、そのまま元の値に戻る。
 */
const CommittedInput: React.FC<{
  kind: ConfigKind;
  value: unknown;
  disabled: boolean;
  isDark: boolean;
  onCommit: (value: number | string) => void;
  onError: (message: string) => void;
}> = ({ kind, value, disabled, isDark, onCommit, onError }) => {
  const [draft, setDraft] = useState<string | undefined>();
  const shown = draft ?? formatValue(value);

  const commit = () => {
    if (draft == undefined) {
      return;
    }
    const parsed = parseValue(kind, draft);
    // 捨てるのは成否にかかわらず。失敗を残すと、直すまで現在値が見えない
    setDraft(undefined);
    if (parsed.ok) {
      onCommit(parsed.value);
    } else {
      onError(parsed.message);
    }
  };

  return (
    <input
      type="text"
      style={inputStyle(isDark)}
      disabled={disabled}
      value={shown}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          // 確定したことが分かるようにフォーカスを外す
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(undefined);
          e.currentTarget.blur();
        }
      }}
    />
  );
};

/**
 * 配列の入力欄。
 *
 * <p><b>角括弧とカンマを人に打たせない。</b> 配列は描画するのだから、
 * 区切り文字を入力の一部にする理由が無い。
 * Swing は `Arrays.toString()` の結果をテキスト欄に出し、
 * 先頭と末尾の1文字を削って分割していた（括弧を消すと壊れる）。ここは素直に良くする。
 *
 * <p>parameter は配列を丸ごと置き換えるので、要素1つの変更でも全体を送る。
 */
const ArrayInput: React.FC<{
  kind: ConfigKind;
  value: unknown;
  disabled: boolean;
  isDark: boolean;
  onCommit: (value: ParameterValue) => void;
  onError: (message: string) => void;
}> = ({ kind, value, disabled, isDark, onCommit, onError }) => {
  const items = toArray(value);
  const itemKind = elementKind(kind);

  const replace = (index: number, next: number | string) => {
    const copy = [...items];
    copy[index] = next;
    onCommit(copy as ParameterValue);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {items.map((item, index) => (
        // 並べ替えない前提なので添字をキーにしてよい
        <div key={index} style={{ display: "flex", gap: 4 }}>
          <CommittedInput
            kind={itemKind}
            value={item}
            disabled={disabled}
            isDark={isDark}
            onCommit={(next) => {
              replace(index, next);
            }}
            onError={onError}
          />
          <button
            className="rdccfg-btn"
            disabled={disabled}
            title="この要素を削除"
            onClick={() => {
              onCommit(items.filter((_, i) => i !== index) as ParameterValue);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button
          className="rdccfg-btn"
          disabled={disabled}
          onClick={() => {
            onCommit([...items, emptyElement(kind)] as ParameterValue);
          }}
        >
          ＋ 要素を追加
        </button>
      </div>
    </div>
  );
};

/** 1つの葉の行 */
const LeafRow: React.FC<{
  node: ConfigNode;
  value: unknown;
  disabled: boolean;
  showPath: boolean;
  isDark: boolean;
  onSet: (path: string, value: ParameterValue) => void;
  onError: (message: string) => void;
}> = React.memo(({ node, value, disabled, showPath, isDark, onSet, onError }) => {
  const commit = useCallback(
    (next: ParameterValue) => {
      onSet(node.path, next);
    },
    [node.path, onSet],
  );

  let input: React.ReactNode;
  if (node.kind === "BOOL") {
    input = (
      <input
        type="checkbox"
        disabled={disabled}
        checked={value === true}
        onChange={(e) => {
          commit(e.target.checked);
        }}
      />
    );
  } else if (node.kind === "ENUM") {
    input = (
      <select
        style={inputStyle(isDark)}
        disabled={disabled}
        value={formatValue(value)}
        onChange={(e) => {
          commit(e.target.value);
        }}
      >
        {/* 現在値が選択肢に無いときに空欄へ落ちないようにする */}
        {!node.choices.includes(formatValue(value)) && (
          <option style={optionStyle(isDark)} value={formatValue(value)}>
            {formatValue(value)}（不明）
          </option>
        )}
        {node.choices.map((choice) => (
          <option key={choice} style={optionStyle(isDark)} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  } else if (isArrayKind(node.kind)) {
    input = (
      <ArrayInput
        kind={node.kind}
        value={value}
        disabled={disabled}
        isDark={isDark}
        onCommit={commit}
        onError={onError}
      />
    );
  } else {
    input = (
      <CommittedInput
        kind={node.kind}
        value={value}
        disabled={disabled}
        isDark={isDark}
        onCommit={commit}
        onError={onError}
      />
    );
  }

  return (
    <div className="rdccfg-row" style={rowStyle}>
      <div style={{ minWidth: 0 }}>
        {/* needsReboot / risky は受け取っているが行には出さない。
            約 200 行すべてに小さな札が散ると、名前を読む妨げになるほうが大きい。
            必要になったらツールチップか絞り込み条件として戻す */}
        <span>{node.label}</span>
        {showPath && (
          <div style={{ fontSize: 10, opacity: 0.6, wordBreak: "break-all" }}>{node.path}</div>
        )}
      </div>
      <div style={{ minWidth: 0 }}>{input}</div>
    </div>
  );
});
LeafRow.displayName = "LeafRow";

/** 枝と、その配下を描く */
const TreeItems: React.FC<{
  items: readonly TreeItem[];
  depth: number;
  expanded: { [path: string]: boolean };
  parameters: undefined | Immutable<Map<string, ParameterValue>>;
  disabled: boolean;
  showPaths: boolean;
  isDark: boolean;
  onToggle: (path: string) => void;
  onSet: (path: string, value: ParameterValue) => void;
  onError: (message: string) => void;
}> = ({ items, depth, expanded, parameters, disabled, showPaths, isDark, onToggle, onSet, onError }) => (
  <>
    {items.map((item) =>
      item.type === "leaf" ? (
        <LeafRow
          key={item.path}
          node={item.node}
          // 🔴 Map ごと渡さないこと。中身が変わるたびに参照が変わり、
          // React.memo が効かずに約 200 行すべてが再描画される
          value={parameters?.get(item.path)}
          disabled={disabled}
          showPath={showPaths}
          isDark={isDark}
          onSet={onSet}
          onError={onError}
        />
      ) : (
        <div key={item.path} style={{ marginLeft: depth === 0 ? 0 : 8 }}>
          <button
            style={groupHeaderStyle}
            onClick={() => {
              onToggle(item.path);
            }}
          >
            <span style={{ opacity: 0.7, width: 10 }}>{expanded[item.path] === true ? "▾" : "▸"}</span>
            <span style={{ fontWeight: 600 }}>{item.label}</span>
            <span style={{ marginLeft: "auto", opacity: 0.6 }}>{countLeaves(item.children)}</span>
          </button>
          {expanded[item.path] === true && (
            <TreeItems
              items={item.children}
              depth={depth + 1}
              expanded={expanded}
              parameters={parameters}
              disabled={disabled}
              showPaths={showPaths}
              isDark={isDark}
              onToggle={onToggle}
              onSet={onSet}
              onError={onError}
            />
          )}
        </div>
      ),
    )}
  </>
);

// ---------------------------------------------------------------------------
// パネル本体
// ---------------------------------------------------------------------------

const ConfigPanel: React.FC<{ context: PanelExtensionContext }> = ({ context }) => {
  const [state, setState] = useState<PanelState>(defaultState);
  const [nodes, setNodes] = useState<ConfigNode[] | undefined>();
  const [parameters, setParameters] = useState<
    undefined | Immutable<Map<string, ParameterValue>>
  >();
  const [status, setStatus] = useState<ServerStatus | undefined>();
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [saveAsName, setSaveAsName] = useState("");
  const [confirming, setConfirming] = useState<string | undefined>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const nextStatusId = useRef(1);
  // 既定の折りたたみを一度だけ当てる。以後は利用者の操作を上書きしない
  const appliedDefaults = useRef(false);

  const isDark = useIsDarkTheme(context.panelElement);

  const pushStatus = useCallback((kind: StatusKind, text: string): number => {
    const id = nextStatusId.current++;
    setStatuses((prev) =>
      [
        { id, kind, text, expiresAt: kind === "error" ? undefined : Date.now() + STATUS_FADE_MS },
        ...prev,
      ].slice(0, 3),
    );
    return id;
  }, []);

  const onError = useCallback(
    (message: string) => {
      pushStatus("error", message);
    },
    [pushStatus],
  );

  // --- Foxglove との接続 ---------------------------------------------------

  useLayoutEffect(() => {
    const saved = context.initialState as Partial<PanelState> | undefined;
    if (saved) {
      setState((prev) => ({ ...prev, ...saved, expanded: saved.expanded ?? prev.expanded }));
      if (saved.expanded && Object.keys(saved.expanded).length > 0) {
        appliedDefaults.current = true;
      }
    }
  }, [context]);

  useLayoutEffect(() => {
    context.saveState(state);
  }, [context, state]);

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setParameters(renderState.parameters);

      const frame = renderState.currentFrame;
      if (frame && frame.length > 0) {
        for (let i = frame.length - 1; i >= 0; i--) {
          const event = frame[i] as Immutable<MessageEvent> | undefined;
          if (!event) {
            continue;
          }
          if (event.topic === STATUS_TOPIC) {
            const next = normalizeStatus(event.message);
            if (next) {
              setStatus(next);
            }
            continue;
          }
          const layout = normalizeLayout(event.message);
          if (layout && layout.length > 0) {
            setNodes(layout);
          }
        }
      }
    };

    context.watch("currentFrame");
    context.watch("parameters");
  }, [context]);

  useEffect(() => {
    const subscriptions: Subscription[] = [{ topic: state.topic }, { topic: STATUS_TOPIC }];
    context.subscribe(subscriptions);
  }, [context, state.topic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // 期限の切れたステータス行を落とす
  useEffect(() => {
    const soonest = statuses.reduce<number | undefined>(
      (min, s) => (s.expiresAt == undefined ? min : Math.min(min ?? s.expiresAt, s.expiresAt)),
      undefined,
    );
    if (soonest == undefined) {
      return;
    }
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setStatuses((prev) => {
          const kept = prev.filter((s) => s.expiresAt == undefined || s.expiresAt > now);
          return kept.length === prev.length ? prev : kept;
        });
      },
      Math.max(0, soonest - Date.now()) + 20,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [statuses]);

  // 構えた確認を時間で解除する
  useEffect(() => {
    if (confirming == undefined) {
      return;
    }
    const timer = setTimeout(() => {
      setConfirming(undefined);
    }, CONFIRM_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [confirming]);

  // --- パネル設定 -----------------------------------------------------------

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
  }, [context, state.showPaths, state.topic]);

  // --- 木 -------------------------------------------------------------------

  const tree = useMemo(() => buildTree(nodes ?? []), [nodes]);
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);

  // 初回だけ 1 段目を開く
  useEffect(() => {
    if (appliedDefaults.current || tree.length === 0) {
      return;
    }
    appliedDefaults.current = true;
    const open: { [path: string]: boolean } = {};
    for (const path of defaultExpanded(tree)) {
      open[path] = true;
    }
    setState((prev) => ({ ...prev, expanded: { ...open, ...prev.expanded } }));
  }, [tree]);

  // 絞り込み中は一致した行を持つ枝をすべて開く。
  // 畳んだままだと「一致したのに何も出ない」に見える
  const effectiveExpanded = useMemo(() => {
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

  // --- 書き込みと呼び出し ---------------------------------------------------

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

  const callService = useCallback(
    (service: string, request: unknown, onDone?: (response: unknown) => void) => {
      const call = context.callService;
      if (!call) {
        pushStatus("error", "この接続はサービス呼び出しに対応していません");
        return;
      }
      pushStatus("pending", `${service} を呼び出し中…`);
      call(service, request).then(
        (response: unknown) => {
          const note = messageOf(response);
          pushStatus(
            isFailure(response) ? "error" : "info",
            `${service}: ${note.length > 0 ? note : "OK"}`,
          );
          onDone?.(response);
        },
        (error: unknown) => {
          pushStatus("error", `${service}: ${String(error)}`);
        },
      );
    },
    [context, pushStatus],
  );

  // ファイル一覧は開いたときと保存のたびに取り直す
  const refreshFiles = useCallback(() => {
    const call = context.callService;
    if (!call) {
      return;
    }
    call(SVC_LIST, {}).then(
      (response: unknown) => {
        setFiles(filesOf(response));
      },
      () => {
        // 一覧が取れなくても他の操作は続けられるので黙って諦める
      },
    );
  }, [context]);

  useEffect(refreshFiles, [refreshFiles]);

  const load = useCallback(
    (name: string, force: boolean) => {
      callService(SVC_LOAD, force ? { name, force: true } : { name }, (response) => {
        const record = response as Record<string, unknown> | undefined;
        if (isFailure(response) && record?.["dirty"] === true) {
          // 未保存があると既定で拒否される。破棄するかを聞いてから送り直す
          pushStatus(
            "error",
            `未保存の変更があります。保存するか、もう一度 ${name} を選んで「破棄して読み込む」を押してください`,
          );
          setConfirming(`load:${name}`);
        }
      });
    },
    [callService, pushStatus],
  );

  // --- 描画 -----------------------------------------------------------------

  const writable = status?.allowControl !== false;
  const total = countLeaves(tree);
  const shown = countLeaves(visible);

  return (
    <div style={rootStyle}>
      <style>{PANEL_CSS}</style>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        <input
          type="text"
          placeholder="名前で絞り込む"
          style={{ ...inputStyle(isDark), flex: "1 1 140px", width: "auto" }}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <span style={{ alignSelf: "center", opacity: 0.7 }}>
          {query.trim().length > 0 ? `${shown} / ${total}` : `${total} 件`}
        </span>
      </div>

      {!writable && (
        <div style={{ ...badgeStyle, color: colors.error, display: "block", marginBottom: 6 }}>
          config.foxgloveAllowControl が false のため読み取り専用です
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        <span style={{ alignSelf: "center" }}>
          {status?.configName ?? "?"}
          {status?.dirty === true ? " *" : ""}
        </span>
        <button
          className="rdccfg-btn"
          disabled={!writable}
          onClick={() => {
            callService(SVC_SAVE, {}, refreshFiles);
          }}
        >
          保存
        </button>
        <button
          className="rdccfg-btn danger"
          disabled={!writable}
          onClick={() => {
            if (confirming === "restart") {
              setConfirming(undefined);
              callService(SVC_RESTART, {});
            } else {
              setConfirming("restart");
            }
          }}
        >
          {confirming === "restart" ? "本当に再起動する？（接続が切れます）" : "再起動して反映"}
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <input
          type="text"
          placeholder="別名で保存するファイル名"
          style={{ ...inputStyle(isDark), flex: "1 1 140px", width: "auto" }}
          value={saveAsName}
          disabled={!writable}
          onChange={(e) => {
            setSaveAsName(e.target.value);
          }}
        />
        <button
          className="rdccfg-btn"
          disabled={!writable || saveAsName.trim().length === 0}
          onClick={() => {
            callService(SVC_SAVE_AS, { name: saveAsName.trim() }, () => {
              setSaveAsName("");
              refreshFiles();
            });
          }}
        >
          別名で保存
        </button>
        <select
          style={{ ...inputStyle(isDark), flex: "1 1 140px", width: "auto" }}
          disabled={!writable}
          value=""
          onChange={(e) => {
            const name = e.target.value;
            if (name.length === 0) {
              return;
            }
            load(name, confirming === `load:${name}`);
            setConfirming(undefined);
          }}
        >
          <option style={optionStyle(isDark)} value="">
            {confirming?.startsWith("load:") === true ? "破棄して読み込む…" : "読み込む…"}
          </option>
          {files.map((file) => (
            <option key={file} style={optionStyle(isDark)} value={file}>
              {file}
            </option>
          ))}
        </select>
      </div>

      {statuses.length > 0 && (
        <div style={{ marginBottom: 8 }}>
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
        <TreeItems
          items={visible}
          depth={0}
          expanded={effectiveExpanded}
          parameters={parameters}
          disabled={!writable}
          showPaths={state.showPaths}
          isDark={isDark}
          onToggle={toggleGroup}
          onSet={handleSet}
          onError={onError}
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
