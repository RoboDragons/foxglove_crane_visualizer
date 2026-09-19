/**
 * 設定パネルが Foxglove とやり取りする部分。
 *
 * <p>パネル本体から切り出した。本体が接続・ファイル操作・ステータス表示・列幅・木の描画を
 * 全部抱えて 500 行を超え、どこで何をしているのか見通せなくなっていたため。
 * ここには描画を置かない。
 */

import {
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  ParameterValue,
  Subscription,
} from "@foxglove/studio";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ConfigNode, normalizeLayout } from "./config_tree";

/** サーバー状態のトピック。未保存かどうかと書き込み許可を読む */
const STATUS_TOPIC = "/server_status";
const SVC_LIST = "/config/list";
/** ステータス行を残す時間[ms]。エラーは消さない */
const STATUS_FADE_MS = 6000;
/** 同時に出すステータス行の上限。連打したときに何件目の応答かが分かればよい */
const MAX_STATUS_ROWS = 3;

// ---------------------------------------------------------------------------
// 応答の読み取り
// ---------------------------------------------------------------------------

export function isFailure(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response != undefined &&
    (response as Record<string, unknown>)["success"] === false
  );
}

function messageOf(response: unknown): string {
  if (typeof response !== "object" || response == undefined) {
    return "";
  }
  const message = (response as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : "";
}

function filesOf(response: unknown): string[] {
  if (typeof response !== "object" || response == undefined) {
    return [];
  }
  const files = (response as Record<string, unknown>)["files"];
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/** `/server_status` のうち設定パネルが使う3つ */
export interface ServerStatus {
  configName: string;
  dirty: boolean;
  allowControl: boolean;
}

function normalizeStatus(message: unknown): ServerStatus | undefined {
  if (typeof message !== "object" || message == undefined) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  // proto3 の既定値は省略されて届くので、欠けていれば偽として扱う。
  // allow_control だけは「届いていない = 不明」なので許可側に倒す。
  // 禁止側に倒すと、古いサーバーに繋いだときに全部の入力欄が死ぬ
  const name = record["configName"] ?? record["config_name"];
  const dirty = record["configDirty"] ?? record["config_dirty"];
  const allow = record["allowControl"] ?? record["allow_control"];
  return {
    configName: typeof name === "string" ? name : "",
    dirty: dirty === true,
    allowControl: allow !== false,
  };
}

// ---------------------------------------------------------------------------
// 受信
// ---------------------------------------------------------------------------

/**
 * config ツリーの記述・現在値・サーバー状態を受け取る。
 *
 * @param topic 記述を受け取るトピック（既定は `/config_layout`）
 */
export function useConfigStream(
  context: PanelExtensionContext,
  topic: string,
): {
  nodes: ConfigNode[] | undefined;
  parameters: undefined | Immutable<Map<string, ParameterValue>>;
  serverStatus: ServerStatus | undefined;
} {
  const [nodes, setNodes] = useState<ConfigNode[] | undefined>();
  const [parameters, setParameters] = useState<
    undefined | Immutable<Map<string, ParameterValue>>
  >();
  const [serverStatus, setServerStatus] = useState<ServerStatus | undefined>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setParameters(renderState.parameters);

      const frame = renderState.currentFrame;
      if (!frame) {
        return;
      }
      for (let i = frame.length - 1; i >= 0; i--) {
        const event = frame[i] as Immutable<MessageEvent> | undefined;
        if (!event) {
          continue;
        }
        if (event.topic === STATUS_TOPIC) {
          const next = normalizeStatus(event.message);
          if (next) {
            setServerStatus(next);
          }
          continue;
        }
        const layout = normalizeLayout(event.message);
        if (layout && layout.length > 0) {
          setNodes(layout);
        }
      }
    };
    context.watch("currentFrame");
    context.watch("parameters");
  }, [context]);

  useEffect(() => {
    const subscriptions: Subscription[] = [{ topic }, { topic: STATUS_TOPIC }];
    context.subscribe(subscriptions);
  }, [context, topic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return { nodes, parameters, serverStatus };
}

// ---------------------------------------------------------------------------
// ステータス行
// ---------------------------------------------------------------------------

export type StatusKind = "info" | "error" | "pending";

export interface Status {
  id: number;
  kind: StatusKind;
  text: string;
  expiresAt?: number;
}

/**
 * 画面上部に出す短い知らせ。成功と呼び出し中は時間で消え、エラーは残る。
 *
 * <p>直近の数件を新しい順に持つ。1件だけだと、連打したときに
 * 成功がエラーを上書きして失敗に気づけない。
 */
export function useStatusMessages(): {
  statuses: Status[];
  pushStatus: (kind: StatusKind, text: string) => void;
} {
  const [statuses, setStatuses] = useState<Status[]>([]);
  const nextId = useRef(1);

  const pushStatus = useCallback((kind: StatusKind, text: string) => {
    const id = nextId.current++;
    const expiresAt = kind === "error" ? undefined : Date.now() + STATUS_FADE_MS;
    setStatuses((prev) => [{ id, kind, text, expiresAt }, ...prev].slice(0, MAX_STATUS_ROWS));
  }, []);

  useEffect(() => {
    const soonest = statuses.reduce<number | undefined>(
      (min, s) => (s.expiresAt == undefined ? min : Math.min(min ?? s.expiresAt, s.expiresAt)),
      undefined,
    );
    if (soonest == undefined) {
      return;
    }
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setStatuses((prev) => {
          const kept = prev.filter((s) => s.expiresAt == undefined || s.expiresAt > now);
          return kept.length === prev.length ? prev : kept;
        });
      },
      Math.max(0, soonest - Date.now()) + 20,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [statuses]);

  return { statuses, pushStatus };
}

// ---------------------------------------------------------------------------
// サービス呼び出し
// ---------------------------------------------------------------------------

export type CallService = (
  service: string,
  request: unknown,
  onDone?: (response: unknown) => void,
) => void;

/**
 * サービスを呼び、結果をステータス行に出す。
 *
 * <p>呼び出し自体が成功しても、応答が `success: false` を返すことがある。
 * その場合もエラーとして出す。
 */
export function useServiceCaller(
  context: PanelExtensionContext,
  pushStatus: (kind: StatusKind, text: string) => void,
): CallService {
  return useCallback(
    (service, request, onDone) => {
      const call = context.callService;
      if (!call) {
        pushStatus("error", "この接続はサービス呼び出しに対応していません");
        return;
      }
      pushStatus("pending", `${service} を呼び出し中…`);
      call(service, request).then(
        (response: unknown) => {
          const note = messageOf(response);
          pushStatus(
            isFailure(response) ? "error" : "info",
            `${service}: ${note.length > 0 ? note : "OK"}`,
          );
          onDone?.(response);
        },
        (error: unknown) => {
          pushStatus("error", `${service}: ${String(error)}`);
        },
      );
    },
    [context, pushStatus],
  );
}

/**
 * 読み込める設定ファイルの一覧。
 *
 * <p>ステータス行には出さない。開くたびに「呼び出し中」が流れるとうるさく、
 * 取れなくても他の操作は続けられる。
 */
export function useConfigFiles(context: PanelExtensionContext): {
  files: string[];
  refresh: () => void;
} {
  const [files, setFiles] = useState<string[]>([]);

  const refresh = useCallback(() => {
    context.callService?.(SVC_LIST, {}).then(
      (response: unknown) => {
        setFiles(filesOf(response));
      },
      () => {
        // 一覧が取れなくても黙って諦める
      },
    );
  }, [context]);

  useEffect(refresh, [refresh]);

  return { files, refresh };
}
