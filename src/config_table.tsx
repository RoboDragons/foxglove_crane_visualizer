/**
 * 設定パネルの表。見た目は Swing の Config Editor（TreeTableCafe）に寄せてある。
 *
 * <p>最初は全行に入力欄の箱を常に出していたが、Swing と並べて比べると
 * Swing のほうがはっきり読みやすかった。差の大半は
 * 「値は文字で表示し、クリックしたときだけ入力欄にする」ことから来ていた。
 * あわせて列見出し・縦横の罫線・数値の右寄せ・木の接続線も Swing に合わせた。
 *
 * <p><b>編集中も表の見た目を崩さない。</b> 入力欄は箱を持たず、
 * セルの中でそのまま文字を直す形にする。編集に入った途端に別の部品に
 * 置き換わると、どこを直しているのかを見失う。
 */

import { Immutable, ParameterValue } from "@foxglove/studio";
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ConfigKind,
  ConfigNode,
  TreeItem,
  countLeaves,
  displayValue,
  formatValue,
  isArrayKind,
  isNumericKind,
  parseArray,
  parseValue,
} from "./config_tree";
import { colors, inputColors, optionStyle } from "./panel_theme";

/**
 * 表の行の高さ[px]。
 *
 * <p>Swing と同程度まで詰める。約 200 行を見渡す画面では、
 * 1 画面に入る行数がそのまま読みやすさになる。
 */
const ROW_HEIGHT = 20;
/** 1段ぶんの字下げ[px]。接続線はこの幅の中央に引く */
const INDENT_PX = 14;
/** 値のセルの左右の余白[px]。表示と編集で文字の位置をずらさないために共有する */
const CELL_PADDING_X = 6;
/** 名前の列の幅の下限と上限[px]。ドラッグで潰したり広げすぎたりしないため */
const MIN_NAME_WIDTH = 100;
const MAX_NAME_WIDTH = 600;

export const TABLE_CSS = `
.rdccfg-row { min-height: ${ROW_HEIGHT}px; }
.rdccfg-row:hover { background: ${colors.surface}; }
.rdccfg-value.editable { cursor: text; }
.rdccfg-value.editable:hover { background: ${colors.surfaceStrong}; }
`;

// ---------------------------------------------------------------------------
// スタイル
// ---------------------------------------------------------------------------

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
    padding: `0 ${CELL_PADDING_X}px`,
    whiteSpace: "nowrap",
  };
}

/**
 * 編集中の入力欄。<b>箱を持たず、セルそのものを編集中にする。</b>
 *
 * <p>背景・枠・角丸を消し、編集中であることは細い強調色の縁だけで示す。
 * 左右の余白は表示のときと同じにして、文字が動かないようにする。
 */
function editorStyle(isDark: boolean, kind: ConfigKind): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    boxSizing: "border-box",
    color: "inherit",
    // select のドロップダウン一覧はブラウザが描くので、配色を明示しないと読めなくなる
    colorScheme: isDark ? "dark" : "light",
    font: "inherit",
    height: ROW_HEIGHT - 1,
    outline: `1px solid ${colors.accent}`,
    outlineOffset: -1,
    padding: `0 ${CELL_PADDING_X}px`,
    textAlign: isNumericKind(kind) ? "right" : "left",
    width: "100%",
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
// 編集
// ---------------------------------------------------------------------------

type Parse = (text: string) => { ok: true; value: ParameterValue } | { ok: false; message: string };

/**
 * その場で文字を直す入力欄。確定してから書き込む。
 *
 * <p>🔴 <b>1文字ごとに書いてはいけない。</b> サーバーは書き込んだ値を購読者へ
 * ブロードキャストで返すため、往復の間に自分の入力が古い値で巻き戻る。
 * 編集中の文字はここだけで持ち、確定で送る。送ったあとは表示に戻るので、
 * 次に届いた値がそのまま出る。<b>楽観的更新は持たない。</b>
 * 書き込みが拒否されたとき（foxgloveAllowControl が false）もそのまま元の値に戻る。
 *
 * <p>配列も同じ部品で直す。表示と同じ `0, 1, 2` の文字をそのまま編集するので、
 * 括弧も要素ごとの削除ボタンも要らない。
 */
const InPlaceText: React.FC<{
  kind: ConfigKind;
  initial: string;
  isDark: boolean;
  parse: Parse;
  onCommit: (value: ParameterValue) => void;
  onError: (message: string) => void;
  onDone: () => void;
}> = ({ kind, initial, isDark, parse, onCommit, onError, onDone }) => {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Escape で取り消したことを blur に伝える。state では間に合わない。
  // 次の描画まで反映されないので、直後の blur が古い文字を確定してしまう
  const cancelled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = () => {
    if (!cancelled.current && text !== initial) {
      const parsed = parse(text);
      if (parsed.ok) {
        onCommit(parsed.value);
      } else {
        onError(parsed.message);
      }
    }
    onDone();
  };

  return (
    <input
      ref={ref}
      type="text"
      style={editorStyle(isDark, kind)}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
      }}
      onBlur={finish}
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

/** 列挙のドロップダウン。選んだ時点で確定する */
const InPlaceEnum: React.FC<{
  node: ConfigNode;
  value: unknown;
  isDark: boolean;
  onCommit: (value: ParameterValue) => void;
  onDone: () => void;
}> = ({ node, value, isDark, onCommit, onDone }) => {
  const ref = useRef<HTMLSelectElement>(null);
  const current = formatValue(value);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <select
      ref={ref}
      style={editorStyle(isDark, node.kind)}
      value={current}
      onChange={(e) => {
        onCommit(e.target.value);
        onDone();
      }}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onDone();
        }
      }}
    >
      {/* 現在値が選択肢に無いときに空欄へ落ちないようにする */}
      {!node.choices.includes(current) && (
        <option style={optionStyle(isDark)} value={current}>
          {current}（不明）
        </option>
      )}
      {node.choices.map((choice) => (
        <option key={choice} style={optionStyle(isDark)} value={choice}>
          {choice}
        </option>
      ))}
    </select>
  );
};

/** 種類ごとに入力欄の文字を値へ読む関数を選ぶ */
function parserFor(kind: ConfigKind): Parse {
  return isArrayKind(kind)
    ? (text) => parseArray(kind, text)
    : (text) => parseValue(kind, text);
}

// ---------------------------------------------------------------------------
// セルと行
// ---------------------------------------------------------------------------

/**
 * 値のセル。普段は文字で表示し、クリックで編集に切り替える。
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

  const text = displayValue(node.kind, value);

  if (editing && !disabled) {
    return (
      // 編集中は余白を入力欄の側に持たせる。セルに残すと文字が右へずれる
      <div style={{ ...valueCellStyle(node.kind), padding: 0 }}>
        {node.kind === "ENUM" ? (
          <InPlaceEnum
            node={node}
            value={value}
            isDark={isDark}
            onCommit={commit}
            onDone={done}
          />
        ) : (
          <InPlaceText
            kind={node.kind}
            initial={text}
            isDark={isDark}
            parse={parserFor(node.kind)}
            onCommit={commit}
            onError={onError}
            onDone={done}
          />
        )}
      </div>
    );
  }

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
}> = React.memo((props) => (
  <div className="rdccfg-row" style={rowStyle(props.nameWidth)}>
    <div style={nameCellStyle} title={props.node.path}>
      <Indent depth={props.depth} />
      {/* 枝の矢印と頭を揃えるための空き */}
      <span style={{ flex: "0 0 auto", width: 14 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {props.showPath ? props.node.path : props.node.label}
      </span>
    </div>
    <ValueCell
      node={props.node}
      value={props.value}
      disabled={props.disabled}
      editing={props.editing}
      isDark={props.isDark}
      onEdit={props.onEdit}
      onSet={props.onSet}
      onError={props.onError}
    />
  </div>
));
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

interface TreeRowsProps {
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
}

/** 木を再帰的に描く */
const TreeRows: React.FC<TreeRowsProps> = (props) => (
  <>
    {props.items.map((item) =>
      item.type === "leaf" ? (
        <LeafRow
          key={item.path}
          node={item.node}
          depth={props.depth}
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
            depth={props.depth}
            open={props.expanded[item.path] === true}
            count={countLeaves(item.children)}
            nameWidth={props.nameWidth}
            onToggle={() => {
              props.onToggle(item.path);
            }}
          />
          {props.expanded[item.path] === true && (
            <TreeRows {...props} items={item.children} depth={props.depth + 1} />
          )}
        </React.Fragment>
      ),
    )}
  </>
);

// ---------------------------------------------------------------------------
// 表
// ---------------------------------------------------------------------------

/**
 * 見出しの境界をドラッグして名前の列の幅を変える。
 *
 * <p>Swing の表と同じ操作。深い階層では名前が字下げぶん右にずれるので、
 * 幅を固定にすると長い名前が切れる。
 */
function useColumnResize(
  element: HTMLElement,
  width: number,
  onChange: (width: number) => void,
): (e: React.MouseEvent) => void {
  return useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const view = element.ownerDocument.defaultView;
      if (!view) {
        return;
      }
      const startX = e.clientX;
      const onMove = (move: MouseEvent) => {
        onChange(Math.min(MAX_NAME_WIDTH, Math.max(MIN_NAME_WIDTH, width + move.clientX - startX)));
      };
      const onUp = () => {
        view.removeEventListener("mousemove", onMove);
        view.removeEventListener("mouseup", onUp);
      };
      view.addEventListener("mousemove", onMove);
      view.addEventListener("mouseup", onUp);
    },
    [element, width, onChange],
  );
}

/**
 * 表全体。見出しは上端に貼り付け、行だけをスクロールさせる。
 *
 * <p>どの行を編集しているかはここで持つ。同時に編集できるのは1行だけ。
 */
export const ConfigTable: React.FC<{
  panelElement: HTMLElement;
  items: readonly TreeItem[];
  expanded: { [path: string]: boolean };
  parameters: undefined | Immutable<Map<string, ParameterValue>>;
  disabled: boolean;
  showPaths: boolean;
  nameWidth: number;
  isDark: boolean;
  onToggle: (path: string) => void;
  onNameWidthChange: (width: number) => void;
  onSet: (path: string, value: ParameterValue) => void;
  onError: (message: string) => void;
}> = ({ panelElement, nameWidth, onNameWidthChange, isDark, ...rest }) => {
  const [editing, setEditing] = useState<string | undefined>();
  const startResize = useColumnResize(panelElement, nameWidth, onNameWidthChange);
  const background = isDark ? inputColors.dark.background : inputColors.light.background;

  return (
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
          ...rowStyle(nameWidth),
          // 下を流れる行が透けないように不透明にする
          background,
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
        {...rest}
        depth={0}
        editing={editing}
        nameWidth={nameWidth}
        isDark={isDark}
        onEdit={setEditing}
      />
    </div>
  );
};
