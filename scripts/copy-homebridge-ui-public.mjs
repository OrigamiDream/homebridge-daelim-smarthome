import {cp, mkdir} from "node:fs/promises";
import path from "node:path";

const source = path.resolve("homebridge-ui", "public");
const target = path.resolve("dist", "homebridge-ui", "public");

await mkdir(path.dirname(target), {recursive: true});
await cp(source, target, {recursive: true});
