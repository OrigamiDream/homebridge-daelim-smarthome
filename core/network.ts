import net from "net";
import {Client} from "./client";
import {Chunk} from "./chunk";
import {Packet} from "./packet";
import {Errors, SubTypes, Types} from "./fields";
import {Complex} from "./interfaces/complex";

export type ResponseCallback = (body: any) => void;
export type ErrorCallback = () => void;

export interface LoggerBase {
    info(message: string, ...parameters: any[]): void;
    warn(message: string, ...parameters: any[]): void;
    error(message: string, ...parameters: any[]): void;
    debug(message: string, ...parameters: any[]): void;
}

interface ResponseListener {

    type: Types,
    subType: SubTypes,
    callback: ResponseCallback

}

interface ErrorListener {

    error: Errors,
    callback: ErrorCallback

}

interface DeferredRequest {
    resolve: (value?: any | PromiseLike<any>) => void,
    reject: (reason?: any) => void,

    type: Types,
    fromSubTypes: SubTypes,
    toSubTypes: SubTypes,
    matches?: (response: any) => boolean

    timestamp: number,
    body: any
}

interface EnqueuedRequest {

    body: any,
    type: Types,
    subType: SubTypes

}

export class NetworkHandler {

    private socket?: net.Socket;
    private readBuffers = new ArrayBuffer(0);
    private isConnected = false;

    private readonly log: LoggerBase;
    private readonly complex: Complex;

    private readonly listeners: ResponseListener[] = [];
    private readonly errorListeners: ErrorListener[] = [];

    private readonly deferredRequests: DeferredRequest[] = [];
    private readonly enqueuedRequests: EnqueuedRequest[] = [];

    public onConnected?: () => void;
    public onDisconnected?: () => void;

    constructor(log: LoggerBase, complex: Complex) {
        this.log = log;
        this.complex = complex;
    }

    registerResponseListener(type: Types, subType: SubTypes, callback: ResponseCallback) {
        this.listeners.push({
            type: type,
            subType: subType,
            callback: callback
        });
    }

    registerErrorListener(error: Errors, callback: ErrorCallback) {
        this.errorListeners.push({
            error: error,
            callback: callback
        });
    }

    sendUnreliableRequest(body: object, pin: string, type: Types, subType: SubTypes): boolean {
        if(!this.isConnected || !this.socket) {
            return false;
        }
        const deepcopy = JSON.parse(JSON.stringify(body));
        if("pw" in deepcopy) {
            deepcopy["pw"] = "********";
        }
        this.log.debug(`===> ${JSON.stringify(deepcopy)}`);
        return this.socket?.write(Buffer.from(Packet.create(body, pin, type, subType, 1, 3).getBytes()));
    }

    sendDeferredRequest(body: any, pin: string, type: Types, fromSubType: SubTypes, toSubType: SubTypes, matches?: (response: any) => boolean): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.sendUnreliableRequest(body, pin, type, fromSubType);
            this.deferredRequests.push({
                resolve: resolve,
                reject: reject,
                type: type,
                fromSubTypes: fromSubType,
                toSubTypes: toSubType,
                matches: matches,
                timestamp: Date.now(),
                body: body
            });
        });
    }

    flushAllEnqueuedBuffers(pin: string): boolean {
        if(!this.isConnected || this.enqueuedRequests.length === 0) {
            return false;
        }
        while(this.enqueuedRequests.length > 0) {
            const requests = this.enqueuedRequests.splice(0, 1);
            for(const request of requests) {
                this.sendUnreliableRequest(request.body, pin, request.type, request.subType)
            }
        }
        return true;
    }

    disconnect() {
        if(this.socket) {
            this.socket.destroy();
            this.socket = undefined;
        }
    }

    handle() {
        this.disconnect();
        this.socket = net.connect({
            host: this.complex.serverIp,
            port: Client.MMF_SERVER_PORT
        });
        this.socket.on('connect', () => {
            this.isConnected = true;
            this.log.info('Connected to server');

            if(this.onConnected !== undefined) {
                this.onConnected();
            }
        });
        this.socket.on('data', async (data) => {
            this.appendBuffer(data);
            do {
            } while(await this.handleResponse());
        });
        this.socket.on('end', () => {
            this.log.info('Disconnected from MMF server');
            this.handleDisconnect();
        });
        this.socket.on('error', (error) => {
            this.log.error(`Unexpected behavior: ${error.message}`);
            this.handleDisconnect();
        });
        this.socket.on('timeout', () => {
            this.log.error('Connection timed out');
            this.handleDisconnect();
        });
    }

    private handleDisconnect() {
        this.isConnected = false;
        this.socket = undefined;

        // NOTE: move deferred requests into enqueued request array
        //       but don't empty deferred requests. this will be executed after reconnection
        for(const request of this.deferredRequests) {
            this.enqueuedRequests.push({
                body: request.body,
                type: request.type,
                subType: request.fromSubTypes
            });
        }

        if(this.onDisconnected !== undefined) {
            this.onDisconnected();
        }
    }

    private appendBuffer(bytes: Uint8Array | Buffer, offset = 0, length = bytes.byteLength) {
        const temp = new Uint8Array(this.readBuffers.byteLength + length);
        temp.set(new Uint8Array(this.readBuffers), 0);
        temp.set(new Uint8Array(bytes.slice(offset, length + offset)), this.readBuffers.byteLength);
        this.readBuffers = temp.buffer;
    }

    private async handleResponse(): Promise<boolean> {
        const rawData = new Uint8Array(this.readBuffers);
        const chunk = Chunk.parse(rawData);
        if(chunk === undefined) {
            return false;
        }
        const packet = Packet.parse(rawData);
        this.readBuffers = new ArrayBuffer(0);
        const chunkSize = chunk.getSize();
        if(rawData.byteLength > chunkSize) {
            this.appendBuffer(rawData, chunkSize, rawData.byteLength - chunkSize);
        }
        if(packet !== undefined) {
            const header = packet.getHeader();
            this.log.debug(`<=== HEAD(${header.toString()}) :: ${JSON.stringify(packet.getJSONBody())}`);
            if(header.getError() === Errors.SUCCESS) {
                if(this.deferredRequests.length > 0) {
                    let timedOut = 0;
                    let index = 0;
                    while(index < this.deferredRequests.length) {
                        const request = this.deferredRequests[index];
                        if(Date.now() - request.timestamp > 1000 * 10) {
                            // 10 seconds timeout
                            timedOut++;
                            request.resolve({ item: [] });
                            this.deferredRequests.splice(index, 1);
                            continue;
                        }

                        const response = packet.getJSONBody();
                        if(request.type === header.getType() && request.toSubTypes === header.getSubType() && (!request.matches || request.matches(response))) {
                            request.resolve(response);
                            this.deferredRequests.splice(index, 1);
                            continue;
                        }
                        index++;
                    }
                    if(timedOut > 0) {
                        this.log.debug('%d deferred requests have timed out for 10+ seconds', timedOut);
                    }
                }
                for(const listener of this.listeners) {
                    if(listener.type === header.getType() && listener.subType == header.getSubType()) {
                        await listener.callback(packet.getJSONBody());
                    }
                }
            } else {
                let found = false;
                for(const listener of this.errorListeners) {
                    if(listener.error === header.getError()) {
                        await listener.callback();
                        found = true;
                    }
                }
                if(!found) {
                    this.log.warn("Unexpected error type has been responded:", header.getError());
                }
            }
        }
        return true;
    }

}