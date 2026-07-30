/**
 * Which operation modes a vent supports is not exposed by any JSON endpoint. The
 * control page renders one button per supported mode, but only when the request
 * identifies the device: `POST /controls/vent.do` with the `uid` of the vent renders
 * the buttons, while a request without it renders none at all.
 *
 * Each button looks like this, and carries both the protocol value and the label the
 * native app shows for it. Read off the real page on 2026-07-30:
 *
 *     <button type="button"
 *         class="btn btn-round-big btn-round btn-secondary mode_btn"
 *         data-val="bypass">
 *         <span>바이패스</span>
 *     </button>
 *
 * Whether the page is about the vent that was asked for is not decided here. The client
 * holds the page against the requested `uid` before this parser sees it, the same way it
 * holds `/main/home.do` against the configuration, so one judgement covers everything
 * read from the same fetch.
 */

export interface VentMode {
    /** The value sent back as `operation.mode`, e.g. `bypass`. */
    value: string
    /** The label the native app puts on the button, e.g. `바이패스`. */
    label: string
}

// Whole tags, so the attributes inside can be read in any order. The template puts `type`
// before `class` before `data-val` today, each on its own line, and neither the order nor
// the whitespace is anything this should depend on.
const BUTTON = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
const CLASS_ATTR = /\bclass\s*=\s*["']([^"']*)["']/i;
const DATA_VAL_ATTR = /\bdata-val\s*=\s*["']([^"']*)["']/i;
const MODE_BUTTON_CLASS = "mode_btn";
const TAGS = /<[^>]*>/g;

function isModeButton(attributes: string): boolean {
    const match = CLASS_ATTR.exec(attributes);
    // Against the class list rather than the whole attribute string, so that a longer
    // class such as `mode_btn_label` or an unrelated attribute carrying the word does
    // not read as one of these buttons.
    return !!match && match[1].split(/\s+/).indexOf(MODE_BUTTON_CLASS) !== -1;
}

/**
 * Returns the modes the vent supports, or `null` when the page could not be read.
 *
 * `null` covers a page that renders no mode buttons as well as one whose buttons could not
 * be read whole. Neither can be told apart from a page the server rendered without knowing
 * which device was meant, and the caller must treat it as "unknown" rather than "none":
 * this result is what decides whether a mode switch is taken off an accessory.
 *
 * There is deliberately no "this vent has no modes" answer. It would be indistinguishable
 * from a page that failed, and a vent with no modes needs no mode controls either way -
 * which is what an unknown result already produces.
 */
export function parseVentModes(html: string): VentMode[] | null {
    if(!html) {
        return null;
    }
    const modes: VentMode[] = [];
    const seen = new Set<string>();
    let buttons = 0;
    let read = 0;
    // `BUTTON` is global, so its `lastIndex` has to start clean on every call.
    BUTTON.lastIndex = 0;
    let match;
    while((match = BUTTON.exec(html)) !== null) {
        if(!isModeButton(match[1])) {
            continue;
        }
        buttons += 1;
        const value = (DATA_VAL_ATTR.exec(match[1])?.[1] || "").trim();
        const label = match[2].replace(TAGS, " ").replace(/\s+/g, " ").trim();
        if(!value || !label) {
            continue;
        }
        // Counted as read before the duplicate check: a page that renders one mode twice
        // is still a page this understood.
        read += 1;
        if(seen.has(value)) {
            continue;
        }
        seen.add(value);
        modes.push({ value, label });
    }
    // A page that rendered buttons this could not read is a page whose markup has moved,
    // and a list missing those buttons would take their switches away. The buttons are
    // counted as tags rather than as occurrences of the class name for the same reason:
    // the page's own JavaScript names `mode_btn` six times, so counting strings would
    // make every complete page look partial.
    if(buttons === 0 || read !== buttons) {
        return null;
    }
    return modes;
}
