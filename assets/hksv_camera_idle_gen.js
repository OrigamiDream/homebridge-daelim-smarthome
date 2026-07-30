const {createCanvas} = require("canvas");
const fs = require("fs");

const WIDTH = 1280;
const HEIGHT = 720;
const FONT_SIZE = 50;
const LINE_HEIGHT = 1.45;
// Leave a margin so a long line never runs into the edge of the frame.
const MAX_LINE_WIDTH = WIDTH * 0.86;

// The frames a camera shows when it has no picture of its own.
// Each states what is true at the moment it appears rather than what may follow,
// because nothing here can promise an image that is not already in hand.
//
// There is deliberately no frame for a call in progress. The Home app fetches a
// snapshot when the tile is opened and does not ask again while the stream is
// being set up, so a frame saying the door station is being called could only
// ever be chosen before the call began - and would therefore also be showing
// every time no call was being placed at all.
//
// Nor is there one for a door station that did not answer. Only a camera with a
// live view can fail that way, and there the stream itself fails, which leaves
// the Home app to report it in its own words rather than having a frame here
// name a cause this end cannot always be sure of.
const IDLE_IMAGES = [
    {
        // Nothing stored, and nothing being waited on beyond the next visitor.
        filepath: "./assets/hksv_camera_idle.png",
        lines: ["최근 방문자 없음"]
    }
];

// The wording is free to change, so measure rather than assume it fits.
function fittingFontSize(ctx, lines) {
    let size = FONT_SIZE;
    while(size > 20) {
        ctx.font = `600 ${size}px SF Pro`;
        if(lines.every((line) => ctx.measureText(line).width <= MAX_LINE_WIDTH)) {
            break;
        }
        size -= 2;
    }
    return size;
}

function draw({filepath, lines}) {
    return new Promise((resolve) => {
        const canvas = createCanvas(WIDTH, HEIGHT);
        const ctx = canvas.getContext("2d");

        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const size = fittingFontSize(ctx, lines);
        const step = size * LINE_HEIGHT;
        // Centre the block of lines rather than the first one,
        // so a one-line and a two-line image sit at the same optical height.
        const baseline = canvas.height / 2
            - (step * (lines.length - 1)) / 2
            + ctx.measureText(lines[0])["emHeightDescent"];

        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        lines.forEach((line, index) => {
            ctx.fillText(line, canvas.width / 2, baseline + step * index);
        });

        const stream = canvas.createPNGStream();
        const write = fs.createWriteStream(filepath);
        stream.pipe(write);
        write.on("finish", () => {
            resolve(filepath);
        });
    });
}

(async () => {
    for(const image of IDLE_IMAGES) {
        console.log(`The file has been written at ${await draw(image)}`);
    }
})();
