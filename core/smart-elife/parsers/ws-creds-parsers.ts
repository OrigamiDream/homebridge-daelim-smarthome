import {findJsStringProp} from "./string-utils";

export type WebSocketCredentials = { roomKey: string, userKey: string, accessToken: string };

export function parseWebSocketCredentials(html: string): WebSocketCredentials {
    const roomKey = findJsStringProp(html, "roomKey");
    const userKey = findJsStringProp(html, "userKey");
    const accessToken = findJsStringProp(html, "accessToken");

    if(!roomKey) throw new Error("`roomKey` not found");
    if(!userKey) throw new Error("`userKey` not found");
    if(!accessToken) throw new Error("`accessToken not found");

    return { roomKey, userKey, accessToken };
}
