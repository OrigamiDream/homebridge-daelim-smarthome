const {createCanvas} = require("canvas");
const fs = require("fs");

const gen = new Promise((resolve) => {
    const canvas = createCanvas(1280, 720);
    const ctx = canvas.getContext("2d");
    const title = "이미지 대기 중...";
    const filepath = "./assets/hksv_camera_idle.png";

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = "600 50px SF Pro";
    const measurements = ctx.measureText(title);
    const pos = {
        x: canvas.width / 2,
        y: canvas.height / 2 + measurements["emHeightDescent"]
    };
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(title, pos.x, pos.y);

    const stream = canvas.createPNGStream();
    const write = fs.createWriteStream(filepath);
    stream.pipe(write);
    write.on("finish", () => {
        resolve(filepath);
    });
});

(async () => {
    const result = await gen;
    console.log(`The file has been written at ${result}`);
})();
