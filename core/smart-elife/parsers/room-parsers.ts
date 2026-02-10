import {findJsStringProp} from "./string-utils";

export type WsKeys = { roomKey: string, userKey: string };

export function parseRoomAndUserKey(html: string): WsKeys {
    const roomKey = findJsStringProp(html, "roomKey");
    const userKey = findJsStringProp(html, "userKey");
    if(!roomKey) throw new Error("`roomKey` not found");
    if(!userKey) throw new Error("`userKey` not found");
    return { roomKey, userKey };
}
