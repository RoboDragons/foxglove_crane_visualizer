"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initPanel = initPanel;
const React = __importStar(require("react"));
const react_1 = require("react");
const react_dom_1 = __importDefault(require("react-dom"));
const react_2 = require("react");
const defaultConfig = {
    backgroundColor: "#585858ff",
    message: "",
    viewBoxWidth: 10000,
    namespaces: {},
};
const CraneVisualizer = ({ context }) => {
    const [viewBox, setViewBox] = (0, react_1.useState)("-5000 -3000 10000 6000");
    const [config, setConfig] = (0, react_1.useState)(defaultConfig);
    const [topic, setTopic] = (0, react_1.useState)("/aggregated_svgs");
    const [topics, setTopics] = (0, react_1.useState)();
    const [messages, setMessages] = (0, react_1.useState)();
    const [renderDone, setRenderDone] = (0, react_1.useState)();
    const [recv_num, setRecvNum] = (0, react_1.useState)(0);
    const [latest_msg, setLatestMsg] = (0, react_1.useState)();
    const resetViewBox = (0, react_1.useCallback)(() => {
        const x = -config.viewBoxWidth / 2;
        const aspectRatio = 0.6; // 元のアスペクト比 (6000 / 10000)
        const height = config.viewBoxWidth * aspectRatio;
        const y = -height / 2;
        setViewBox(`${x} ${y} ${config.viewBoxWidth} ${height}`);
    }, [setViewBox, config]);
    (0, react_1.useEffect)(() => {
        const handleKeyDown = (event) => {
            if (event.ctrlKey && event.key === "0") {
                event.preventDefault();
                const x = -config.viewBoxWidth / 2;
                const aspectRatio = 0.6; // 元のアスペクト比 (6000 / 10000)
                const height = config.viewBoxWidth * aspectRatio;
                const y = -height / 2;
                setViewBox(`${x} ${y} ${config.viewBoxWidth} ${height}`);
            }
            else if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
                event.preventDefault();
                setViewBox((current) => {
                    const [x, y, width, height] = current.split(" ").map(Number);
                    const scale = 0.8;
                    const newWidth = width * scale;
                    const newHeight = height * scale;
                    const newX = x + width / 2 - newWidth / 2;
                    const newY = y + height / 2 - newHeight / 2;
                    return `${newX} ${newY} ${newWidth} ${newHeight}`;
                });
            }
            else if (event.ctrlKey && event.key === "-") {
                event.preventDefault();
                setViewBox((current) => {
                    const [x, y, width, height] = current.split(" ").map(Number);
                    const scale = 1.2;
                    const newWidth = width * scale;
                    const newHeight = height * scale;
                    const newX = x + width / 2 - newWidth / 2;
                    const newY = y + height / 2 - newHeight / 2;
                    return `${newX} ${newY} ${newWidth} ${newHeight}`;
                });
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [resetViewBox, config]);
    // トピックが設定されたときにサブスクライブする
    (0, react_1.useEffect)(() => {
        const subscription = { topic: topic };
        context.subscribe([subscription]);
    }, [topic]);
    (0, react_1.useLayoutEffect)(() => {
        context.saveState(config);
    }, [config, context]);
    (0, react_1.useLayoutEffect)(() => {
        const savedConfig = context.initialState;
        if (savedConfig) {
            setConfig((prevConfig) => ({ ...prevConfig, ...savedConfig, namespaces: savedConfig.namespaces || prevConfig.namespaces }));
        }
    }, [context, setConfig]);
    (0, react_1.useEffect)(() => {
        const updatePanelSettings = () => {
            const panelSettings = {
                nodes: {
                    general: {
                        label: "General",
                        fields: {
                            topic: { label: "トピック名", input: "string", value: topic },
                            backgroundColor: { label: "背景色", input: "rgba", value: config.backgroundColor },
                            viewBoxWidth: { label: "ViewBox 幅", input: "number", value: config.viewBoxWidth },
                        },
                    },
                    namespaces: {
                        label: "名前空間",
                        fields: createNamespaceFields(config.namespaces),
                    },
                },
                actionHandler: (action) => {
                    const path = action.payload.path.join(".");
                    switch (action.action) {
                        case "update":
                            if (path == "general.topic") {
                                setTopic(action.payload.value);
                            }
                            else if (path == "general.backgroundColor") {
                                setConfig((prevConfig) => ({ ...prevConfig, backgroundColor: action.payload.value }));
                            }
                            else if (path == "general.viewBoxWidth") {
                                setConfig((prevConfig) => ({ ...prevConfig, viewBoxWidth: action.payload.value }));
                            }
                            else if (path == "general.viewBoxHeight") {
                                setConfig((prevConfig) => ({ ...prevConfig, viewBoxHeight: action.payload.value }));
                            }
                            else if (action.payload.path[0] == "namespaces") {
                                const pathParts = path.split(".");
                                const namespacePath = pathParts.slice(1, -1);
                                const leafNamespace = pathParts[pathParts.length - 1];
                                let currentNs = config.namespaces;
                                for (const ns of namespacePath) {
                                    currentNs = currentNs[ns].children || {};
                                }
                                currentNs[leafNamespace].visible = action.payload.value;
                            }
                            break;
                        case "perform-node-action":
                            break;
                    }
                },
            };
            context.updatePanelSettingsEditor(panelSettings);
        };
        updatePanelSettings();
    }, [context, config]);
    const createNamespaceFields = (namespaces) => {
        const fields = {};
        const addFieldsRecursive = (ns, path = []) => {
            for (const [name, { visible, children }] of Object.entries(ns)) {
                const currentPath = [...path, name];
                const key = currentPath.join(".");
                fields[key] = {
                    label: name,
                    input: "boolean",
                    value: visible,
                    help: "名前空間の表示/非表示",
                };
                if (children) {
                    addFieldsRecursive(children, currentPath);
                }
            }
        };
        addFieldsRecursive(namespaces);
        return fields;
    };
    // メッセージ受信時の処理
    (0, react_1.useLayoutEffect)(() => {
        context.onRender = (renderState, done) => {
            setRenderDone(() => done);
            setMessages(renderState.currentFrame);
            setTopics(renderState.topics);
        };
        context.watch("topics");
        context.watch("currentFrame");
    }, [context, topic]);
    (0, react_1.useEffect)(() => {
        if (messages) {
            for (const message of messages) {
                if (message.topic === topic) {
                    const msg = message.message;
                    setLatestMsg(msg);
                    setRecvNum(recv_num + 1);
                    // 初期化時にconfig.namespacesを設定
                    setConfig((prevConfig) => {
                        const newNamespaces = { ...prevConfig.namespaces };
                        msg.svg_primitive_arrays.forEach((svg_primitive_array) => {
                            if (!newNamespaces[svg_primitive_array.layer]) {
                                const defaultVisibility = svg_primitive_array.config?.visible_by_default ?? true;
                                newNamespaces[svg_primitive_array.layer] = { visible: defaultVisibility };
                            }
                        });
                        return { ...prevConfig, namespaces: newNamespaces };
                    });
                }
            }
        }
    }, [messages]);
    // invoke the done callback once the render is complete
    (0, react_1.useEffect)(() => {
        renderDone?.();
    }, [renderDone]);
    const handleCheckboxChange = (layer) => {
        setConfig((prevConfig) => {
            const newNamespaces = { ...prevConfig.namespaces };
            if (!newNamespaces[layer]) {
                newNamespaces[layer] = { visible: true };
            }
            newNamespaces[layer].visible = !newNamespaces[layer].visible;
            return { ...prevConfig, namespaces: newNamespaces };
        });
    };
    return (React.createElement("div", { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column" } },
        React.createElement("div", { style: { width: "100%", height: "100%", overflow: "hidden" } },
            React.createElement("div", null,
                React.createElement("p", null,
                    "Topic: ",
                    topic)),
            React.createElement("div", null,
                React.createElement("p", null,
                    "Receive num: ",
                    recv_num)),
            React.createElement("svg", { width: "100%", height: "100%", viewBox: viewBox, style: { backgroundColor: config.backgroundColor }, onMouseDown: (e) => {
                    const startX = e.clientX;
                    const startY = e.clientY;
                    const [x, y, width, height] = viewBox.split(" ").map(Number);
                    const handleMouseMove = (e) => {
                        const dx = e.clientX - startX;
                        const dy = e.clientY - startY;
                        const scaledDx = dx * width / 400;
                        const scaledDy = dy * height / 400;
                        setViewBox(`${x - scaledDx} ${y - scaledDy} ${width} ${height}`);
                    };
                    const handleMouseUp = () => {
                        document.removeEventListener("mousemove", handleMouseMove);
                        document.removeEventListener("mouseup", handleMouseUp);
                    };
                    document.addEventListener("mousemove", handleMouseMove);
                    document.addEventListener("mouseup", handleMouseUp);
                }, onWheel: (e) => {
                    e.preventDefault();
                    const [x, y, width, height] = viewBox.split(" ").map(Number);
                    const scale = e.deltaY > 0 ? 1.2 : 0.8;
                    let newWidth = width * scale;
                    let newHeight = height * scale;
                    const minWidth = width / 10;
                    const maxWidth = width * 10;
                    const minHeight = height / 10;
                    const maxHeight = height * 10;
                    newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
                    newHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
                    const centerX = x + width / 2;
                    const centerY = y + height / 2;
                    const newX = centerX - newWidth / 2;
                    const newY = centerY - newHeight / 2;
                    setViewBox(`${newX} ${newY} ${newWidth} ${newHeight}`);
                } }, latest_msg && latest_msg.svg_primitive_arrays.map((svg_primitive_array, index) => {
                return (React.createElement("g", { key: svg_primitive_array.layer, style: { display: config.namespaces[svg_primitive_array.layer]?.visible ? 'block' : 'none' } }, svg_primitive_array.svg_primitives.map((svg_primitive, svgIndex) => (React.createElement("g", { key: svgIndex, dangerouslySetInnerHTML: { __html: svg_primitive } })))));
            })))));
};
function initPanel(context) {
    react_dom_1.default.render(React.createElement(react_2.StrictMode, null,
        React.createElement(CraneVisualizer, { context: context })), context.panelElement);
    return () => {
        react_dom_1.default.unmountComponentAtNode(context.panelElement);
    };
}
