"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const crane_visualizer_panel_1 = require("./crane_visualizer_panel");
function activate(extensionContext) {
    extensionContext.registerPanel({ name: "crane-visualizer-panel", initPanel: crane_visualizer_panel_1.initPanel });
}
