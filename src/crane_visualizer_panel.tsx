import {
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  SettingsTree,
  SettingsTreeAction,
  SettingsTreeField,
  Subscription,
  Topic
} from "@foxglove/studio";
import * as React from "react";
import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";

// 送信データの型定義
type MouseStateType = "DOWN" | "UP" | "MOVE" | null;

interface InteractionMessage {
  buttons: number; // MouseEvent.buttons
  keys: string[]; // 押されているキーの配列
  mouse_state: MouseStateType;
  position: { x: number; y: number };
}

interface SvgPrimitiveArray {
  layer: string;
  svg_primitives: string[];
  config: {
    visible_by_default?: boolean;
  };
}

interface SvgLayerArray {
  svg_primitive_arrays: SvgPrimitiveArray[];
}

interface PanelConfig {
  backgroundColor: string;
  message: string;
  viewBoxWidth: number;
  namespaces: {
    [key: string]: {
      visible: boolean;
      children?: { [key: string]: { visible: boolean; children?: any } };
    };
  };
}

const defaultConfig: PanelConfig = {
  backgroundColor: "#585858ff",
  message: "",
  viewBoxWidth: 10000,
  namespaces: {},
};

const CraneVisualizer: React.FC<{ context: PanelExtensionContext }> = ({
  context,
}) => {
  const [viewBox, setViewBox] = useState("-5000 -3000 10000 6000");
  const [config, setConfig] = useState<PanelConfig>(defaultConfig);
  const [topic, setTopic] = useState<string>("/aggregated_svgs");
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [messages, setMessages] = useState<
    undefined | Immutable<MessageEvent[]>
  >();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [recv_num, setRecvNum] = useState(0);
  const [latest_msg, setLatestMsg] = useState<SvgLayerArray>();

  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  const panStateRef = useRef<{
    startX: number;
    startY: number;
    startViewBox: number[];
  } | null>(null);

  // マウスの最新情報を保存するためのref
  const mouseInfoRef = useRef({ clientX: 0, clientY: 0, buttons: 0 });
  // マウスの状態(DOWN/UP/MOVE)を保存するためのref
  const mouseStateRef = useRef<MouseStateType>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  const SEND_INTERVAL = 1000 / 60; // 16.67ms
  const INTERACTION_TOPIC = "/interaction_event";

  const resetViewBox = useCallback(() => {
    const x = -config.viewBoxWidth / 2;
    const aspectRatio = 0.6; // 6000 / 10000
    const height = config.viewBoxWidth * aspectRatio;
    const y = -height / 2;
    setViewBox(`${x} ${y} ${config.viewBoxWidth} ${height}`);
  }, [setViewBox, config]);

  const screenToFieldCoordinate = useCallback(
    (clientX: number, clientY: number) => {
      if (!svgRef.current) return null;
      // viewport(パネル表示域)の位置とサイズ
      const rect = svgRef.current.getBoundingClientRect();
      // SVGのviewBoxの位置とサイズ
      const [vbX, vbY, vbWidth, vbHeight] = viewBox.split(" ").map(Number);

      // SVGのviewBoxアスペクト比
      const viewBoxAspect = vbWidth / vbHeight;
      // viewport(パネル)のアスペクト比
      const rectAspect = rect.width / rect.height;

      let offsetX = 0, offsetY = 0, drawWidth = rect.width, drawHeight = rect.height;

      // アスペクト比に応じてSVGの余白を計算
      if (rectAspect > viewBoxAspect) {
        // 横長: 左右に余白が生じる（pillarbox）
        drawWidth = rect.height * viewBoxAspect;
        offsetX = (rect.width - drawWidth) / 2;
      } else if (rectAspect < viewBoxAspect) {
        // 縦長: 上下に余白が生じる（letterbox）
        drawHeight = rect.width / viewBoxAspect;
        offsetY = (rect.height - drawHeight) / 2;
      }

      // 余白を除いた実際の描画領域で座標変換
      const normX = (clientX - rect.left - offsetX) / drawWidth;
      const normY = (clientY - rect.top - offsetY) / drawHeight;

      // 範囲外（余白部分）はnullを返す
      if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return null;

      const fieldX = vbX + normX * vbWidth;
      const fieldY = vbY + normY * vbHeight;

      return { x: fieldX, y: fieldY };
    },
    [viewBox]
  );

  const sendInteraction = useCallback(
    (data: Omit<InteractionMessage, "position">, clientX: number, clientY: number) => {
      // 継続的に送信するループ側で送信間隔を制御するため、ここでのスロットリングは不要
      const fieldCoord = screenToFieldCoordinate(clientX, clientY);
      if (!fieldCoord) return;

      const message: InteractionMessage = {
        ...data,
        position: { x: fieldCoord.x, y: fieldCoord.y },
      };

      context.publish?.(INTERACTION_TOPIC, message);
    },
    [screenToFieldCoordinate, context]
  );

  // 60FPSでInteractionMessageを送信し続けるためのuseEffect
  useEffect(() => {
    const intervalId = setInterval(() => {
      const { clientX, clientY, buttons } = mouseInfoRef.current;

      const payload = {
        buttons,
        keys: Array.from(pressedKeys),
        mouse_state: mouseStateRef.current,
      };

      sendInteraction(payload, clientX, clientY);

      // DOWNとUPは1フレーム限りのイベントなので、送信後にMOVE(またはnull)に戻す
      if (mouseStateRef.current === "DOWN" || mouseStateRef.current === "UP") {
        mouseStateRef.current = buttons > 0 ? "MOVE" : null;
      }
    }, SEND_INTERVAL);

    return () => clearInterval(intervalId);
  }, [pressedKeys, sendInteraction]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      setPressedKeys((prev) => new Set(prev).add(event.key));
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      setPressedKeys((prev) => {
        const next = new Set(prev);
        next.delete(event.key);
        return next;
      });
    };

    // ショートカットキーによるウィンドウ切り替えなどでウィンドウが非アクティブになったときにキー状態をリセット
    const handleWindowBlur = () => {
      setPressedKeys(new Set());
      // reset mouse refs
      mouseInfoRef.current = { clientX: 0, clientY: 0, buttons: 0 };
      mouseStateRef.current = null;
      panStateRef.current = null;
    };

    // タブが非表示になったときにキー状態をリセット
    const handleVisibilityChange = () => {
      if (document.hidden) {
        handleWindowBlur();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isResetShortcut = event.ctrlKey && (event.code === "Digit0" || event.code === "Numpad0");
      const isZoomInShortcut =
        event.ctrlKey &&
        (event.code === "Equal" || event.code === "Semicolon" || event.code === "NumpadAdd");
      const isZoomOutShortcut =
        event.ctrlKey && (event.code === "Minus" || event.code === "NumpadSubtract");

      if (isResetShortcut) {
        event.preventDefault();
        resetViewBox();
      } else if (isZoomInShortcut) {
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
      } else if (isZoomOutShortcut) {
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
  }, [resetViewBox]);

  useEffect(() => {
    const subscription: Subscription = { topic: topic };
    context.subscribe([subscription]);
  }, [topic, context]);

  useLayoutEffect(() => {
    context.saveState(config);
  }, [config, context]);

  useLayoutEffect(() => {
    const savedConfig = context.initialState as PanelConfig | undefined;
    if (savedConfig) {
      setConfig((prevConfig) => ({ ...prevConfig, ...savedConfig, namespaces: savedConfig.namespaces || prevConfig.namespaces }));
    }
  }, [context, setConfig]);

  useEffect(() => {
    const updatePanelSettings = () => {
      const panelSettings: SettingsTree = {
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
        actionHandler: (action: SettingsTreeAction) => {
          const path = action.payload.path.join(".");
          switch (action.action) {
            case "update":
              if (path === "general.topic") {
                setTopic(action.payload.value as string);
              } else if (path == "general.backgroundColor") {
                setConfig((prevConfig) => ({ ...prevConfig, backgroundColor: action.payload.value as string }));
              } else if (path == "general.viewBoxWidth") {
                setConfig((prevConfig) => ({ ...prevConfig, viewBoxWidth: action.payload.value as number }));
              }
              else if (action.payload.path[0] == "namespaces") {
                const pathParts = path.split(".");
                const namespacePath = pathParts.slice(1, -1);
                const leafNamespace = pathParts[pathParts.length - 1]!;
                let currentNs = config.namespaces;
                for (const ns of namespacePath) {
                  currentNs = currentNs[ns]!.children || {};
                }
                currentNs[leafNamespace]!.visible = action.payload.value as boolean;
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
  }, [context, config, topic]);

  const createNamespaceFields = (namespaces: PanelConfig["namespaces"]) => {
    const fields: { [key: string]: SettingsTreeField } = {};
    const addFieldsRecursive = (ns: { [key: string]: any }, path: string[] = []) => {
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

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setMessages(renderState.currentFrame);
      setTopics(renderState.topics);
    };

    context.watch("topics");
    context.watch("currentFrame");

    context.advertise?.(INTERACTION_TOPIC, "/input_event");
  }, [context]);

  useEffect(() => {
    if (messages) {
      for (const message of messages) {
        if (message.topic === topic) {
          const msg = message.message as SvgLayerArray;
          setLatestMsg(msg);
          setRecvNum((prev) => prev + 1);

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
  }, [messages, topic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
        <div>
          <p>Topic: {topic}</p>
        </div>
        <div>
          <p>Receive num: {recv_num}</p>
        </div>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={viewBox}
          style={{ backgroundColor: config.backgroundColor }}
          // イベントハンドラは直接メッセージを送るのではなく、refに最新の状態を保存するだけ
          onMouseDown={(e) => {
            e.preventDefault();
            mouseStateRef.current = "DOWN";
            mouseInfoRef.current = { clientX: e.clientX, clientY: e.clientY, buttons: e.buttons };

            if (pressedKeys.size === 0) {
              panStateRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                startViewBox: viewBox.split(" ").map(Number),
              };
            }
          }}
          onMouseMove={(e) => {
            mouseInfoRef.current = { clientX: e.clientX, clientY: e.clientY, buttons: e.buttons };
            if (mouseStateRef.current !== "DOWN") {
              mouseStateRef.current = e.buttons > 0 ? "MOVE" : null;
            }

            if (panStateRef.current) {
              const { startX, startY, startViewBox } = panStateRef.current;
              const [x, y, width, height] = startViewBox;
              const dx = e.clientX - startX;
              const dy = e.clientY - startY;

              const scaledDx =
                dx * (width / (svgRef.current?.clientWidth ?? width));
              const scaledDy =
                dy * (height / (svgRef.current?.clientHeight ?? height));

              setViewBox(`${x - scaledDx} ${y - scaledDy} ${width} ${height}`);
            }
          }}
          onMouseUp={(e) => {
            panStateRef.current = null;
            mouseStateRef.current = "UP";
            mouseInfoRef.current = { clientX: e.clientX, clientY: e.clientY, buttons: e.buttons };
          }}
          onMouseLeave={(e) => {
            // SVG領域からマウスが出たらボタンの状態をリセット
            mouseInfoRef.current = { clientX: e.clientX, clientY: e.clientY, buttons: 0 };
            mouseStateRef.current = null;
            panStateRef.current = null;
          }}
          onWheel={(e) => {
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
          }}
        >
          {latest_msg && latest_msg.svg_primitive_arrays.map((svg_primitive_array, index) => {
            return (
              <g key={svg_primitive_array.layer} style={{ display: config.namespaces[svg_primitive_array.layer]?.visible ? 'block' : 'none' }}>
                {svg_primitive_array.svg_primitives.map((svg_primitive, svgIndex) => (
                  <g key={svgIndex} dangerouslySetInnerHTML={{ __html: svg_primitive }} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

export function initPanel(context: PanelExtensionContext): () => void {
  ReactDOM.render(
    <StrictMode>
      <CraneVisualizer context={context} />
    </StrictMode>,
    context.panelElement,
  );
  return () => {
    ReactDOM.unmountComponentAtNode(context.panelElement);
  };
}
