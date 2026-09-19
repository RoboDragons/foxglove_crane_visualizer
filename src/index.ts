/**
 * 拡張が公開するパネルの登録。
 *
 * <p>⚠️ <b>パネル名は Studio の保存済みレイアウトが参照する識別子。</b>
 * 変えると既存のレイアウトでそのパネルが「不明なパネル」になり、置き直しが要る。
 *
 * <p>2026-09-19 に crane- の接頭辞を外した。本家 crane_visualizer から借りて
 * 始めたが、中身はもう自分たちの実装なので名前に残す理由が無い。
 *
 * <p><b>ただし {@code crane-visualizer-panel} だけは元の名前のまま。</b>
 * 既存のレイアウトが参照しており、変えると場が表示できなくなるため。
 * 接頭辞の統一より互換性を採る。
 */

import { ExtensionContext } from "@foxglove/studio";
import { initPanel } from "./crane_visualizer_panel";
import { initConfigPanel } from "./config_panel";
import { initUiControlPanel } from "./ui_control_panel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "crane-visualizer-panel", initPanel: initPanel });
  extensionContext.registerPanel({
    name: "control-panel",
    initPanel: initUiControlPanel,
  });
  extensionContext.registerPanel({
    name: "config-panel",
    initPanel: initConfigPanel,
  });
}
