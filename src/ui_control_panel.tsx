import {
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  ParameterValue,
  SettingsTree,
  SettingsTreeAction,
  Subscription,
  Topic,
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
import { colors, inputColors, inputStyle, optionStyle, useIsDarkTheme } from "./panel_theme";

const DEFAULT_TOPIC = "/ui_layout";
const UNGROUPED_LABEL = "General";
// int_range をドロップダウンで出す上限。これを超えたら数値入力にフォールバックする
const MAX_RANGE_OPTIONS = 500;
// confirm 付きボタンを構えたままにする時間[ms]。過ぎたら元のラベルに戻す。
// 短すぎると読む前に戻り、長すぎると次の操作のつもりの1クリックで実行してしまう
const CONFIRM_TIMEOUT_MS = 4000;
// 成功と呼び出し中の行を残す時間[ms]。エラーは消さない
const STATUS_FADE_MS = 6000;
// ステータス行の最大件数。連打したときに何件目の応答かが分かればよい
const MAX_STATUS_ROWS = 3;
// id_toggles の None を構えているかどうかの識別子。1つのコントロールに1つしかない
const NONE_KEY = "none";

/** foxglove.UiControl に対応する型。proto3 のデフォルト値を埋めた正規化済みの形 */
interface UiControl {
  label: string;
  kind: string;
  parameter: string;
  service: string;
  payload: string;
  choices: string[];
  group: string;
  labels: string[];
  columns: number;
  min: number;
  max: number;
  /** 押すと取り返しがつかない操作か。立っていたら二段階で実行する */
  confirm: boolean;
  /** enum_matrix の行見出し。choices は行優先なので i 行 j 列は choices[i * columns + j] */
  rows: string[];
  /** enum_matrix の列見出し。columns と同じ長さ */
  headers: string[];
  /** 選択肢ごとのチーム色。並びは choices と同じ。kind="button" には付けない */
  tones: string[];
  /** コントロール全体のチーム。id_toggles の「選択中」の塗りをこの色にする */
  team: string;
  /** 折りたたんだセクション見出しに現在値を出すか */
  summary: boolean;
}

/** パネルに永続化する状態 */
interface PanelState {
  topic: string;
  /** group 名 -> 折りたたみ中かどうか */
  collapsed: { [group: string]: boolean };
  /** 各コントロールの下に parameter 名を出すか（デバッグ用） */
  showParameterNames: boolean;
}

const defaultState: PanelState = {
  topic: DEFAULT_TOPIC,
  collapsed: {},
  showParameterNames: false,
};

type StatusKind = "info" | "error" | "pending";

/**
 * ステータス行1件。
 *
 * <p>意味は「サービス呼び出しの結果と失敗」に揃えてある。
 * parameter の書き込みは現在値がコントロール自身に映るので、ここには出さない。
 */
interface Status {
  /** 呼び出し中の行を、応答が返った時点で置き換えるための識別子 */
  id: number;
  kind: StatusKind;
  text: string;
  /** mm:ss。連打したとき、どれが新しい応答かを読むために付ける */
  time: string;
  /** この時刻を過ぎたら消す。エラーは undefined にして残す */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// メッセージの正規化
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry : String(entry)));
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 受信メッセージの1コントロールを UiControl に正規化する。壊れていたら undefined */
function normalizeControl(raw: unknown): UiControl | undefined {
  if (raw == undefined || typeof raw !== "object") {
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  const kind = toStringField(src["kind"]);
  if (kind.length === 0) {
    return undefined;
  }
  return {
    label: toStringField(src["label"]),
    kind,
    parameter: toStringField(src["parameter"]),
    service: toStringField(src["service"]),
    payload: toStringField(src["payload"]),
    choices: toStringArray(src["choices"]),
    group: toStringField(src["group"]),
    labels: toStringArray(src["labels"]),
    columns: Math.trunc(toNumber(src["columns"], 0)),
    min: toNumber(src["min"], 0),
    max: toNumber(src["max"], 0),
    confirm: src["confirm"] === true,
    rows: toStringArray(src["rows"]),
    headers: toStringArray(src["headers"]),
    tones: toStringArray(src["tones"]),
    team: toStringField(src["team"]),
    summary: src["summary"] === true,
  };
}

/** foxglove.UiLayout メッセージから controls を取り出す。取り出せなければ undefined */
function normalizeLayout(message: unknown): UiControl[] | undefined {
  if (message == undefined || typeof message !== "object") {
    return undefined;
  }
  const controls = (message as Record<string, unknown>)["controls"];
  if (!Array.isArray(controls)) {
    return undefined;
  }
  const normalized: UiControl[] = [];
  for (const raw of controls) {
    const control = normalizeControl(raw);
    if (control) {
      normalized.push(control);
    }
  }
  return normalized;
}

/**
 * 選択中かどうかの判定に使う文字列表現。
 * parameter が数値型でも choices は文字列なので、必ず String() を通してから比較する。
 */
function valueToComparable(value: Immutable<ParameterValue>): string | undefined {
  if (value == undefined) {
    return undefined;
  }
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
      return String(value);
    default:
      // 配列・オブジェクト・Uint8Array・Date は choices との比較対象にしない
      return undefined;
  }
}

/**
 * int 配列の parameter を ID の集合にする。配列でなければ undefined。
 *
 * <p>ws-protocol は数値を number で返すが、実装によっては文字列で来ることがある。
 * 比較を取りこぼさないよう Number() で正規化してから集合にする。
 */
function toIdSet(value: Immutable<ParameterValue>): Set<number> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = new Set<number>();
  for (const entry of value) {
    const id = Number(entry);
    if (Number.isFinite(id)) {
      ids.add(Math.trunc(id));
    }
  }
  return ids;
}

/**
 * payload の JSON に ids を足した文字列を作る。
 *
 * <p>サーバーは差分ではなく<b>有効な ID の全体</b>を受け取る仕様なので、
 * 呼び出しのたびにトグル後の一覧をそのまま送る。
 * payload が壊れている場合は手を加えずに返し、呼び出し側にエラーを出させる。
 */
function payloadWithIds(payload: string, ids: number[]): string {
  let base: Record<string, unknown> = {};
  if (payload.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (parsed == undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
      return payload;
    }
    base = parsed as Record<string, unknown>;
  }
  return JSON.stringify({ ...base, ids });
}

function isTruthyParameter(value: Immutable<ParameterValue>): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1";
  }
  return false;
}

/** labels が使えるならそれを、駄目なら choices をそのまま表示に使う */
function displayLabel(control: UiControl, index: number): string {
  if (control.labels.length === control.choices.length) {
    const label = control.labels[index];
    if (label != undefined && label.length > 0) {
      return label;
    }
  }
  return control.choices[index] ?? "";
}

// ---------------------------------------------------------------------------
// スタイル（Studio のライト/ダーク双方で成立するよう、半透明のグレーで組む）
// ---------------------------------------------------------------------------



const rootStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 12,
  height: "100%",
  overflowY: "auto",
  padding: 8,
  boxSizing: "border-box",
};

const sectionStyle: React.CSSProperties = {
  border: `1px solid ${colors.subtleBorder}`,
  borderRadius: 4,
  marginBottom: 8,
  overflow: "hidden",
};

// 見出し・ラベル・値で大きさと濃さを変える。
// 全部が 12px の同じ濃さだと、面の切れ目が区切り線1本ぶんしかなく、
// 確認が上から順に読む直列作業になる
const sectionHeaderStyle: React.CSSProperties = {
  alignItems: "center",
  background: colors.surface,
  cursor: "pointer",
  display: "flex",
  fontSize: 13,
  fontWeight: 700,
  gap: 6,
  letterSpacing: "0.02em",
  padding: "7px 8px",
  textAlign: "left",
  width: "100%",
};

// select のドロップダウン一覧はページの色を継承しないため、
// 半透明 + inherit ではなく不透明色を明示する

/**
 * ステータス行を置く帯。
 *
 * <p>パネル最下部だと、セクションを開いているときにスクロールしないと見えない。
 * ルート要素がスクロール領域なので sticky で上端に貼り付ける。
 * <b>背景は不透明にすること。</b> 半透明だと下を流れる中身が透けて読めなくなる。
 */
function statusBarStyle(isDark: boolean): React.CSSProperties {
  return {
    position: "sticky",
    top: 0,
    zIndex: 1,
    background: isDark ? inputColors.dark.background : inputColors.light.background,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    marginBottom: 8,
    padding: "4px 6px",
  };
}

const statusRowStyle: React.CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  gap: 6,
  lineHeight: 1.5,
};


/**
 * ボタンの見た目。
 *
 * <p>「状態を選ぶボタン」と「動作を起こすボタン」を見た目で区別する。
 * 前者は parameter の現在値を映すので塗りつぶしの角丸長方形、
 * 後者は service を呼ぶだけで状態を持たないので輪郭だけのピル型にする。
 * 形が違えば色覚に依らず見分けられる。
 *
 * <p>:hover / :disabled はインラインスタイルでは書けないのでクラスにする。
 * インラインの background はクラスより強いため、ボタンの配色はここに集約すること。
 */
const PANEL_CSS = `
.rdcp-b {
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: ${colors.surfaceStrong};
  border: 1px solid ${colors.border};
  border-radius: 3px;
  padding: 5px 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rdcp-b:hover { background: rgba(127, 127, 127, 0.34); }
.rdcp-b.rdcp-sel {
  background: ${colors.accent};
  border-color: ${colors.accent};
  color: ${colors.accentText};
  font-weight: 700;
}
.rdcp-b.rdcp-sel:hover { background: ${colors.accent}; }
/* 動作を起こすボタン。現在値を持たないので選択状態にはならない */
.rdcp-b.rdcp-act {
  background: transparent;
  border-color: rgba(127, 127, 127, 0.55);
  border-radius: 999px;
  padding: 5px 12px;
}
.rdcp-b.rdcp-act:hover { background: rgba(127, 127, 127, 0.26); }
.rdcp-b:disabled { cursor: default; opacity: 0.45; }
.rdcp-b:disabled:hover { background: transparent; }
/* 押すと取り返しがつかない操作。
   色だけで分けると色覚によっては読み取れないので、輪郭を二重線にして形でも分ける */
.rdcp-b.rdcp-danger {
  background: transparent;
  border: 3px double ${colors.danger};
  border-radius: 999px;
  color: ${colors.danger};
  padding: 3px 12px;
}
.rdcp-b.rdcp-danger:hover { background: rgba(217, 83, 79, 0.16); }
/* 1回目のクリックで構えた状態。塗って、押せば実行されることを明示する */
.rdcp-b.rdcp-danger.rdcp-armed {
  background: ${colors.danger};
  color: #ffffff;
  font-weight: 700;
}
.rdcp-b.rdcp-danger.rdcp-armed:hover { background: ${colors.danger}; }
/* ON/OFF の2分割トグル。隣り合う辺の角と枠線を潰して1つの部品に見せる */
.rdcp-seg-l { border-radius: 3px 0 0 3px; }
.rdcp-seg-r { border-radius: 0 3px 3px 0; margin-left: -1px; }
.rdcp-head { background: none; border: none; }
.rdcp-head:hover { background: ${colors.surfaceStrong}; }
/* SSL のチーム色。選択中の塗りつぶしの上でも消えないよう、輪郭ではなく左端の内側の帯にする。
   色だけに頼らないよう、ボタンの文字（Yellow / Blue）はそのまま残すこと。
   ⚠️ 角丸長方形の選択ボタン専用。ピル型（.rdcp-act / .rdcp-danger）に乗せると
   帯が三日月に潰れ、confirm の赤い二重輪郭とも衝突する。2026-09-10 に一度乗せて戻した */
.rdcp-b.rdcp-t-yellow { box-shadow: inset 4px 0 0 #e5b91d; }
.rdcp-b.rdcp-t-blue { box-shadow: inset 4px 0 0 #5aa9e6; }
.rdcp-act.rdcp-t-yellow, .rdcp-act.rdcp-t-blue,
.rdcp-danger.rdcp-t-yellow, .rdcp-danger.rdcp-t-blue { box-shadow: none; }
/* コントロール全体のチーム色。ID の格子は同じ形が2つ縦に並ぶのに、
   どちらも既定の青で塗られていて、見分ける手掛かりが上の小さなラベルしかなかった。
   色を足すのではなく「選択中」の塗りを差し替えるので、画面の色の総量は増えない。
   黄色の上では白文字が読めないので、文字色も一緒に反転させること */
.rdcp-b.rdcp-sel.rdcp-tm-yellow,
.rdcp-b.rdcp-sel.rdcp-tm-yellow:hover {
  background: #e5b91d;
  border-color: #e5b91d;
  color: #1a1a1a;
}
.rdcp-b.rdcp-sel.rdcp-tm-blue,
.rdcp-b.rdcp-sel.rdcp-tm-blue:hover {
  background: ${colors.accent};
  border-color: ${colors.accent};
  color: ${colors.accentText};
}
/* ON/OFF は AI の起動停止のような重い値を持つのに、文字が短いぶん最も小さい的になる。
   幅の下限を置いて、幅を詰めたボタン列と同じくらいの大きさに揃える */
.rdcp-seg-l, .rdcp-seg-r { min-width: 54px; }

/* 行の骨格。
   ラベルと部品を縦に積むと、短いコントロールでも1件で2行ぶんの高さを取る。
   横に並べられる kind は rdcp-row-inline にして1行に収める。
   幅が足りなくなれば flex-wrap が縦積みに戻すので、幅を測る JS は要らない */
.rdcp-row {
  border-top: 1px solid ${colors.subtleBorder};
  padding: 6px 8px;
}
.rdcp-row-inline {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 3px 10px;
}
.rdcp-row-inline > .rdcp-lb { flex: 0 0 108px; margin-bottom: 0; }
.rdcp-row-inline > .rdcp-fd { flex: 1 1 150px; max-width: 340px; min-width: 0; }
/* parameter 名は補足なので、詰めた行でも独立した行に落とす */
.rdcp-row-inline > .rdcp-pn { flex: 1 0 100%; }
.rdcp-lb {
  display: block;
  font-size: 11px;
  font-weight: 500;
  margin-bottom: 4px;
  opacity: 0.7;
}
/* ボタン列は広い画面だと1つあたりが間延びする。押しやすさは 120px 前後で足りる */
.rdcp-grid { max-width: 520px; }
/* 表の列見出しと行見出し。押せないことが分かるよう、文字だけにして濃さを落とす */
.rdcp-th {
  font-size: 11px;
  opacity: 0.7;
  overflow: hidden;
  padding: 2px 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rdcp-th-col { text-align: center; }
/* 折りたたんでも状態が読めるようにする要約。セクション名より弱く出す */
.rdcp-sum {
  color: ${colors.muted};
  font-size: 11px;
  font-weight: 400;
  letter-spacing: normal;
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

/** 選択できるボタンのクラス名 */
function buttonClass(selected: boolean, extra = ""): string {
  return `rdcp-b${selected ? " rdcp-sel" : ""}${extra.length > 0 ? ` ${extra}` : ""}`;
}

/** tones の値をクラス名にする。知らない値には色を付けない（サーバーが値を増やしても壊れない） */
function toneClass(tone: string | undefined): string {
  return tone === "yellow" || tone === "blue" ? `rdcp-t-${tone}` : "";
}

/** team の値をクラス名にする。選択中の塗りだけが変わり、色の総量は増えない */
function teamClass(team: string): string {
  return team === "yellow" || team === "blue" ? `rdcp-tm-${team}` : "";
}

/** ボタン列の並べ方。columns が 0 なら折り返しありの1行に詰める */
function gridStyle(columns: number): React.CSSProperties {
  return columns > 0
    ? {
        display: "grid",
        gap: 4,
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      }
    : { display: "flex", flexWrap: "wrap", gap: 4 };
}

/** ラベルと部品を1行に並べられる kind か。選択肢が多いものは横に収まらない */
function isInlineKind(control: UiControl): boolean {
  switch (control.kind) {
    case "bool":
    case "enum":
    case "int_range":
    case "number":
      return true;
    case "enum_services":
      return control.choices.length <= 3;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// コントロール1件の描画
// ---------------------------------------------------------------------------

interface ControlProps {
  control: UiControl;
  isDark: boolean;
  currentValue: Immutable<ParameterValue>;
  showParameterName: boolean;
  onSetParameter: (name: string, value: ParameterValue) => void;
  /** 呼び出し中のサービス名。id_toggles のように service を呼ぶ kind で使う */
  pending: ReadonlySet<string>;
  onCallService: (service: string, payload: string) => void;
}

/**
 * confirm 付きボタンの「構えた」状態。一定時間で自動的に元へ戻る。
 *
 * <p>ダイアログを出さないのは、モーダルを閉じる操作がもう1つ増えるうえ、
 * 押した場所から目線が飛ぶため。時間は短すぎると読む前に戻り、
 * 長すぎると次の操作のつもりの1クリックで実行してしまう。
 *
 * <p>戻り値の識別子は「どのボタンを構えているか」。同時に構えられるのは1つだけ。
 */
function useArmed(): [
  string | undefined,
  React.Dispatch<React.SetStateAction<string | undefined>>,
] {
  const [armed, setArmed] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (armed == undefined) {
      return;
    }
    const timer = setTimeout(() => {
      setArmed(undefined);
    }, CONFIRM_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [armed]);

  return [armed, setArmed];
}

const ControlRow: React.FC<ControlProps> = ({
  control,
  isDark,
  currentValue,
  showParameterName,
  onSetParameter,
  pending,
  onCallService,
}) => {
  // 数値入力は編集途中の文字列をローカルに持つ（"1." のような中間状態を許すため）
  const [draft, setDraft] = useState<string | undefined>(undefined);
  // id_toggles の None 用。フックなので kind の分岐の中では呼べず、ここで持つ
  const [armed, setArmed] = useArmed();

  const current = valueToComparable(currentValue);

  const commitNumber = useCallback(
    (text: string) => {
      setDraft(undefined);
      const parsed = Number(text);
      if (text.trim().length === 0 || !Number.isFinite(parsed)) {
        return;
      }
      onSetParameter(control.parameter, parsed);
    },
    [control.parameter, onSetParameter],
  );

  const body = ((): React.ReactNode => {
    switch (control.kind) {
      case "enum": {
        // 現在値が choices にない場合も見えるように、先頭へ暫定の選択肢を足す
        const knownValue = current != undefined && control.choices.includes(current);
        return (
          <select
            style={inputStyle(isDark)}
            value={knownValue ? current : ""}
            onChange={(event) => {
              if (event.target.value.length > 0) {
                onSetParameter(control.parameter, event.target.value);
              }
            }}
          >
            {!knownValue && (
              <option style={optionStyle(isDark)} value="">
                {current == undefined ? "(未設定)" : `(${current})`}
              </option>
            )}
            {control.choices.map((choice, index) => (
              <option key={`${choice}-${index}`} style={optionStyle(isDark)} value={choice}>
                {displayLabel(control, index)}
              </option>
            ))}
          </select>
        );
      }

      case "enum_buttons": {
        const layout = gridStyle(control.columns);
        return (
          <div className="rdcp-grid" style={layout}>
            {control.choices.map((choice, index) => {
              const selected = current != undefined && current === choice;
              return (
                <button
                  key={`${choice}-${index}`}
                  title={choice}
                  className={buttonClass(selected, toneClass(control.tones[index]))}
                  onClick={() => {
                    onSetParameter(control.parameter, choice);
                  }}
                >
                  {displayLabel(control, index)}
                </button>
              );
            })}
          </div>
        );
      }

      case "enum_matrix": {
        // 同じ2択を縦に6組並べると、見出し行とボタン行で12行を使い、
        // しかも並ぶ文字は Yellow と Blue の2種類しかないので、
        // どの行を見ているのかがラベルを読み直すまで分からない。
        // 行見出しを左端の列に出す表にすれば、列がチーム・行がコマンドと形で読める。
        //
        // 列数は headers ではなく columns を正とする。両者がずれていても
        // 描画は成立してしまうので、足りないセルは空にして気づけるようにする
        const cols = control.columns > 0 ? control.columns : control.headers.length;
        if (cols <= 0 || control.rows.length === 0) {
          return (
            <div style={{ color: colors.error }}>
              enum_matrix に rows か columns がありません
            </div>
          );
        }
        return (
          <div
            className="rdcp-grid"
            style={{
              display: "grid",
              gap: 4,
              gridTemplateColumns: `minmax(72px, auto) repeat(${cols}, minmax(0, 1fr))`,
            }}
          >
            <span />
            {Array.from({ length: cols }, (_, col) => (
              <span key={`h-${col}`} className="rdcp-th rdcp-th-col">
                {control.headers[col] ?? ""}
              </span>
            ))}
            {control.rows.map((rowLabel, row) => (
              <React.Fragment key={`r-${row}`}>
                <span className="rdcp-th" title={rowLabel}>
                  {rowLabel}
                </span>
                {Array.from({ length: cols }, (_, col) => {
                  const index = row * cols + col;
                  const choice = control.choices[index];
                  if (choice == undefined) {
                    return <span key={`c-${col}`} />;
                  }
                  const selected = current != undefined && current === choice;
                  return (
                    <button
                      key={`c-${col}`}
                      title={choice}
                      className={buttonClass(selected, toneClass(control.tones[index]))}
                      onClick={() => {
                        onSetParameter(control.parameter, choice);
                      }}
                    >
                      {control.headers[col] ?? displayLabel(control, index)}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        );
      }

      case "bool": {
        // 1つのボタンに "OFF" とだけ出すと「今 OFF」なのか「押すと OFF」なのか判別できない。
        // ON/OFF を並べて現在値の側をハイライトする。値が読めないときはどちらも点かない
        const on = currentValue == undefined ? undefined : isTruthyParameter(currentValue);
        return (
          <div style={{ display: "inline-flex" }}>
            <button
              className={buttonClass(on === true, "rdcp-seg-l")}
              onClick={() => {
                onSetParameter(control.parameter, true);
              }}
            >
              ON
            </button>
            <button
              className={buttonClass(on === false, "rdcp-seg-r")}
              onClick={() => {
                onSetParameter(control.parameter, false);
              }}
            >
              OFF
            </button>
          </div>
        );
      }

      case "number": {
        const hasRange = control.min !== 0 || control.max !== 0;
        return (
          <input
            type="number"
            style={inputStyle(isDark)}
            min={hasRange ? control.min : undefined}
            max={hasRange ? control.max : undefined}
            value={draft ?? (current ?? "")}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={(event) => {
              commitNumber(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitNumber(event.currentTarget.value);
                event.currentTarget.blur();
              }
            }}
          />
        );
      }

      case "int_range": {
        const from = Math.ceil(control.min);
        const to = Math.floor(control.max);
        const count = to - from + 1;
        if (count <= 0 || count > MAX_RANGE_OPTIONS) {
          // 範囲が不正、または広すぎる場合は数値入力で代替する
          return (
            <input
              type="number"
              style={inputStyle(isDark)}
              min={control.min}
              max={control.max}
              step={1}
              value={draft ?? (current ?? "")}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onBlur={(event) => {
                commitNumber(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitNumber(event.currentTarget.value);
                  event.currentTarget.blur();
                }
              }}
            />
          );
        }
        const options = Array.from({ length: count }, (_, index) => from + index);
        const knownValue =
          current != undefined && options.some((option) => String(option) === current);
        return (
          <select
            style={inputStyle(isDark)}
            value={knownValue ? current : ""}
            onChange={(event) => {
              if (event.target.value.length > 0) {
                onSetParameter(control.parameter, Number(event.target.value));
              }
            }}
          >
            {!knownValue && (
              <option style={optionStyle(isDark)} value="">
                {current == undefined ? "(未設定)" : `(${current})`}
              </option>
            )}
            {options.map((option) => (
              <option key={option} style={optionStyle(isDark)} value={option}>
                {option}
              </option>
            ))}
          </select>
        );
      }

      case "enum_services": {
        // 見た目は enum_buttons と同じ。違うのは書き込みが parameter ではなく
        // service で、選択肢ごとに呼ぶ先が違うところだけ
        const table = readChoiceServices(control.payload);
        const layout = gridStyle(control.columns);
        return (
          <div className="rdcp-grid" style={layout}>
            {control.choices.map((choice, index) => {
              const target = table.get(choice);
              const selected = current != undefined && current === choice;
              return (
                <button
                  key={`${choice}-${index}`}
                  // 対応する service が無い選択肢は押しても何も起きない。
                  // 押せてしまうと「押したのに変わらない」と読めてしまう
                  disabled={target == undefined || pending.has(target.service)}
                  title={target == undefined ? choice : `${choice} → ${target.service}`}
                  className={buttonClass(selected, toneClass(control.tones[index]))}
                  onClick={() => {
                    if (target == undefined) {
                      return;
                    }
                    onCallService(target.service, JSON.stringify(target.request ?? {}));
                  }}
                >
                  {displayLabel(control, index)}
                </button>
              );
            })}
          </div>
        );
      }

      case "id_toggles": {
        // 現在値は parameter（int 配列）から読み、書き込みは service で行う。
        // parameter に直接書くとサーバー側の SimulatorSync を通らず、
        // 設定だけが変わってシミュレータのロボットが場に残る
        const from = Math.ceil(control.min);
        const to = Math.floor(control.max);
        const count = to - from + 1;
        if (count <= 0 || count > MAX_RANGE_OPTIONS) {
          return (
            <div style={{ color: colors.error }}>
              id_toggles の範囲が不正です: {control.min}..{control.max}
            </div>
          );
        }
        const ids = Array.from({ length: count }, (_, index) => from + index);
        const active = toIdSet(currentValue);
        const busy = pending.has(control.service);
        const send = (next: number[]) => {
          onCallService(control.service, payloadWithIds(control.payload, next));
        };
        const layout = gridStyle(control.columns);
        return (
          <div>
            <div className="rdcp-grid" style={layout}>
              {ids.map((id) => {
                const selected = active?.has(id) ?? false;
                return (
                  <button
                    key={id}
                    // 現在値が読めないうちは差分を作れないので押させない
                    disabled={busy || active == undefined}
                    className={buttonClass(selected, teamClass(control.team))}
                    onClick={() => {
                      send(
                        ids.filter((other) =>
                          other === id ? !selected : (active?.has(other) ?? false),
                        ),
                      );
                    }}
                  >
                    {id}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <button
                className="rdcp-b rdcp-act"
                disabled={busy}
                onClick={() => {
                  send(ids);
                }}
              >
                All
              </button>
              {/* この格子で取り返しがつかないのは None だけ。
                  試合前の準備を1クリックで消せてしまうので、confirm が立っていたら構えさせる。
                  全台有効化は個別に選び直せば戻るので All には掛けない */}
              <button
                className={`rdcp-b ${
                  control.confirm
                    ? `rdcp-danger${armed === NONE_KEY ? " rdcp-armed" : ""}`
                    : "rdcp-act"
                }`}
                disabled={busy}
                onClick={() => {
                  if (!control.confirm) {
                    send([]);
                    return;
                  }
                  if (armed !== NONE_KEY) {
                    setArmed(NONE_KEY);
                    return;
                  }
                  setArmed(undefined);
                  send([]);
                }}
              >
                {control.confirm && armed === NONE_KEY ? "None?" : "None"}
              </button>
            </div>
          </div>
        );
      }

      default: {
        return (
          <div style={{ color: colors.error }}>
            未対応の kind: &quot;{control.kind}&quot;
          </div>
        );
      }
    }
  })();

  const showHeading = control.label.length > 0;
  const inline = isInlineKind(control);

  return (
    <div className={`rdcp-row${inline ? " rdcp-row-inline" : ""}`}>
      {showHeading && <span className="rdcp-lb">{control.label}</span>}
      <div className="rdcp-fd">{body}</div>
      {showParameterName && control.parameter.length > 0 && (
        <div className="rdcp-pn" style={{ color: colors.muted, fontSize: 10, marginTop: 3 }}>
          {control.parameter}
        </div>
      )}
    </div>
  );
};

/**
 * 連続する kind="button" をまとめて1行に詰める。
 *
 * <p>service を呼ぶボタンは parameter を持たないため現在値でハイライトできない。
 * 1件ずつ行にすると縦に伸びるだけなので、折り返しありの1行に並べる。
 */
const ServiceButtonRow: React.FC<{
  controls: UiControl[];
  pending: ReadonlySet<string>;
  onCallService: (service: string, payload: string) => void;
}> = ({ controls, pending, onCallService }) => {
  const [armed, setArmed] = useArmed();

  return (
    <div className="rdcp-row" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {controls.map((control, index) => {
        const key = `${control.service}-${index}`;
        const busy = pending.has(control.service);
        const isArmed = armed === key;
        const label = control.label.length > 0 ? control.label : control.service;
        // ここではチーム色を塗らない。ラベルに Blue / Yellow と書いてあるので
        // 色が足す情報がなく、ピル型は角丸 999px なので帯が三日月に潰れる。
        // confirm 付きは赤い二重輪郭を持つので、色が正面衝突もする
        const style = control.confirm
          ? `rdcp-b rdcp-danger${isArmed ? " rdcp-armed" : ""}`
          : "rdcp-b rdcp-act";
        return (
          <button
            key={key}
            disabled={busy}
            title={`${control.service} ${control.payload}`.trim()}
            className={style}
            onClick={() => {
              if (!control.confirm) {
                onCallService(control.service, control.payload);
                return;
              }
              if (!isArmed) {
                setArmed(key);
                return;
              }
              setArmed(undefined);
              onCallService(control.service, control.payload);
            }}
          >
            {isArmed ? `${label}?` : label}
          </button>
        );
      })}
    </div>
  );
};

/** group 内のコントロールを描画単位に分ける。連続する button は1行にまとめる */
type Row =
  | { type: "control"; control: UiControl }
  | { type: "buttons"; controls: UiControl[] };

function packRows(controls: UiControl[]): Row[] {
  const rows: Row[] = [];
  for (const control of controls) {
    if (control.kind !== "button") {
      rows.push({ type: "control", control });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.type === "buttons") {
      last.controls.push(control);
    } else {
      rows.push({ type: "buttons", controls: [control] });
    }
  }
  return rows;
}

/**
 * 折りたたんだセクション見出しに出す現在値。読めないときは undefined。
 *
 * <p>試合前の最終確認は、値が全部同じ見た目で並んでいると上から順に読む直列作業になる。
 * セクション単位で状態が読めれば、確認は畳んだままの走査で済む。
 *
 * <p>bool と id_toggles はラベルが無いと何の値か分からないので添える。
 * 選択肢を持つものは値そのものが名前になっているので、値だけ出す。
 */
function summaryText(control: UiControl, value: Immutable<ParameterValue>): string | undefined {
  if (value == undefined) {
    return undefined;
  }
  switch (control.kind) {
    case "bool":
      return `${control.label} ${isTruthyParameter(value) ? "ON" : "OFF"}`;
    case "id_toggles": {
      const active = toIdSet(value);
      return active == undefined ? undefined : `${control.label} ${active.size}`;
    }
    default: {
      const current = valueToComparable(value);
      if (current == undefined) {
        return undefined;
      }
      const index = control.choices.indexOf(current);
      return index >= 0 ? displayLabel(control, index) : current;
    }
  }
}

/** サービスの応答をステータス行に出せる長さに畳む */
function summarizeResponse(response: unknown): string {
  if (response == undefined) {
    return "";
  }
  const text = typeof response === "string" ? response : JSON.stringify(response);
  if (text == undefined) {
    return "";
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * {@code enum_services} の payload（選択肢名 → 呼ぶ service）を読む。
 *
 * <p>形は {@code {"<choice>": {"service": "/foo", "request": {...}}, ...}}。
 * 選択肢ごとに呼ぶ service が違うので対応表が要る。添字合わせにすると
 * 片方だけ並べ替えたときに黙ってずれるため、選択肢名をキーにしてある。
 */
function readChoiceServices(payload: string): Map<string, { service: string; request: unknown }> {
  const table = new Map<string, { service: string; request: unknown }>();
  if (payload.trim().length === 0) {
    return table;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return table;
  }
  if (parsed == undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    return table;
  }
  for (const [choice, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (raw == undefined || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const service = entry["service"];
    if (typeof service !== "string" || service.length === 0) {
      continue;
    }
    table.set(choice, { service, request: entry["request"] ?? {} });
  }
  return table;
}

/** ステータス行に添える mm:ss */
function clockLabel(at: Date): string {
  const mm = String(at.getMinutes()).padStart(2, "0");
  const ss = String(at.getSeconds()).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** 応答が {"success": false} を含むか。HTTP と違い呼び出し自体は成功して返ってくる */
function isFailureResponse(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response != undefined &&
    (response as Record<string, unknown>)["success"] === false
  );
}

// ---------------------------------------------------------------------------
// パネル本体
// ---------------------------------------------------------------------------

const UiControlPanel: React.FC<{ context: PanelExtensionContext }> = ({ context }) => {
  const [state, setState] = useState<PanelState>(defaultState);
  const [controls, setControls] = useState<UiControl[] | undefined>();
  const [parameters, setParameters] = useState<
    undefined | Immutable<Map<string, ParameterValue>>
  >();
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  // 直近の数件を新しい順に持つ。1件だけだと、連打したときに
  // 成功がエラーを上書きして失敗に気づけない
  const [statuses, setStatuses] = useState<Status[]>([]);
  const nextStatusId = useRef(1);
  // 呼び出し中のサービス名。連打で同じ要求を積まないようにボタンを無効化する
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const isDark = useIsDarkTheme(context.panelElement);

  // --- Foxglove との接続 ---------------------------------------------------

  useLayoutEffect(() => {
    const savedState = context.initialState as Partial<PanelState> | undefined;
    if (savedState) {
      setState((prev) => ({
        ...prev,
        ...savedState,
        collapsed: savedState.collapsed ?? prev.collapsed,
      }));
    }
  }, [context]);

  useLayoutEffect(() => {
    context.saveState(state);
  }, [context, state]);

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);

      if (renderState.topics) {
        setTopics(renderState.topics);
      }
      setParameters(renderState.parameters);

      const frame = renderState.currentFrame;
      if (frame && frame.length > 0) {
        // 同一フレームに複数来たら最後のものが最新
        for (let i = frame.length - 1; i >= 0; i--) {
          const event = frame[i] as Immutable<MessageEvent> | undefined;
          if (!event) {
            continue;
          }
          const layout = normalizeLayout(event.message);
          if (layout) {
            setControls(layout);
            break;
          }
        }
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
    context.watch("parameters");
  }, [context]);

  useEffect(() => {
    const subscription: Subscription = { topic: state.topic };
    context.subscribe([subscription]);
  }, [context, state.topic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // --- 設定ツリー -----------------------------------------------------------

  useEffect(() => {
    const panelSettings: SettingsTree = {
      nodes: {
        general: {
          label: "General",
          fields: {
            topic: { label: "トピック名", input: "string", value: state.topic },
            showParameterNames: {
              label: "パラメータ名を表示",
              input: "boolean",
              value: state.showParameterNames,
            },
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
        } else if (path === "general.showParameterNames") {
          setState((prev) => ({
            ...prev,
            showParameterNames: action.payload.value === true,
          }));
        }
      },
    };
    context.updatePanelSettingsEditor(panelSettings);
  }, [context, state.showParameterNames, state.topic]);

  // --- 操作ハンドラ ---------------------------------------------------------

  /** 行を1件足して id を返す。新しいものが上、多すぎる古いものは落とす */
  const pushStatus = useCallback((kind: StatusKind, text: string): number => {
    const id = nextStatusId.current++;
    const now = Date.now();
    // エラーは消さない。見落とすと、操作したつもりで何も起きていない状態が続く
    const expiresAt = kind === "error" ? undefined : now + STATUS_FADE_MS;
    setStatuses((prev) =>
      [{ id, kind, text, time: clockLabel(new Date(now)), expiresAt }, ...prev].slice(
        0,
        MAX_STATUS_ROWS,
      ),
    );
    return id;
  }, []);

  /** 呼び出し中の行を、応答が返った時点で結果に置き換える */
  const settleStatus = useCallback((id: number, kind: StatusKind, text: string) => {
    setStatuses((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              kind,
              text,
              time: clockLabel(new Date()),
              expiresAt: kind === "error" ? undefined : Date.now() + STATUS_FADE_MS,
            }
          : entry,
      ),
    );
  }, []);

  const dismissStatus = useCallback((id: number) => {
    setStatuses((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  // 期限が来た行を落とす。**取り除くものが無ければ元の配列を返すこと。**
  // 毎回新しい配列を返すと、この useEffect が自分の setStatuses で再入して回り続ける
  useEffect(() => {
    let soonest: number | undefined;
    for (const entry of statuses) {
      if (entry.expiresAt == undefined) continue;
      if (soonest == undefined || entry.expiresAt < soonest) soonest = entry.expiresAt;
    }
    if (soonest == undefined) {
      return;
    }
    const timer = setTimeout(
      () => {
        setStatuses((prev) => {
          const now = Date.now();
          const kept = prev.filter((entry) => entry.expiresAt == undefined || entry.expiresAt > now);
          return kept.length === prev.length ? prev : kept;
        });
      },
      Math.max(0, soonest - Date.now()) + 20,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [statuses]);

  const handleSetParameter = useCallback(
    (name: string, value: ParameterValue) => {
      if (name.length === 0) {
        pushStatus("error", "parameter 名が空のコントロールです");
        return;
      }
      try {
        context.setParameter(name, value);
        // 成功は出さない。現在値はコントロール自身がハイライトで映すので、
        // ここに出すとサービスの結果が押し流されて読めなくなる
      } catch (error) {
        pushStatus("error", `${name} の設定に失敗: ${String(error)}`);
      }
    },
    [context, pushStatus],
  );

  const handleCallService = useCallback(
    (service: string, payload: string) => {
      const callService = context.callService;
      if (!callService) {
        pushStatus("error", "この接続はサービス呼び出しに対応していません");
        return;
      }
      if (service.length === 0) {
        pushStatus("error", "service 名が空のコントロールです");
        return;
      }
      let request: unknown = {};
      if (payload.trim().length > 0) {
        try {
          request = JSON.parse(payload);
        } catch (error) {
          pushStatus("error", `payload の JSON が不正: ${String(error)}`);
          return;
        }
      }
      const id = pushStatus("pending", `${service} を呼び出し中…`);
      setPending((prev) => new Set(prev).add(service));
      const finish = () => {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(service);
          return next;
        });
      };
      callService(service, request).then(
        (response: unknown) => {
          finish();
          // 呼び出し自体は成功しても、応答が success:false を返すことがある
          const summary = summarizeResponse(response);
          settleStatus(
            id,
            isFailureResponse(response) ? "error" : "info",
            `${service}: ${summary.length > 0 ? summary : "OK"}`,
          );
        },
        (error: unknown) => {
          finish();
          settleStatus(id, "error", `${service} の呼び出しに失敗: ${String(error)}`);
        },
      );
    },
    [context, pushStatus, settleStatus],
  );

  const toggleGroup = useCallback((group: string) => {
    setState((prev) => ({
      ...prev,
      collapsed: { ...prev.collapsed, [group]: !(prev.collapsed[group] ?? false) },
    }));
  }, []);

  // --- group ごとにまとめる（登場順を保つ） ---------------------------------

  const groups = useMemo(() => {
    const ordered: { name: string; controls: UiControl[] }[] = [];
    const index = new Map<string, UiControl[]>();
    for (const control of controls ?? []) {
      const name = control.group.length > 0 ? control.group : UNGROUPED_LABEL;
      let bucket = index.get(name);
      if (!bucket) {
        bucket = [];
        index.set(name, bucket);
        ordered.push({ name, controls: bucket });
      }
      // 同じ parameter を指すコントロールが複数来るのは仕様どおりなので重複除去しない
      bucket.push(control);
    }
    return ordered;
  }, [controls]);

  const topicExists = useMemo(
    () => topics?.some((topic) => topic.name === state.topic) ?? false,
    [state.topic, topics],
  );

  // --- 描画 -----------------------------------------------------------------

  return (
    <div style={rootStyle}>
      <style>{PANEL_CSS}</style>

      {statuses.length > 0 && (
        <div style={statusBarStyle(isDark)}>
          {statuses.map((entry) => (
            <div key={entry.id} style={statusRowStyle}>
              <span style={{ color: colors.muted, flex: "none" }}>{entry.time}</span>
              <span style={{ color: colors.muted, flex: "none" }}>
                {entry.kind === "pending" ? "…" : entry.kind === "error" ? "×" : "✓"}
              </span>
              <span
                style={{
                  color: entry.kind === "error" ? colors.error : "inherit",
                  opacity: entry.kind === "pending" ? 0.7 : 1,
                  wordBreak: "break-all",
                }}
              >
                {entry.text}
              </span>
              {entry.kind === "error" && (
                <button
                  className="rdcp-b rdcp-head"
                  style={{ color: colors.muted, marginLeft: "auto", padding: "0 4px" }}
                  title="この行を閉じる"
                  onClick={() => {
                    dismissStatus(entry.id);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {controls == undefined && (
        <div style={{ opacity: 0.7, padding: 8 }}>
          {topicExists
            ? `${state.topic} のメッセージを待機中…`
            : `${state.topic} が見つかりません。データソースに接続し、設定でトピック名を確認してください。`}
        </div>
      )}

      {controls != undefined && controls.length === 0 && (
        <div style={{ opacity: 0.7, padding: 8 }}>{state.topic} にコントロールがありません。</div>
      )}

      {groups.map((group) => {
        const collapsed = state.collapsed[group.name] ?? false;
        // 件数はどの場面でも使わない情報なので、代わりにそのセクションの現在値を出す
        const summary = group.controls
          .filter((control) => control.summary && control.parameter.length > 0)
          .map((control) => summaryText(control, parameters?.get(control.parameter)))
          .filter((text): text is string => text != undefined)
          .join(" · ");
        return (
          <div key={group.name} style={sectionStyle}>
            <button
              className="rdcp-b rdcp-head"
              style={sectionHeaderStyle}
              onClick={() => {
                toggleGroup(group.name);
              }}
            >
              <span style={{ width: 10 }}>{collapsed ? "▸" : "▾"}</span>
              <span style={{ flex: "none" }}>{group.name}</span>
              {summary.length > 0 && (
                <span className="rdcp-sum" title={summary}>
                  {summary}
                </span>
              )}
            </button>
            {!collapsed &&
              packRows(group.controls).map((row, index) =>
                row.type === "buttons" ? (
                  <ServiceButtonRow
                    key={`buttons-${index}`}
                    controls={row.controls}
                    pending={pending}
                    onCallService={handleCallService}
                  />
                ) : (
                  <ControlRow
                    key={`${row.control.kind}-${row.control.parameter}-${index}`}
                    control={row.control}
                    isDark={isDark}
                    currentValue={
                      row.control.parameter.length > 0
                        ? parameters?.get(row.control.parameter)
                        : undefined
                    }
                    showParameterName={state.showParameterNames}
                    onSetParameter={handleSetParameter}
                    pending={pending}
                    onCallService={handleCallService}
                  />
                ),
              )}
          </div>
        );
      })}

    </div>
  );
};

export function initUiControlPanel(context: PanelExtensionContext): () => void {
  ReactDOM.render(
    <StrictMode>
      <UiControlPanel context={context} />
    </StrictMode>,
    context.panelElement,
  );
  return () => {
    ReactDOM.unmountComponentAtNode(context.panelElement);
  };
}
