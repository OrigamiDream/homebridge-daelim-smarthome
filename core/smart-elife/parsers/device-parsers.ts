import {tryParseAssignmentAt} from "./string-utils";

export function parseDeviceList(html: string) {
    let from = 0;
    while (true) {
        const idx = html.indexOf("_deviceListByType", from);
        if (idx === -1) return null;
        from = idx + "_deviceListByType".length;

        // Try to parse an assignment near this occurrence.
        const parsed = tryParseAssignmentAt(html, from);
        if (parsed) {
            try {
                return JSON.parse(parsed.jsonText);
            } catch {
                // keep scanning; there can be multiple occurrences
            }
        }
    }
}
