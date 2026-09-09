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

// レイヤーごとの表示設定（フォーク独自。本家には無い）
interface SvgLayerConfig {
  visible_by_default?: boolean;
}

interface SvgPrimitiveArray {
  layer: string;
  svg_primitives: string[];
  // 差分更新（/visualizer_svgs）由来のレイヤーには config が無いため任意とする
  config?: SvgLayerConfig;
}

interface SvgLayerArray {
  svg_primitive_arrays: SvgPrimitiveArray[];
}

// 互換性用: 新しいスナップショット形式（SvgSnapshot）の可能性
interface SvgSnapshotCompat {
  layers?: SvgPrimitiveArray[];
}

// /visualizer_svgsトピック用のインターフェース
interface SvgLayerUpdate {
  layer: string; // "parent/child1/child2"のような階層パス
  operation: "append" | "replace" | "clear"; // 操作タイプ
  svg_primitives: string[]; // SVGプリミティブ配列
  duration?: number; // 有効期限(秒)。0または未定義=無限
}

interface SvgUpdateArray {
  updates: SvgLayerUpdate[];
}

// 正規化ヘルパ（スナップショット）
const normalizeSnapshot = (raw: any): SvgLayerArray | undefined => {
  try {
    const arrays: SvgPrimitiveArray[] | undefined = Array.isArray(raw?.svg_primitive_arrays)
      ? (raw.svg_primitive_arrays as SvgPrimitiveArray[])
      : Array.isArray((raw as SvgSnapshotCompat)?.layers)
      ? ((raw as SvgSnapshotCompat).layers as SvgPrimitiveArray[])
      : undefined;
    if (!arrays) return undefined;
    const filtered = arrays
      .filter((a) => a && a.layer && Array.isArray(a.svg_primitives))
      // config（visible_by_default）は落とさずに引き継ぐ
      .map((a) => ({ layer: a.layer, svg_primitives: a.svg_primitives, config: a.config }));
    return { svg_primitive_arrays: filtered };
  } catch {
    return undefined;
  }
};

// 正規化ヘルパ（更新: 旧互換としてスナップショット形をreplaceに変換）
const normalizeUpdates = (raw: any): SvgUpdateArray | undefined => {
  try {
    if (raw && Array.isArray(raw.updates)) {
      return raw as SvgUpdateArray;
    }
    const arrays: SvgPrimitiveArray[] | undefined = Array.isArray(raw?.svg_primitive_arrays)
      ? (raw.svg_primitive_arrays as SvgPrimitiveArray[])
      : Array.isArray((raw as SvgSnapshotCompat)?.layers)
      ? ((raw as SvgSnapshotCompat).layers as SvgPrimitiveArray[])
      : undefined;
    if (!arrays) return undefined;
    return {
      updates: arrays
        .filter((a) => a && a.layer && Array.isArray(a.svg_primitives))
        .map((a) => ({ layer: a.layer, operation: "replace", svg_primitives: a.svg_primitives })),
    };
  } catch {
    return undefined;
  }
};

// 組み直しの結果でレイヤー状態を置き換える。
//
// **結果が空なら置き換えない。** 履歴にスナップショットが無い時刻を組み直すと
// undefined や空が返るが、それで置き換えると画面から絵が全部消える。
// 古い絵を出したまま次のスナップショット（1秒以内）を待つほうが実害が小さい。
//
// @returns 置き換えたら true
const replaceLayersIfNotEmpty = (
  target: React.MutableRefObject<Map<string, SvgPrimitiveArray>>,
  composed: SvgLayerArray | undefined
): boolean => {
  const arrays = composed?.svg_primitive_arrays;
  if (!arrays || arrays.length === 0) return false;
  target.current = new Map(arrays.map((array) => [array.layer, array]));
  return true;
};

// シークとみなす巻き戻り量[ms]。
// ライブ受信でも currentTime と receiveTime は数 ms ずれるので、
// その揺れをシークと誤判定しないだけの余裕を持たせる。
// スナップショットは 1Hz なので、これ未満のずれは次のスナップショットで必ず整合する
const SEEK_BACKWARD_THRESHOLD_MS = 500;

// 差分をレイヤー状態へ適用する。ライブ表示とシーク時の合成で共通に使う
const applyUpdates = (
  layers: Map<string, SvgPrimitiveArray>,
  updateArray: SvgUpdateArray
): void => {
  for (const update of updateArray.updates ?? []) {
    if (!update || !update.layer || !update.operation) continue;
    const current = layers.get(update.layer);
    switch (update.operation) {
      case "replace":
        if (Array.isArray(update.svg_primitives)) {
          layers.set(update.layer, {
            layer: update.layer,
            svg_primitives: update.svg_primitives,
            config: current?.config,
          });
        }
        break;
      case "append":
        if (Array.isArray(update.svg_primitives)) {
          layers.set(update.layer, {
            layer: update.layer,
            svg_primitives: [...(current?.svg_primitives ?? []), ...update.svg_primitives],
            config: current?.config,
          });
        }
        break;
      case "clear":
        // レイヤー自体は残す。消すと表示切替の一覧から消えてしまう
        layers.set(update.layer, {
          layer: update.layer,
          svg_primitives: [],
          config: current?.config,
        });
        break;
      default:
        console.warn(`Unknown operation: ${update.operation}`);
        break;
    }
  }
};

interface PanelConfig {
  backgroundColor: string;
  message: string;
  viewBoxWidth: number;
  aggregatedTopic: string; // /aggregated_svgsトピック名
  updateTopic: string; // /visualizer_svgsトピック名
  enableUpdateTopic: boolean; // /visualizer_svgsトピックの有効/無効
  // 描画モード（遅さの切り分け用）。**既定は normal で従来どおり。**
  // どのモードでも受信・履歴・MCAP への記録には影響しない
  // （MCAP はサーバー側の Sink が書くので、ここで何を描くかとログの中身は無関係）。
  //   normal       : 全レイヤーを描く（非表示レイヤーは display:none）
  //   visible-only : 表示中のレイヤーだけ要素を作る
  //   off          : 何も描かない
  renderMode: "normal" | "visible-only" | "off";
  maxHistoryDuration: number; // 履歴保持期間（秒）
  maxHistorySize: number; // 最大履歴サイズ
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
  aggregatedTopic: "/aggregated_svgs",
  updateTopic: "/visualizer_svgs",
  enableUpdateTopic: true,
  renderMode: "normal",
  // 差分は毎秒 40 件前後・1件 30KB 程度届く。履歴はシークの起点を確保するためだけの
  // ものなので短くてよい（スナップショットが 1Hz で来るため数秒あれば足りる）
  maxHistoryDuration: 30, // 30秒間
  maxHistorySize: 300, // 最大300メッセージ
  namespaces: {},
};

const CraneVisualizer: React.FC<{ context: PanelExtensionContext }> = ({
  context,
}) => {
  const [viewBox, setViewBox] = useState("-5000 -3000 10000 6000");
  const [config, setConfig] = useState<PanelConfig>(defaultConfig);
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [messages, setMessages] = useState<
    undefined | Immutable<MessageEvent[]>
  >();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [recv_num, setRecvNum] = useState(0);
  const [latest_msg, setLatestMsg] = useState<SvgLayerArray>();
  
  // 複数トピックのメッセージ履歴。**state ではなく ref で持つ。**
  // 毎秒 40 件前後届くので state にすると1メッセージごとに再描画と Map のコピーが走り、
  // パネルが配信レートに追いつけなくなる。履歴を読むのはシークのときだけなので、
  // 描画のトリガにする必要が無い。
  const aggregatedMessagesRef = useRef<Map<number, MessageEvent>>(new Map());
  // 同一ミリ秒に複数の更新が来る可能性に対応するため配列で保持
  const updateMessagesRef = useRef<Map<number, MessageEvent[]>>(new Map());
  // ライブ表示用に差分を適用し続けるレイヤー状態。
  // 毎フレーム「直前のスナップショット + それ以降の差分」を組み直すと、
  // 1秒分（約 40 件）の差分を毎フレーム再適用することになり極端に重い。
  const liveLayersRef = useRef<Map<string, SvgPrimitiveArray>>(new Map());
  // 最後に適用したメッセージの時刻（receiveTime）
  const lastAppliedTimeRef = useRef<number>(-1);
  // 組み直しに失敗した回数（診断用）。増え続けるならシーク判定が誤発火している
  const recomposeFailureRef = useRef<number>(0);

  // 描画性能の計測（診断用）。
  // 「トピックは 50〜60Hz 来ているのに画面がもっさり」を切り分けるためのもの。
  // onRender の間隔＝Studio がこのパネルを描き直せている実効レート、
  // onRender から done() までが React の再構築にかかっている時間。
  // done() を返すまで Studio は次のフレームを渡さないので、後者が長いほど前者が落ちる。
  const perfRef = useRef({
    frameStartMs: 0,
    commitEndMs: 0,
    intervals: [] as number[],   // onRender の間隔[ms]
    durations: [] as number[],   // onRender → React のコミット完了[ms]
    frames: [] as number[],      // onRender → 次のアニメーションフレーム[ms]（＝ブラウザの描画込み）
    primitives: 0,               // 直近フレームのプリミティブ総数
    visiblePrimitives: 0,        // うち表示中のレイヤーのもの
    domNodes: 0,                 // SVG 配下の実 DOM ノード数
  });
  // namespaces の最新値。数え上げのために config を effect の依存に入れたくないので ref で持つ
  const namespacesRef = useRef<PanelConfig["namespaces"]>({});
  const PERF_SAMPLES = 30;
  const pushSample = (samples: number[], value: number) => {
    samples.push(value);
    if (samples.length > PERF_SAMPLES) samples.shift();
  };
  const average = (samples: number[]) =>
    samples.length === 0 ? 0 : samples.reduce((a, b) => a + b, 0) / samples.length;
  // 最後に見た再生時刻（currentTime）。シークの検出に使う。
  // **メッセージ側の時刻（receiveTime）と比べないこと。**
  // 別々の時計なのでライブ受信でも数 ms ずれ、毎フレーム「シーク」と誤判定して
  // 履歴からの組み直しが走る（表示が 1〜2Hz まで落ちる）
  const lastSeekTimeRef = useRef<number | undefined>(undefined);
  
  // 時間軸管理
  const [seekTime, setSeekTime] = useState<number | undefined>();
  const [currentDisplayMsg, setCurrentDisplayMsg] = useState<SvgLayerArray | undefined>();

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
  }, [config.viewBoxWidth]);

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

  // 指定時刻の絵を履歴から組み直す。**シークのときだけ呼ぶ。**
  // 通常の再生ではこの経路を通さず、届いた差分をそのまま liveLayersRef へ適用する。
  const composeMessagesAtTime = useCallback((targetTime: number): SvgLayerArray | undefined => {
    try {
      // 直前のスナップショットを探す（差分はこれを起点にしないと組み立たない）
      let latestAggregatedTime = -1;
      let latestAggregatedMsg: SvgLayerArray | undefined;
      for (const [timestamp, message] of aggregatedMessagesRef.current) {
        if (timestamp <= targetTime && timestamp > latestAggregatedTime) {
          latestAggregatedTime = timestamp;
          latestAggregatedMsg = normalizeSnapshot(message.message);
        }
      }

      const layers = new Map<string, SvgPrimitiveArray>();
      latestAggregatedMsg?.svg_primitive_arrays.forEach((array) => {
        if (array && array.layer && Array.isArray(array.svg_primitives)) {
          layers.set(array.layer, array);
        }
      });

      if (!config.enableUpdateTopic) {
        return latestAggregatedMsg;
      }

      // スナップショットの直後から targetTime までの差分を時間順に適用する。
      // スナップショットが無い場合は履歴の最古から拾う
      const lowerBound = latestAggregatedMsg ? latestAggregatedTime : Number.NEGATIVE_INFINITY;
      const relevant: Array<[number, MessageEvent[]]> = [];
      for (const [timestamp, messagesAtTs] of updateMessagesRef.current) {
        if (timestamp > lowerBound && timestamp <= targetTime) {
          relevant.push([timestamp, messagesAtTs]);
        }
      }
      relevant.sort((a, b) => a[0] - b[0]);
      for (const [timestamp, messagesAtTs] of relevant) {
        for (const message of messagesAtTs) {
          try {
            const updateArray = normalizeUpdates(message.message);
            if (updateArray) applyUpdates(layers, updateArray);
          } catch (error) {
            console.warn(`Invalid update message at timestamp ${timestamp}:`, error);
          }
        }
      }

      // スナップショットが無く、適用しても何も残らないなら描くものが無い
      if (!latestAggregatedMsg && layers.size === 0) {
        return undefined;
      }
      return { svg_primitive_arrays: Array.from(layers.values()) };
    } catch (error) {
      console.error('Error in composeMessagesAtTime:', error);
      return undefined;
    }
  }, [config.enableUpdateTopic]);

  // 履歴クリーンアップ関数。
  // 依存はプリミティブだけにすること。履歴の Map を依存に入れると
  // 下の setInterval が毎メッセージ張り直されて**一度も発火しなくなる**
  const cleanupHistory = useCallback(() => {
    // 基準はメッセージ側の時刻（receiveTime）であって実時間ではない。
    // Date.now() を使うと、MCAP の再生中は記録時刻が過去にあるため
    // 履歴が毎回まるごと捨てられ、スナップショットが来るまで絵が欠ける。
    //
    // **基準は履歴そのものから取る。** lastAppliedTimeRef を使うと、
    // シーク後にそこへ再生時刻（別の時計）が入っていた場合に
    // 履歴をまるごと捨ててしまい、次の組み直しが空になって絵が全部消える。
    let latestTimestamp = -1;
    for (const [timestamp] of aggregatedMessagesRef.current) {
      if (timestamp > latestTimestamp) latestTimestamp = timestamp;
    }
    for (const [timestamp] of updateMessagesRef.current) {
      if (timestamp > latestTimestamp) latestTimestamp = timestamp;
    }
    if (latestTimestamp < 0) return;  // まだ何も受け取っていない
    const cutoffTime = latestTimestamp - (config.maxHistoryDuration * 1000);

    const trim = (map: Map<number, unknown>) => {
      const kept = Array.from(map.entries())
        .filter(([timestamp]) => timestamp >= cutoffTime)
        .sort(([a], [b]) => b - a)          // 新しい順にソート
        .slice(0, config.maxHistorySize);   // 最大サイズで制限
      map.clear();
      for (const [timestamp, value] of kept) {
        map.set(timestamp, value);
      }
    };
    trim(aggregatedMessagesRef.current as Map<number, unknown>);
    trim(updateMessagesRef.current as Map<number, unknown>);
  }, [config.maxHistoryDuration, config.maxHistorySize]);

  // 定期的なクリーンアップ
  useEffect(() => {
    const interval = setInterval(() => {
      cleanupHistory();
    }, 5000); // 5秒ごとにクリーンアップ
    
    return () => clearInterval(interval);
  }, [cleanupHistory]);

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

  // 複数トピックのサブスクリプション
  useEffect(() => {
    const subscriptions: Subscription[] = [{ topic: config.aggregatedTopic }];
    if (config.enableUpdateTopic) {
      subscriptions.push({ topic: config.updateTopic });
    }
    context.subscribe(subscriptions);
  }, [config.aggregatedTopic, config.updateTopic, config.enableUpdateTopic, context]);

  useLayoutEffect(() => {
    namespacesRef.current = config.namespaces;
  }, [config.namespaces]);

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
          topics: {
            label: "トピック設定",
            fields: {
              aggregatedTopic: { 
                label: "スナップショットトピック", 
                input: "string", 
                value: config.aggregatedTopic,
                help: "完全な状態を含む低頻度トピック" 
              },
              updateTopic: { 
                label: "更新トピック", 
                input: "string", 
                value: config.updateTopic,
                help: "レイヤーごとの更新を含む高頻度トピック" 
              },
              enableUpdateTopic: { 
                label: "更新トピック有効", 
                input: "boolean", 
                value: config.enableUpdateTopic,
                help: "無効にするとスナップショットのみ使用" 
              },
            },
          },
          performance: {
            label: "パフォーマンス設定",
            fields: {
              maxHistoryDuration: { 
                label: "履歴保持期間(秒)", 
                input: "number", 
                value: config.maxHistoryDuration,
                help: "この秒数より古いメッセージは自動削除" 
              },
              maxHistorySize: { 
                label: "最大履歴サイズ", 
                input: "number", 
                value: config.maxHistorySize,
                help: "保持するメッセージの最大数" 
              },
            },
          },
          display: {
            label: "表示設定",
            fields: {
              renderMode: {
                label: "描画モード",
                input: "select",
                value: config.renderMode,
                options: [
                  { label: "通常", value: "normal" },
                  { label: "表示中のみ要素を作る", value: "visible-only" },
                  { label: "描画しない（計測用）", value: "off" },
                ],
                help: "遅さの切り分け用。変えても受信とログ記録には影響しない",
              },
              backgroundColor: { 
                label: "背景色", 
                input: "rgba", 
                value: config.backgroundColor 
              },
              viewBoxWidth: { 
                label: "ViewBox 幅", 
                input: "number", 
                value: config.viewBoxWidth,
                help: "表示範囲の幅（ズームレベルに影響）" 
              },
            },
          },
          namespaces: {
            label: "名前空間（レイヤー表示制御）",
            fields: createNamespaceFields(config.namespaces),
          },
        },
        actionHandler: (action: SettingsTreeAction) => {
          const path = action.payload.path.join(".");
          switch (action.action) {
            case "update":
              if (path == "topics.aggregatedTopic") {
                setConfig((prevConfig) => ({ ...prevConfig, aggregatedTopic: action.payload.value as string }));
              } else if (path == "topics.updateTopic") {
                setConfig((prevConfig) => ({ ...prevConfig, updateTopic: action.payload.value as string }));
              } else if (path == "topics.enableUpdateTopic") {
                setConfig((prevConfig) => ({ ...prevConfig, enableUpdateTopic: action.payload.value as boolean }));
              } else if (path == "display.renderMode") {
                setConfig((prevConfig) => ({ ...prevConfig, renderMode: action.payload.value as PanelConfig["renderMode"] }));
              } else if (path == "performance.maxHistoryDuration") {
                setConfig((prevConfig) => ({ ...prevConfig, maxHistoryDuration: action.payload.value as number }));
              } else if (path == "performance.maxHistorySize") {
                setConfig((prevConfig) => ({ ...prevConfig, maxHistorySize: action.payload.value as number }));
              } else if (path == "display.backgroundColor") {
                setConfig((prevConfig) => ({ ...prevConfig, backgroundColor: action.payload.value as string }));
              } else if (path == "display.viewBoxWidth") {
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
  }, [context, config]);

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
      const nowMs = performance.now();
      if (perfRef.current.frameStartMs > 0) {
        pushSample(perfRef.current.intervals, nowMs - perfRef.current.frameStartMs);
      }
      perfRef.current.frameStartMs = nowMs;

      setRenderDone(() => done);
      setMessages(renderState.currentFrame);
      setTopics(renderState.topics);
      
      // 現在時刻の更新を検出
      if (renderState.currentTime !== undefined) {
        const newCurrentTime = renderState.currentTime.sec * 1000 + renderState.currentTime.nsec / 1000000;
        setSeekTime(newCurrentTime);
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
    context.watch("currentTime");

    context.advertise?.(INTERACTION_TOPIC, "/input_event");
  }, [context]);

  // 受信メッセージを履歴に積み、ライブ表示用のレイヤー状態へ差分を適用する。
  //
  // **毎フレーム履歴から組み直さないこと。** スナップショットは 1Hz なので、
  // 組み直すと1秒分（約 40 件）の差分を毎フレーム再適用することになり、
  // パネルの表示レートが 2Hz 程度まで落ちる。
  // 届いたメッセージを順に適用すれば O(変化したレイヤー) で済む。
  useEffect(() => {
    if (!messages || messages.length === 0) return;

    // まず履歴に積む（シーク時の組み直しに使う）
    let rewound = false;
    let newestTimestamp = -1;
    for (const message of messages) {
      const timestamp = message.receiveTime.sec * 1000 + message.receiveTime.nsec / 1000000;
      if (timestamp < lastAppliedTimeRef.current - SEEK_BACKWARD_THRESHOLD_MS) rewound = true;
      if (timestamp > newestTimestamp) newestTimestamp = timestamp;

      if (message.topic === config.aggregatedTopic) {
        aggregatedMessagesRef.current.set(timestamp, message);
      } else if (config.enableUpdateTopic && message.topic === config.updateTopic) {
        const existing = updateMessagesRef.current.get(timestamp);
        if (existing) existing.push(message);
        else updateMessagesRef.current.set(timestamp, [message]);
      }
    }

    if (rewound) {
      // シークで時刻が巻き戻った。差分の積み上げは当てにならないので履歴から組み直す。
      // 組み直せなかったら今の絵を残したまま次のスナップショットを待つ
      if (!replaceLayersIfNotEmpty(liveLayersRef, composeMessagesAtTime(newestTimestamp))) {
        recomposeFailureRef.current += 1;
      }
    } else {
      for (const message of messages) {
        if (message.topic === config.aggregatedTopic) {
          const msg = normalizeSnapshot(message.message);
          if (msg) {
            setLatestMsg(msg);
            // スナップショットはレイヤー全体の置き換え
            liveLayersRef.current = new Map(
              msg.svg_primitive_arrays.map((array) => [array.layer, array])
            );
          }
        } else if (config.enableUpdateTopic && message.topic === config.updateTopic) {
          const updateArray = normalizeUpdates(message.message);
          if (updateArray) applyUpdates(liveLayersRef.current, updateArray);
        }
      }
    }

    lastAppliedTimeRef.current = newestTimestamp;
    setRecvNum((prev) => prev + messages.length);

    // 描画コストの内訳（診断用）。非表示レイヤーも DOM は作られるので、
    // 総数と表示中の数を分けて出す
    let primitives = 0;
    let visiblePrimitives = 0;
    for (const array of liveLayersRef.current.values()) {
      primitives += array.svg_primitives.length;
      if (namespacesRef.current[array.layer]?.visible) {
        visiblePrimitives += array.svg_primitives.length;
      }
    }
    perfRef.current.primitives = primitives;
    perfRef.current.visiblePrimitives = visiblePrimitives;

    setCurrentDisplayMsg({ svg_primitive_arrays: Array.from(liveLayersRef.current.values()) });
  }, [messages, config.aggregatedTopic, config.updateTopic, config.enableUpdateTopic,
      composeMessagesAtTime]);

  // シークで再生時刻が巻き戻ったときだけ履歴から組み直す。
  // 一時停止中のシークはメッセージが届かないので、上のエフェクトでは拾えない。
  // 前進方向は届いたメッセージを順に適用すれば足り、取りこぼしても
  // 次のスナップショット（1秒以内）で必ず整合する
  useEffect(() => {
    if (seekTime === undefined) return;
    const previousSeekTime = lastSeekTimeRef.current;
    lastSeekTimeRef.current = seekTime;
    if (previousSeekTime === undefined) return;
    // 判定は currentTime 同士で行う。receiveTime と比べると別の時計を突き合わせることになる
    if (seekTime >= previousSeekTime - SEEK_BACKWARD_THRESHOLD_MS) return;

    const composed = composeMessagesAtTime(seekTime);
    if (!replaceLayersIfNotEmpty(liveLayersRef, composed)) {
      recomposeFailureRef.current += 1;
      return;  // 組み直せなかった。今の絵を残す
    }
    // **ここに seekTime（再生時刻）を入れないこと。**
    // lastAppliedTimeRef はメッセージ側の時計（receiveTime）で統一する。
    // -1 は「シーク後まだ何も適用していない」の意味で、次に届いたメッセージが
    // 巻き戻し扱いされずにこの組み直し結果へ積み上がる
    lastAppliedTimeRef.current = -1;
    setCurrentDisplayMsg({ svg_primitive_arrays: Array.from(liveLayersRef.current.values()) });
  }, [seekTime, composeMessagesAtTime]);

  useEffect(() => {
    if (renderDone && perfRef.current.frameStartMs > 0) {
      const commitEndMs = performance.now();
      perfRef.current.commitEndMs = commitEndMs;
      pushSample(perfRef.current.durations, commitEndMs - perfRef.current.frameStartMs);
      perfRef.current.domNodes = svgRef.current?.getElementsByTagName("*").length ?? 0;

      // 次のアニメーションフレームまで＝ブラウザがこのコミットを
      // レイアウト・描画し終えて戻ってくるまで。React のコミット時間には含まれない
      const startMs = perfRef.current.frameStartMs;
      requestAnimationFrame(() => pushSample(perfRef.current.frames, performance.now() - startMs));
    }
    renderDone?.();
  }, [renderDone]);

  // currentDisplayMsg に含まれる新規レイヤーを namespaces に反映
  //
  // **新しいレイヤーが無いフレームでは prevConfig をそのまま返すこと。**
  // 毎回新しいオブジェクトを返すと config が毎フレーム変化し、
  // context.saveState() が毎フレーム走って描画が止まる。
  useEffect(() => {
    if (!currentDisplayMsg) return;
    setConfig((prevConfig) => {
      let added = false;
      const newNamespaces = { ...prevConfig.namespaces };
      currentDisplayMsg.svg_primitive_arrays.forEach((svg_primitive_array) => {
        if (!newNamespaces[svg_primitive_array.layer]) {
          const defaultVisibility = svg_primitive_array.config?.visible_by_default ?? true;
          newNamespaces[svg_primitive_array.layer] = { visible: defaultVisibility };
          added = true;
        }
      });
      return added ? { ...prevConfig, namespaces: newNamespaces } : prevConfig;
    });
  }, [currentDisplayMsg]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
        <div>
          <p>Aggregated Topic: {config.aggregatedTopic}</p>
          {config.enableUpdateTopic && <p>Update Topic: {config.updateTopic}</p>}
        </div>
        <div>
          <p>Receive num: {recv_num}</p>
          <p>History: Aggregated({aggregatedMessagesRef.current.size}), Updates({updateMessagesRef.current.size}), Recompose failures: {recomposeFailureRef.current}</p>
          <p>
            Panel: {(() => { const i = average(perfRef.current.intervals); return i > 0 ? (1000 / i).toFixed(1) : "-"; })()} fps
            {" / interval "}{average(perfRef.current.intervals).toFixed(1)} ms
            {" = react "}{average(perfRef.current.durations).toFixed(1)}
            {" + paint "}{Math.max(0, average(perfRef.current.frames) - average(perfRef.current.durations)).toFixed(1)}
            {" + wait "}{Math.max(0, average(perfRef.current.intervals) - average(perfRef.current.frames)).toFixed(1)} ms
          </p>
          <p>
            primitives {perfRef.current.visiblePrimitives} 表示 / {perfRef.current.primitives} 総数
            {" / DOM "}{perfRef.current.domNodes} ノード
          </p>
          {seekTime !== undefined && <p>Seek Time: {new Date(seekTime).toISOString()}</p>}
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
          {(() => {
            // 更新トピック有効時は合成結果を優先（シーク有無に関わらず）
            const displayMsg = config.enableUpdateTopic
              ? (currentDisplayMsg ?? latest_msg)
              : latest_msg;

            // 描画モードは遅さの切り分け用。既定（normal）は従来どおり全レイヤーを描く
            if (config.renderMode === "off") return null;

            const arrays = config.renderMode === "visible-only"
              ? displayMsg?.svg_primitive_arrays.filter(
                  (array) => config.namespaces[array.layer]?.visible)
              : displayMsg?.svg_primitive_arrays;

            return arrays?.map((svg_primitive_array) => (
              <g key={svg_primitive_array.layer} style={{ display: config.namespaces[svg_primitive_array.layer]?.visible ? 'block' : 'none' }}>
                {svg_primitive_array.svg_primitives.map((svg_primitive, svgIndex) => (
                  <g key={svgIndex} dangerouslySetInnerHTML={{ __html: svg_primitive }} />
                ))}
              </g>
            ));
          })()}
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
