/**
 * 設定ファイルの操作。保存・別名保存・読み込み・再起動。
 *
 * <p>先頭に開いているファイル名と未保存の印を出し、その右に操作を並べる。
 * 「どのファイルに対する操作か」が同じ行で読めるようにするため。
 */

import * as React from "react";
import { useEffect, useState } from "react";

import { CallService, StatusKind, isFailure } from "./config_hooks";
import { Icon } from "./icons";
import { colors, inputStyle, optionStyle } from "./panel_theme";

const SVC_SAVE = "/config/save";
const SVC_SAVE_AS = "/config/save_as";
const SVC_LOAD = "/config/load";
const SVC_RESTART = "/server/restart";

/** 確認付きボタンを構えたままにする時間[ms]。操作パネルと揃える */
const CONFIRM_TIMEOUT_MS = 4000;

export const FILE_OPS_CSS = `
.rdccfg-btn {
  align-items: center;
  display: inline-flex;
  gap: 4px;
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
.rdccfg-field { align-items: center; display: flex; position: relative; }
.rdccfg-field > svg { left: 6px; opacity: 0.7; pointer-events: none; position: absolute; }
`;

/** 入力欄の左端に置くアイコンのぶんの字下げ[px] */
export const FIELD_ICON_INSET = 24;

/**
 * 入力欄・ドロップダウンの左端にアイコンを重ねる。
 *
 * <p>select の中身（option）にはアイコンを入れられないので、外から重ねて
 * 入力欄の側に左の余白を足す。子の style に {@link FIELD_ICON_INSET} を足すこと。
 */
export const IconField: React.FC<{ icon: string; style?: React.CSSProperties }> = ({
  icon,
  style,
  children,
}) => (
  <span className="rdccfg-field" style={style}>
    <Icon name={icon} />
    {children}
  </span>
);

function fieldStyle(isDark: boolean): React.CSSProperties {
  return { ...inputStyle(isDark), flex: "1 1 120px", padding: "2px 6px", width: "auto" };
}

/** IconField の中に入れるドロップダウン。幅は IconField の側で決める */
function iconFieldStyle(isDark: boolean): React.CSSProperties {
  return { ...inputStyle(isDark), padding: `2px 6px 2px ${FIELD_ICON_INSET}px` };
}

export const FileOps: React.FC<{
  /** 開いている設定ファイル名。まだ届いていなければ undefined */
  configName: string | undefined;
  /** 未保存の変更があるか */
  dirty: boolean;
  files: string[];
  writable: boolean;
  isDark: boolean;
  callService: CallService;
  pushStatus: (kind: StatusKind, text: string) => void;
  onFilesChanged: () => void;
}> = ({ configName, dirty, files, writable, isDark, callService, pushStatus, onFilesChanged }) => {
  const [saveAsName, setSaveAsName] = useState("");
  // "restart" か "load:<ファイル名>"。構えている確認を1つだけ持つ
  const [confirming, setConfirming] = useState<string | undefined>();

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

  const load = (name: string) => {
    const force = confirming === `load:${name}`;
    setConfirming(undefined);
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
  };

  return (
    <div
      style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}
    >
      <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
        {configName ?? "?"}
        {dirty && <span title="未保存の変更があります"> *</span>}
      </span>
      <button
        className="rdccfg-btn"
        disabled={!writable}
        onClick={() => {
          callService(SVC_SAVE, {}, onFilesChanged);
        }}
      >
        <Icon name="save" />
        保存
      </button>
      <input
        type="text"
        placeholder="別名で保存するファイル名"
        style={fieldStyle(isDark)}
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
            onFilesChanged();
          });
        }}
      >
        <Icon name="save_as" />
        別名で保存
      </button>
      <IconField icon="file_open" style={{ flex: "1 1 120px" }}>
        <select
          style={iconFieldStyle(isDark)}
          disabled={!writable}
          value=""
          onChange={(e) => {
            if (e.target.value.length > 0) {
              load(e.target.value);
            }
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
      </IconField>
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
        <Icon name="restart_alt" />
        {confirming === "restart" ? "本当に再起動する？（接続が切れます）" : "再起動して反映"}
      </button>
    </div>
  );
};
