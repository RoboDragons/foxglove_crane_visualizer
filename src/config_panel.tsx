/**
 * 設定パネル。Swing GUI の Config Editor（TreeTableCafe）に相当する。
 *
 * <p>値は ws-protocol の parameter で読み書きし、構造と型は `/config_layout` から受け取る。
 * parameter は JSON なので値しか運べず、0 が整数なのか小数なのか、
 * 文字列が自由入力なのか enum の定数名なのかを判別できないため、型を別立てで貰う。
 *
 * <p><b>見た目は Swing の表に寄せてある。</b> 最初は全行に入力欄の箱を常に出していたが、
 * 並べて比べると Swing のほうがはっきり読みやすかった。差の大半は
 * 「値は文字で表示し、クリックしたときだけ入力欄にする」ことから来ていた。
 * 200 個の箱が並ぶとそれだけで画面がうるさく、行も高くなる。
 * あわせて列見出し・縦横の罫線・数値の右寄せ・木の接続線も Swing に合わせた。
 *
 * <p>Swing に無いもの（名前での絞り込み、列挙のドロップダウン、括弧を打たない配列の編集）は
 * こちらの利点として残してある。
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
  TreeItem,
  allGroupPaths,
  buildTree,
  countLeaves,
  displayValue,
  elementKind,
  emptyElement,
  filterTree,
  formatValue,
  isArrayKind,
  isNumericKind,
  normalizeLayout,
  parseValue,
  toArray,
} from "./config_tree";
import { colors, inputColors, inputStyle, optionStyle, useIsDarkTheme } from "./panel_theme";

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

/** 名前の列の既定の幅[px] */
const DEFAULT_NAME_WIDTH = 220;
/** 名前の列の幅の下限と上限[px]。ドラッグで潰したり広げすぎたりしないため */
const MIN_NAME_WIDTH = 100;
const MAX_NAME_WIDTH = 600;
/** 1段ぶんの字下げ[px]。接続線はこの幅の中央に引く */
const INDENT_PX = 14;

/** パネルに永続化する状態 */
interface PanelState {
  topic: string;
  /** 枝のパス -> 開いているか。畳んだ状態を憶える */
  expanded: { [path: string]: boolean };
  /** 完全な名前（パス）を各行に出すか */
  showPaths: boolean;
  /** 名前の列の幅[px]。見出しの境界をドラッグして変える */
  nameWidth: number;
}

const defaultState: PanelState = {
  topic: DEFAULT_TOPIC,
  expanded: {},
  showPaths: false,
  nameWidth: DEFAULT_NAME_WIDTH,
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

/**
 * 表の行の高さ[px]。
 *
 * <p>Swing と同程度まで詰める。約 200 行を見渡す画面では、
 * 1 画面に入る行数がそのまま読みやすさになる。
 */
const ROW_HEIGHT = 20;

const PANEL_CSS = `
.rdccfg-btn {
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: ${colors.surfaceStrong};
  border: 1px solid ${colors.border};
  border-radius: 999px;
  padding: 2px 10px;
}
.rdccfg-btn:hover:not(:disabled) { background: ${colors.surface}; }
.rdccfg-btn:disabled { cursor: default; opacity: 0.5; }
.rdccfg-btn.danger { border-color: ${colors.danger}; color: ${colors.danger}; }
.rdccfg-row { height: ${ROW_HEIGHT}px; }
.rdccfg-row:hover { background: ${colors.surface}; }
.rdccfg-value.editable { cursor: text; }
.rdccfg-value.editable:hover { background: ${colors.surfaceStrong}; }
.rdccfg-x {
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: none;
  border: none;
  opacity: 0.6;
  padding: 0 3px;
}
.rdccfg-x:hover:not(:disabled) { opacity: 1; }
.rdccfg-x:disabled { cursor: default; opacity: 0.25; }
`;

/** 表の1行。名前と値の2列で、罫線は Swing と同じく縦横に引く */
function rowStyle(nameWidth: number): React.CSSProperties {
  return {
    borderBottom: `1px solid ${colors.subtleBorder}`,
    display: "grid",
    gridTemplateColumns: `${nameWidth}px 1fr`,
  };
}

const nameCellStyle: React.CSSProperties = {
  alignItems: "center",
  borderRight: `1px solid ${colors.subtleBorder}`,
  display: "flex",
  minWidth: 0,
  overflow: "hidden",
  paddingRight: 6,
  whiteSpace: "nowrap",
};

function valueCellStyle(kind: ConfigKind): React.CSSProperties {
  return {
    alignItems: "center",
    display: "flex",
    // 数値は右寄せにして桁を揃える。8083 と 180 の大小が一目で読める
    justifyContent: isNumericKind(kind) ? "flex-end" : "flex-start",
    minWidth: 0,
    overflow: "hidden",
    padding: "0 6px",
    whiteSpace: "nowrap",
  };
}

/** 編集中の入力欄。行の高さを押し上げないように上下の余白を削る */
function editorStyle(isDark: boolean, kind: ConfigKind): React.CSSProperties {
  return {
    ...inputStyle(isDark),
    height: ROW_HEIGHT - 2,
    padding: "0 4px",
    textAlign: isNumericKind(kind) ? "right" : "left",
  };
}

// ---------------------------------------------------------------------------
// 字下げと接続線
// ---------------------------------------------------------------------------

/**
 * 木の字下げ。段ごとに縦の接続線を引く。
 *
 * <p>Swing の木は接続線とフォルダのアイコンで階層を示していて、
 * 枝と葉が交互に並んでも混乱しない。色の帯で示すより静かで、行の高さも増やさない。
 */
const Indent: React.FC<{ depth: number }> = ({ depth }) => (
  <>
    {Array.from({ length: depth }, (_, i) => (
      <span
        key={i}
        style={{
          alignSelf: "stretch",
          borderLeft: `1px solid ${colors.subtleBorder}`,
          flex: "0 0 auto",
          marginLeft: INDENT_PX / 2,
          width: INDENT_PX / 2,
        }}
      />
    ))}
  </>
);

// ---------------------------------------------------------------------------
// 値のセル
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
  isDark: boolean;
  /** 中身の長さに合わせて幅を決める。配列の要素を横に並べるときに使う */
  fitContent?: boolean;
  autoFocus?: boolean;
  onCommit: (value: number | string) => void;
  onError: (message: string) => void;
  /** 確定・取り消しのあとに呼ぶ。表の行を表示に戻すために使う */
  onDone?: () => void;
}> = ({ kind, value, isDark, fitContent, autoFocus, onCommit, onError, onDone }) => {
  const [draft, setDraft] = useState<string | undefined>();
  // Escape で取り消したことを blur に伝える。state では間に合わない。
  // setDraft(undefined) は次の描画まで反映されず、直後の blur が握っている draft は
  // 古いままなので、取り消したはずの入力がそのまま確定してしまう
  const cancelled = useRef(false);
  const shown = draft ?? formatValue(value);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(undefined);
    } else if (draft != undefined) {
      const parsed = parseValue(kind, draft);
      // 捨てるのは成否にかかわらず。失敗を残すと、直すまで現在値が見えない
      setDraft(undefined);
      if (parsed.ok) {
        onCommit(parsed.value);
      } else {
        onError(parsed.message);
      }
    }
    onDone?.();
  };

  return (
    <input
      type="text"
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={autoFocus}
      style={
        fitContent === true
          ? // 2ch ぶん余らせるのは、1文字打ち足したときに箱が伸びる前に
            // 文字が隠れないようにするため
            { ...editorStyle(isDark, kind), width: `${Math.max(4, shown.length + 2)}ch` }
          : editorStyle(isDark, kind)
      }
      value={shown}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      onFocus={(e) => {
        e.currentTarget.select();
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
};

/**
 * 配列の編集。
 *
 * <p><b>角括弧とカンマを人に打たせない。</b> 要素を横に並べて折り返し、
 * 1つずつ直す。Swing は `Arrays.toString()` の結果をテキスト欄に出し、
 * 先頭と末尾の1文字を削って分割していた（括弧を消すと壊れる）。
 *
 * <p>parameter は配列を丸ごと置き換えるので、要素1つの変更でも全体を送る。
 * フォーカスがこの中から出たら表示に戻る。
 */
const ArrayEditor: React.FC<{
  kind: ConfigKind;
  value: unknown;
  isDark: boolean;
  onCommit: (value: ParameterValue) => void;
  onError: (message: string) => void;
  onDone: () => void;
}> = ({ kind, value, isDark, onCommit, onError, onDone }) => {
  const items = toArray(value);
  const itemKind = elementKind(kind);

  return (
    <div
      style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 2 }}
      onKeyDown={(e) => {
        // 要素を消すとフォーカスしていたボタンごと DOM から消え、blur が来ないことがある。
        // そのとき閉じる手段が無くならないように Escape でも抜けられるようにする
        if (e.key === "Escape") {
          onDone();
        }
      }}
      onBlur={(e) => {
        // 中の別の要素へ移っただけなら閉じない
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          onDone();
        }
      }}
    >
      {items.map((item, index) => (
        // 並べ替えない前提なので添字をキーにしてよい
        <span key={index} style={{ alignItems: "center", display: "inline-flex" }}>
          <CommittedInput
            kind={itemKind}
            value={item}
            isDark={isDark}
            fitContent
            autoFocus={index === 0}
            onCommit={(next) => {
              const copy = [...items];
              copy[index] = next;
              onCommit(copy as ParameterValue);
            }}
            onError={onError}
          />
          <button
            className="rdccfg-x"
            title="この要素を削除"
            onClick={() => {
              onCommit(items.filter((_, i) => i !== index) as ParameterValue);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <button
        className="rdccfg-x"
        title="要素を追加"
        autoFocus={items.length === 0}
        onClick={() => {
          onCommit([...items, emptyElement(kind)] as ParameterValue);
        }}
      >
        ＋
      </button>
    </div>
  );
};

/**
 * 値のセル。<b>普段は文字で表示し、クリックで編集に切り替える。</b>
 *
 * <p>真偽値だけは例外で、チェックボックスを常に出す（Swing と同じ）。
 * 1クリックで切り替わるものに「編集に入る」段階を挟む意味が無い。
 */
const ValueCell: React.FC<{
  node: ConfigNode;
  value: unknown;
  disabled: boolean;
  editing: boolean;
  isDark: boolean;
  onEdit: (path: string | undefined) => void;
  onSet: (path: string, value: ParameterValue) => void;
  onError: (message: string) => void;
}> = ({ node, value, disabled, editing, isDark, onEdit, onSet, onError }) => {
  const commit = (next: ParameterValue) => {
    onSet(node.path, next);
  };
  const done = () => {
    onEdit(undefined);
  };

  if (node.kind === "BOOL") {
    return (
      <div style={valueCellStyle(node.kind)}>
        <input
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          style={{ margin: 0 }}
          onChange={(e) => {
            commit(e.target.checked);
          }}
        />
      </div>
    );
  }

  if (editing && !disabled) {
    let editor: React.ReactNode;
    if (node.kind === "ENUM") {
      editor = (
        <select
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          style={editorStyle(isDark, node.kind)}
          value={formatValue(value)}
          onChange={(e) => {
            commit(e.target.value);
            done();
          }}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              done();
            }
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
      editor = (
        <ArrayEditor
          kind={node.kind}
          value={value}
          isDark={isDark}
          onCommit={commit}
          onError={onError}
          onDone={done}
        />
      );
    } else {
      editor = (
        <CommittedInput
          kind={node.kind}
          value={value}
          isDark={isDark}
          autoFocus
          onCommit={commit}
          onError={onError}
          onDone={done}
        />
      );
    }
    return (
      <div
        style={{
          ...valueCellStyle(node.kind),
          // 配列の編集は折り返すので、このセルだけ行の高さを超えてよい
          overflow: "visible",
          whiteSpace: "normal",
        }}
      >
        <div style={{ width: "100%" }}>{editor}</div>
      </div>
    );
  }

  const text = displayValue(node.kind, value);
  return (
    <div
      className={`rdccfg-value${disabled ? "" : " editable"}`}
      style={valueCellStyle(node.kind)}
      title={text}
      onClick={() => {
        if (!disabled) {
          onEdit(node.path);
        }
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 行
// ---------------------------------------------------------------------------

/** 葉の行 */
const LeafRow: React.FC<{
  node: ConfigNode;
  depth: number;
  value: unknown;
  disabled: boolean;
  editing: boolean;
  showPath: boolean;
  nameWidth: number;
  isDark: boolean;
  onEdit: (path: string | undefined) => void;
  onSet: (path: string, value: ParameterValue) => void;
  onError: (message: string) => void;
}> = React.memo(
  ({ node, depth, value, disabled, editing, showPath, nameWidth, isDark, onEdit, onSet, onError }) => (
    <div
      className="rdccfg-row"
      // 配列を編集している行だけは折り返しで伸びてよい
      style={{ ...rowStyle(nameWidth), height: editing ? "auto" : undefined, minHeight: ROW_HEIGHT }}
    >
      <div style={nameCellStyle} title={node.path}>
        <Indent depth={depth} />
        {/* 枝の矢印と頭を揃えるための空き */}
        <span style={{ flex: "0 0 auto", width: 14 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {showPath ? node.path : node.label}
        </span>
      </div>
      <ValueCell
        node={node}
        value={value}
        disabled={disabled}
        editing={editing}
        isDark={isDark}
        onEdit={onEdit}
        onSet={onSet}
        onError={onError}
      />
    </div>
  ),
);
LeafRow.displayName = "LeafRow";

/** 枝の行。値の列には配下の件数を薄く出す */
const GroupRow: React.FC<{
  label: string;
  depth: number;
  open: boolean;
  count: number;
  nameWidth: number;
  onToggle: () => void;
}> = ({ label, depth, open, count, nameWidth, onToggle }) => (
  <div
    className="rdccfg-row"
    style={{ ...rowStyle(nameWidth), cursor: "pointer" }}
    onClick={onToggle}
  >
    <div style={nameCellStyle}>
      <Indent depth={depth} />
      <span style={{ flex: "0 0 auto", opacity: 0.7, textAlign: "center", width: 14 }}>
        {open ? "▾" : "▸"}
      </span>
      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
    </div>
    <div style={{ ...valueCellStyle("STRING"), opacity: 0.5 }}>{count}</div>
  </div>
);

/** 木を再帰的に描く */
const TreeRows: React.FC<{
  items: readonly TreeItem[];
  depth: number;
  expanded: { [path: string]: boolean };
  parameters: undefined | Immutable<Map<string, ParameterValue>>;
  disabled: boolean;
  editing: string | undefined;
  showPaths: boolean;
  nameWidth: number;
  isDark: boolean;
  onToggle: (path: string) => void;
  onEdit: (path: string | undefined) => void;
  onSet: (path: string, value: ParameterValue) => void;
  onError: (message: string) => void;
}> = (props) => {
  const { items, depth, expanded } = props;
  return (
    <>
      {items.map((item) =>
        item.type === "leaf" ? (
          <LeafRow
            key={item.path}
            node={item.node}
            depth={depth}
            // 🔴 Map ごと渡さないこと。中身が変わるたびに参照が変わり、
            // React.memo が効かずに約 200 行すべてが再描画される
            value={props.parameters?.get(item.path)}
            disabled={props.disabled}
            editing={props.editing === item.path}
            showPath={props.showPaths}
            nameWidth={props.nameWidth}
            isDark={props.isDark}
            onEdit={props.onEdit}
            onSet={props.onSet}
            onError={props.onError}
          />
        ) : (
          <React.Fragment key={item.path}>
            <GroupRow
              label={item.label}
              depth={depth}
              open={expanded[item.path] === true}
              count={countLeaves(item.children)}
              nameWidth={props.nameWidth}
              onToggle={() => {
                props.onToggle(item.path);
              }}
            />
            {expanded[item.path] === true && (
              <TreeRows {...props} items={item.children} depth={depth + 1} />
            )}
          </React.Fragment>
        ),
      )}
    </>
  );
};

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
  const [showFileOps, setShowFileOps] = useState(false);
  /** 編集中の葉のパス。同時に編集できるのは1行だけ */
  const [editing, setEditing] = useState<string | undefined>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const nextStatusId = useRef(1);

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

  // 並びは宣言順のまま。Swing や config.json と順番が一致する。
  // 枝と葉が交互に並んでも、矢印と接続線があれば読める
  const tree = useMemo(() => buildTree(nodes ?? []), [nodes]);
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);

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

  // --- 名前の列の幅 ---------------------------------------------------------

  /**
   * 見出しの境界をドラッグして名前の列の幅を変える。
   *
   * <p>Swing の表と同じ操作。深い階層では名前が字下げぶん右にずれるので、
   * 幅を固定にすると長い名前が切れる。
   */
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = state.nameWidth;
      const view = context.panelElement.ownerDocument.defaultView;
      if (!view) {
        return;
      }
      const onMove = (move: MouseEvent) => {
        const next = Math.min(
          MAX_NAME_WIDTH,
          Math.max(MIN_NAME_WIDTH, startWidth + move.clientX - startX),
        );
        setState((prev) => (prev.nameWidth === next ? prev : { ...prev, nameWidth: next }));
      };
      const onUp = () => {
        view.removeEventListener("mousemove", onMove);
        view.removeEventListener("mouseup", onUp);
      };
      view.addEventListener("mousemove", onMove);
      view.addEventListener("mouseup", onUp);
    },
    [context.panelElement, state.nameWidth],
  );

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
  const scheme = isDark ? inputColors.dark : inputColors.light;

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
      <style>{PANEL_CSS}</style>

      {/* 常時出すのは絞り込みだけ。ファイル操作は本文より使う頻度がずっと低いので、
          設定ファイル名のボタンで開閉する */}
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
          {query.trim().length > 0 ? `${shown} / ${total}` : `${total}`}
        </span>
        <button
          className="rdccfg-btn"
          title="ファイル操作"
          onClick={() => {
            setShowFileOps((prev) => !prev);
          }}
        >
          {status?.configName ?? "?"}
          {status?.dirty === true ? " *" : ""}
        </button>
      </div>

      {!writable && (
        <div style={{ color: colors.error, marginBottom: 6 }}>
          config.foxgloveAllowControl が false のため読み取り専用です
        </div>
      )}

      {showFileOps && (
        <div
          style={{
            border: `1px solid ${colors.subtleBorder}`,
            borderRadius: 4,
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 6,
            padding: 6,
          }}
        >
          <button
            className="rdccfg-btn"
            disabled={!writable}
            onClick={() => {
              callService(SVC_SAVE, {}, refreshFiles);
            }}
          >
            保存
          </button>
          <input
            type="text"
            placeholder="別名で保存するファイル名"
            style={{ ...inputStyle(isDark), flex: "1 1 120px", padding: "2px 6px", width: "auto" }}
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
            style={{ ...inputStyle(isDark), flex: "1 1 120px", padding: "2px 6px", width: "auto" }}
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
          {/* 押す頻度は保存よりずっと低い。構えるまでは他のボタンと同じ見た目にして、
              確認待ちのときだけ赤くする */}
          <button
            className={`rdccfg-btn${confirming === "restart" ? " danger" : ""}`}
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
        // 表だけをスクロールさせ、見出しは上端に貼り付ける
        <div
          style={{
            border: `1px solid ${colors.border}`,
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              ...rowStyle(state.nameWidth),
              // 下を流れる行が透けないように不透明にする
              background: scheme.background,
              borderBottom: `1px solid ${colors.border}`,
              fontWeight: 600,
              height: ROW_HEIGHT + 2,
              position: "sticky",
              top: 0,
              zIndex: 1,
            }}
          >
            <div style={{ ...nameCellStyle, justifyContent: "center", position: "relative" }}>
              config
              {/* 境界をつまんで名前の列の幅を変える */}
              <span
                title="ドラッグして幅を変える"
                style={{
                  bottom: 0,
                  cursor: "col-resize",
                  position: "absolute",
                  right: -3,
                  top: 0,
                  width: 6,
                }}
                onMouseDown={startResize}
              />
            </div>
            <div style={{ ...valueCellStyle("STRING"), justifyContent: "center" }}>value</div>
          </div>
          <TreeRows
            items={visible}
            depth={0}
            expanded={effectiveExpanded}
            parameters={parameters}
            disabled={!writable}
            editing={editing}
            showPaths={state.showPaths}
            nameWidth={state.nameWidth}
            isDark={isDark}
            onToggle={toggleGroup}
            onEdit={setEditing}
            onSet={handleSet}
            onError={onError}
          />
        </div>
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
