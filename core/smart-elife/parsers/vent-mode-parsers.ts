/**
 * Which operation modes a vent supports is not exposed by any JSON endpoint. The
 * control page renders one button per supported mode, but only when the request
 * identifies the device: `POST /controls/vent.do` with the `uid` of the vent renders
 * the buttons, while a request without it renders the section empty.
 *
 * Each button looks like this, and carries both the protocol value and the label the
 * native app shows for it:
 *
 *     <button type="button"
 *         class="btn btn-round-big btn-round btn-secondary mode_btn"
 *         data-val="bypass">
 *         <span>바이패스</span>
 *     </button>
 */

export interface VentMode {
    /** The value sent back as `operation.mode`, e.g. `bypass`. */
    value: string
    /** The label the native app puts on the button, e.g. `바이패스`. */
    label: string
}

// The page always renders the wind speed controls, whether or not it knows the device,
// so their presence is what tells a vent control page apart from an error or a login
// redirect. Without this an unrelated page would parse as "this vent has no modes".
const VENT_PAGE_MARKER = "wind_speed_btn";

// Attribute order is fixed by the template, but the whitespace around it is not.
const MODE_BUTTON = /class="[^"]*\bmode_btn\b[^"]*"\s*data-val="([^"]+)"\s*>\s*<span>([^<]*)<\/span>/g;

/**
 * Returns the modes the vent supports, an empty array when the device is known to have
 * none, or `null` when the page could not be recognised at all. A caller must treat
 * `null` as "unknown" rather than "none": the mode section is also empty when the
 * request failed to identify the device.
 */
export function parseVentModes(html: string): VentMode[] | null {
    if (!html || html.indexOf(VENT_PAGE_MARKER) === -1) {
        return null;
    }
    const modes: VentMode[] = [];
    const seen = new Set<string>();
    // `MODE_BUTTON` is global, so its `lastIndex` has to start clean on every call.
    MODE_BUTTON.lastIndex = 0;
    let match;
    while ((match = MODE_BUTTON.exec(html)) !== null) {
        const value = match[1].trim();
        const label = match[2].trim();
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        modes.push({ value, label });
    }
    return modes;
}
