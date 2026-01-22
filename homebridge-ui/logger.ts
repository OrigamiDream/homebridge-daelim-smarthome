import {LoggerBase} from "../core/utils";

const ServerLogger: LoggerBase = Object.assign(
    (message: string, ...parameters: any[]) => {
        console.info(message, ...parameters);
    },
    {
        debug(message: string, ...parameters: any[]): void {
            console.debug(message, ...parameters);
        },
        error(message: string, ...parameters: any[]): void {
            console.error(message, ...parameters);
        },
        info(message: string, ...parameters: any[]): void {
            console.info(message, ...parameters);
        },
        warn(message: string, ...parameters: any[]): void {
            console.warn(message, ...parameters);
        },
    }
);

export default ServerLogger;
