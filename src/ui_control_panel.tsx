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

/**
 * Studio のテーマ（ライト/ダーク）を実測する。
 *
 * select のドロップダウン一覧はブラウザ側が描画するため、色を明示しないと
 * 「既定の白背景 + 継承した白文字」で読めなくなる。パネルの実際の背景色から
 * 明暗を判定し、不透明な色を明示的に当てるためのユーティリティ。
 */
function parseRgb(value: string): [number, number, number, number] | undefined {
  const matched = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!matched) {
    return undefined;
  }
  const parts = matched[1]!.split(",").map((part) => Number(part.trim()));
  const [r, g, b] = parts;
  if (r == undefined || g == undefined || b == undefined) {
    return undefined;
  }
  return [r, g, b, parts.length > 3 ? (parts[3] ?? 1) : 1];
}

function isDarkRgb(r: number, g: number, b: number): boolean {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** 祖先をたどって最初に見つかった不透明な背景色から明暗を判定する */
function detectDarkTheme(element: HTMLElement | undefined): boolean | undefined {
  const view = element?.ownerDocument.defaultView;
  if (!element || !view) {
    return undefined;
  }
  let node: HTMLElement | null = element;
  while (node) {
    const background = parseRgb(view.getComputedStyle(node).backgroundColor);
    if (background && background[3] > 0.2) {
      return isDarkRgb(background[0], background[1], background[2]);
    }
    node = node.parentElement;
  }
  // 背景がすべて透明なら文字色から推測する（明るい文字 = ダークテーマ）
  const foreground = parseRgb(view.getComputedStyle(element).color);
  if (foreground) {
    return !isDarkRgb(foreground[0], foreground[1], foreground[2]);
  }
  return undefined;
}

function useIsDarkTheme(element: HTMLElement | undefined): boolean {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    if (!element) {
      return;
    }
    const update = () => {
      const detected = detectDarkTheme(element);
      if (detected != undefined) {
        setIsDark((prev) => (prev === detected ? prev : detected));
      }
    };
    update();

    const doc = element.ownerDocument;
    const observer = new MutationObserver(update);
    observer.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    if (doc.body) {
      observer.observe(doc.body, { attributes: true, attributeFilter: ["class", "style"] });
    }
    // Studio 側のテーマ切り替えを取りこぼしても追従できるようにする保険
    const timer = doc.defaultView?.setInterval(update, 2000);

    return () => {
      observer.disconnect();
      if (timer != undefined) {
        doc.defaultView?.clearInterval(timer);
      }
    };
  }, [element]);

  return isDark;
}

const colors = {
  border: "rgba(127, 127, 127, 0.4)",
  subtleBorder: "rgba(127, 127, 127, 0.25)",
  surface: "rgba(127, 127, 127, 0.14)",
  surfaceStrong: "rgba(127, 127, 127, 0.22)",
  accent: "#3b6fe0",
  accentText: "#ffffff",
  error: "#e05252",
  muted: "rgba(127, 127, 127, 1)",
  danger: "#d9534f",
};

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

const sectionHeaderStyle: React.CSSProperties = {
  alignItems: "center",
  background: colors.surface,
  cursor: "pointer",
  display: "flex",
  fontWeight: 600,
  gap: 6,
  padding: "6px 8px",
  textAlign: "left",
  width: "100%",
};

const controlRowStyle: React.CSSProperties = {
  borderTop: `1px solid ${colors.subtleBorder}`,
  padding: "6px 8px",
};

const controlLabelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 4,
  opacity: 0.85,
};

// select のドロップダウン一覧はページの色を継承しないため、
// 半透明 + inherit ではなく不透明色を明示する
const inputColors = {
  dark: { background: "#2f2f2f", color: "#e8e8e8" },
  light: { background: "#ffffff", color: "#1a1a1a" },
};

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

function inputStyle(isDark: boolean): React.CSSProperties {
  const scheme = isDark ? inputColors.dark : inputColors.light;
  return {
    background: scheme.background,
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    color: scheme.color,
    // ドロップダウン一覧やスピナーなどブラウザ描画部分の配色を揃える
    colorScheme: isDark ? "dark" : "light",
    font: "inherit",
    padding: "4px 6px",
    width: "100%",
    boxSizing: "border-box",
  };
}

function optionStyle(isDark: boolean): React.CSSProperties {
  const scheme = isDark ? inputColors.dark : inputColors.light;
  return { background: scheme.background, color: scheme.color };
}

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
`;

/** 選択できるボタンのクラス名 */
function buttonClass(selected: boolean, extra = ""): string {
  return `rdcp-b${selected ? " rdcp-sel" : ""}${extra.length > 0 ? ` ${extra}` : ""}`;
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
        const layout: React.CSSProperties =
          control.columns > 0
            ? {
                display: "grid",
                gap: 4,
                gridTemplateColumns: `repeat(${control.columns}, minmax(0, 1fr))`,
              }
            : { display: "flex", flexWrap: "wrap", gap: 4 };
        return (
          <div style={layout}>
            {control.choices.map((choice, index) => {
              const selected = current != undefined && current === choice;
              return (
                <button
                  key={`${choice}-${index}`}
                  title={choice}
                  className={buttonClass(selected)}
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
        const layout: React.CSSProperties =
          control.columns > 0
            ? {
                display: "grid",
                gap: 4,
                gridTemplateColumns: `repeat(${control.columns}, minmax(0, 1fr))`,
              }
            : { display: "flex", flexWrap: "wrap", gap: 4 };
        return (
          <div>
            <div style={layout}>
              {ids.map((id) => {
                const selected = active?.has(id) ?? false;
                return (
                  <button
                    key={id}
                    // 現在値が読めないうちは差分を作れないので押させない
                    disabled={busy || active == undefined}
                    className={buttonClass(selected)}
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
              <button
                className="rdcp-b rdcp-act"
                disabled={busy}
                onClick={() => {
                  send([]);
                }}
              >
                None
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

  return (
    <div style={controlRowStyle}>
      {showHeading && <span style={controlLabelStyle}>{control.label}</span>}
      {body}
      {showParameterName && control.parameter.length > 0 && (
        <div style={{ color: colors.muted, fontSize: 10, marginTop: 3 }}>{control.parameter}</div>
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
  // confirm 付きボタンのうち、いま構えているもの。一定時間で自動的に戻す。
  // ダイアログを出さないのは、モーダルを閉じる操作がもう1つ増えるうえ、
  // 押した場所から目線が飛ぶため
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

  return (
    <div style={{ ...controlRowStyle, display: "flex", flexWrap: "wrap", gap: 4 }}>
      {controls.map((control, index) => {
        const key = `${control.service}-${index}`;
        const busy = pending.has(control.service);
        const isArmed = armed === key;
        const label = control.label.length > 0 ? control.label : control.service;
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
              <span>{group.name}</span>
              <span style={{ color: colors.muted, fontWeight: 400, marginLeft: "auto" }}>
                {group.controls.length}
              </span>
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
