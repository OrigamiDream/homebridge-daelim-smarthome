import WebSocket from "ws";
import {LoggerBase, Utils} from "../utils";
import {ClientResponseCode} from "./responses";
import {Logging} from "homebridge";
import SmartELifeClient from "./smart-elife-client";

export interface WebSocketInjector {
    getJSessionId(client: SmartELifeClient): string | undefined;
    onRefresh(client: SmartELifeClient): Promise<ClientResponseCode>;
    onResilient(client: SmartELifeClient): Promise<ClientResponseCode>;
    onOpen(client: SmartELifeClient): Promise<void>;
    onMessage(client: SmartELifeClient, json: any): void;
}

export default class WebSocketScheduler {

    private ws?: WebSocket;
    private wsReconnectTimer?: NodeJS.Timeout;
    private wsReconnectAttempt: number = 0;
    private wsConnecting: boolean = false;
    private wsClosedByUser: boolean = false;
    private wsLastAuthRefreshAtMs: number = 0;
    private wsConnectPromise?: Promise<void>;
    /** Non-JSON frames discarded on the current connection, for log rate-limiting. */
    private wsNonJsonFrames: number = 0;

    constructor(
        private readonly client: SmartELifeClient,
        private readonly baseUrl: string,
        private readonly log: Logging | LoggerBase,
        private readonly injector: WebSocketInjector) {
    }

    private getWebSocketUrl(): string {
        const url = new URL(this.baseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        // The Smart eLife web client connects to `/ws/data` on the same origin.
        url.pathname = "/ws/data";
        url.search = "";
        url.hash = "";
        return url.toString();
    }

    private getWebSocketHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "User-Agent": Utils.SMART_ELIFE_USER_AGENT,
            "Origin": this.baseUrl,
        };
        const jsessionId = this.injector.getJSessionId(this.client);
        if(jsessionId) {
            headers["Cookie"] = `JSESSIONID=${jsessionId}`;
        }
        return headers;
    }

    private clearWebSocketReconnectTimer() {
        if(this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = undefined;
        }
    }

    private isSocketClosedDuringSendError(err: unknown): boolean {
        if(!err) {
            return false;
        }
        const message = `${(err as any)?.message || err}`.toLowerCase();
        return message.includes("socket was closed")
            || message.includes("closed while data was being compressed")
            || message.includes("websocket is not open")
            || message.includes("readystate 2")
            || message.includes("readystate 3");
    }

    private scheduleWebSocketReconnect(reason: string) {
        if(this.wsClosedByUser) {
            return;
        }
        this.clearWebSocketReconnectTimer();

        const attempt = Math.min(this.wsReconnectAttempt, 6);
        const delayMs = Math.min(60_000, 1_000 * Math.pow(2, attempt));
        this.wsReconnectAttempt += 1;

        this.log.warn(`[WebSocket] reconnect scheduled in ${Math.round(delayMs / 1000)}s (${reason})`);
        this.wsReconnectTimer = setTimeout(() => {
            void this.connectWebSocket().catch((e) => {
                this.log.error(`[WebSocket] reconnect attempt failed: ${(e as any)?.message || e}`);
            });
        }, delayMs);
    }

    private static wsRawDataToString(data: WebSocket.RawData): string {
        if(Buffer.isBuffer(data)) {
            return data.toString("utf8");
        }
        if(Array.isArray(data)) {
            return Buffer.concat(data).toString("utf8");
        }
        // ArrayBuffer
        return Buffer.from(data).toString("utf8");
    }

    private static wsRawDataByteLength(data: WebSocket.RawData): number {
        if(Buffer.isBuffer(data)) {
            return data.length;
        }
        if(Array.isArray(data)) {
            return data.reduce((total, chunk) => total + chunk.length, 0);
        }
        // ArrayBuffer
        return data.byteLength;
    }

    private async waitForWebSocketOpen(ws: WebSocket, timeoutMs: number = 10_000): Promise<void> {
        if(ws.readyState === WebSocket.OPEN) {
            return;
        }
        if(ws.readyState !== WebSocket.CONNECTING) {
            throw new Error(`WebSocket is not open (readyState=${ws.readyState}).`);
        }

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => cleanup(() => reject(new Error("WebSocket open timeout."))), timeoutMs);

            const onOpen = () => cleanup(resolve);
            const onError = (err: Error) => cleanup(() => reject(err));
            const onClose = (code: number) => cleanup(() => reject(new Error(`WebSocket closed before open (code=${code}).`)));

            const cleanup = (fn: () => void) => {
                clearTimeout(timer);
                ws.off("open", onOpen);
                ws.off("error", onError);
                ws.off("close", onClose);
                fn();
            };

            ws.on("open", onOpen);
            ws.on("error", onError);
            ws.on("close", onClose);
        });
    }

    /**
     * Returns whether the socket accepted the frame. The drop paths used to be
     * silent, which left callers unable to tell a sent query from a discarded one -
     * and the status-query FIFO records an entry per sent query,
     * so a discard mistaken for a send misaligns every answer after it.
     *
     * `beforeSend` runs synchronously as the frame is handed to the socket - after any
     * reconnect this call rode through, in the same turn as the send itself. That is
     * the only moment a caller can record bookkeeping that must exist before the
     * answer can possibly arrive and must not exist if the frame is never attempted:
     * the answer to a frame can be dispatched before the frame's own send callback
     * when the event loop was busy across the round trip.
     */
    public async wsSendJson(payload: any, beforeSend?: () => void): Promise<boolean> {
        try {
            await this.connectWebSocket();
            const ws = this.ws;
            if(!ws) {
                return false;
            }
            await this.waitForWebSocketOpen(ws, 10_000);
            if(ws.readyState !== WebSocket.OPEN) {
                this.scheduleWebSocketReconnect("send while not open");
                return false;
            }

            await new Promise<void>((resolve, reject) => {
                this.log.debug(`[WebSocket] :: Send :: ${JSON.stringify(payload)}`);
                beforeSend?.();
                ws.send(JSON.stringify(payload), (err?: Error) => {
                    if(err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
            return true;
        } catch (err) {
            if(this.isSocketClosedDuringSendError(err)) {
                this.log.warn(`[WebSocket] send skipped due to socket close race: ${(err as any)?.message || err}`);
                this.scheduleWebSocketReconnect("send on closed socket");
                return false;
            }
            throw err;
        }
    }

    private async refreshAuthForWebSocket() {
        const now = Date.now();
        // Avoid hammering sign-in when server repeatedly drops the connection.
        if(now - this.wsLastAuthRefreshAtMs < 15_000) {
            return;
        }
        this.wsLastAuthRefreshAtMs = now;

        const response = await this.injector.onRefresh(this.client);
        if(response !== ClientResponseCode.SUCCESS) {
            throw new Error(`Could not re-establish authentication for WebSocket. (${response})`);
        }
    }

    private async connectWebSocket(): Promise<void> {
        if(this.ws?.readyState === WebSocket.OPEN) {
            return;
        }
        if(this.wsConnectPromise) {
            return await this.wsConnectPromise;
        }

        this.wsConnectPromise = (async () => {
            if(this.ws?.readyState === WebSocket.OPEN) {
                return;
            }
            if(this.ws?.readyState === WebSocket.CONNECTING) {
                await this.waitForWebSocketOpen(this.ws, 10_000);
                return;
            }
            if(this.wsConnecting) {
                // Another connect path is in-flight; let the promise gate handle it.
                return;
            }

            this.wsConnecting = true;
            try {
                // `serve()` is normally called after a successful sign-in, but keep this resilient.
                const response = await this.injector.onResilient(this.client);
                if(response !== ClientResponseCode.SUCCESS) {
                    this.log.warn(`[WebSocket] cannot connect (sign-in failed: ${response}).`);
                    this.scheduleWebSocketReconnect("sign-in failed");
                    throw new Error(`WebSocket sign-in failed (${response}).`);
                }

                const url = this.getWebSocketUrl();
                const headers = this.getWebSocketHeaders();

                // Close any previous instance (best-effort) before replacing. Its frames
                // must not reach handlers that now describe the new connection - a late
                // answer would consume the new FIFO's head - and its close must not
                // schedule a reconnect over the connect in progress. `error` and `open`
                // stay attached, so a late socket error cannot crash as an unhandled
                // 'error' event.
                const previous = this.ws;
                previous?.removeAllListeners("message");
                previous?.removeAllListeners("close");
                try {
                    previous?.close();
                } catch {
                    // ignore
                }

                const ws = new WebSocket(url, {
                    headers,
                    perMessageDeflate: false,
                    // Real frames are kilobytes (a type's whole device snapshot, an
                    // elevator action); the library default of 100 MiB would let one
                    // hostile or broken frame balloon into a string that size before
                    // any handler sees it. An oversized frame closes with 1009 and
                    // the reconnect path takes over.
                    maxPayload: 1024 * 1024,
                } as any);
                this.ws = ws;
                this.wsClosedByUser = false;
                this.wsNonJsonFrames = 0;

                ws.on("open", () => {
                    this.wsReconnectAttempt = 0;
                    this.log.info(`[WebSocket] connected: ${url}`);
                    void this.injector.onOpen(this.client).catch((e) => {
                        this.log.warn(`[WebSocket] post-connect initialization failed: ${(e as any)?.message || e}`);
                    });
                });

                ws.on("message", async (data: WebSocket.RawData) => {
                    const text = WebSocketScheduler.wsRawDataToString(data).trim();

                    // Mirror the HTTP retry logic: refresh auth when the server indicates login is required.
                    if(text === "accountError2" || text === "requireLoginForAjax" || /requireLogin/i.test(text)) {
                        this.log.warn("[WebSocket] server requested re-authentication; reconnecting.");
                        try {
                            await this.refreshAuthForWebSocket();
                        } catch (e) {
                            this.log.error(`[WebSocket] re-authentication failed: ${(e as any)?.message || e}`);
                        }
                        try {
                            ws.close();
                        } catch {
                            // ignore
                        }
                        return;
                    }

                    let json;
                    try {
                        json = Utils.parseJsonSafe(text);
                    } catch {
                        // This handler is async; a throw here would surface as an
                        // unhandled rejection rather than anything catchable.
                        // warn shows without debug mode, so it carries an escaped,
                        // bounded preview and fires once per connection; the full
                        // frame goes to debug like every other body this file logs,
                        // escaped so it stays one line. `maxPayload` above bounds
                        // the size either way.
                        this.wsNonJsonFrames += 1;
                        if(this.wsNonJsonFrames === 1) {
                            // Sized from the raw frame, before any decoding - a decoded
                            // string misreports trimmed whitespace and invalid UTF-8.
                            const wireBytes = WebSocketScheduler.wsRawDataByteLength(data);
                            this.log.warn(`[WebSocket] discarded a frame that is not JSON: `
                                + `${wireBytes} byte(s), ${JSON.stringify(text.slice(0, 160))}`);
                        }
                        this.log.debug(`[WebSocket] discarded a frame that is not JSON `
                            + `(${this.wsNonJsonFrames} so far): ${JSON.stringify(text)}`);
                        return;
                    }
                    this.log.debug(`[WebSocket] message (JSON): ${JSON.stringify(json)}`);
                    this.injector.onMessage(this.client, json);
                });

                ws.on("close", (code: number, reason: Buffer) => {
                    const reasonText = reason?.toString("utf8") || "";
                    this.log.warn(`[WebSocket] closed (code=${code}${reasonText ? `, reason=${reasonText}` : ""})`);
                    if(this.ws === ws) {
                        this.ws = undefined;
                    }
                    if(!this.wsClosedByUser) {
                        this.scheduleWebSocketReconnect(`closed:${code}`);
                    }
                });

                ws.on("error", (err: Error) => {
                    this.log.warn(`[WebSocket] error: ${err?.message || err}`);
                });

                ws.on("unexpected-response", async (_req, res) => {
                    const statusCode = (res as any)?.statusCode;
                    this.log.warn(`[WebSocket] unexpected response (status=${statusCode ?? "unknown"}).`);
                    if(statusCode === 401 || statusCode === 403) {
                        try {
                            await this.refreshAuthForWebSocket();
                        } catch (e) {
                            this.log.error(`[WebSocket] re-authentication failed after unexpected response: ${(e as any)?.message || e}`);
                        }
                    }
                });

                await this.waitForWebSocketOpen(ws, 10_000);
            } finally {
                this.wsConnecting = false;
            }
        })().finally(() => {
            this.wsConnectPromise = undefined;
        });

        return await this.wsConnectPromise;
    }

    public async serve() {
        // Keep WebSocket alive in the background. On auth/session expiry, this reconnects after re-sign-in.
        try {
            await this.connectWebSocket();
        } catch (e) {
            this.log.error(`[WebSocket] initial connect failed: ${(e as any)?.message || e}`);
            this.scheduleWebSocketReconnect("initial connect failed");
        }
    }
}
