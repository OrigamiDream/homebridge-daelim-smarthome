import {LoggerBase} from "../core/utils";

export default class ServerLogger implements LoggerBase {

    debug(message: string, ...parameters: any[]): void {
        console.debug(message, ...parameters);
    }

    error(message: string, ...parameters: any[]): void {
        console.error(message, ...parameters);
    }

    info(message: string, ...parameters: any[]): void {
        console.info(message, ...parameters);
    }

    warn(message: string, ...parameters: any[]): void {
        console.warn(message, ...parameters);
    }
}