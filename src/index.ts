import { ExtensionContext } from "@foxglove/studio";
import { initPanel } from "./crane_visualizer_panel";
import { initUiControlPanel } from "./ui_control_panel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "crane-visualizer-panel", initPanel: initPanel });
  extensionContext.registerPanel({
    name: "crane-control-panel",
    initPanel: initUiControlPanel,
  });
}
