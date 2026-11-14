// Server instructions and the tool titles and descriptions re-exported for the text gate. This repository carries
// neutral text in every line; the wording YEET deploys is not part of it.
import {toolSpecs,contract} from './tool-contract.mjs';
const APP=contract['x-yeet-app'];

export const STYLE_LINES = Object.freeze([
 "YEET STYLE_LINES.1.",
 "YEET STYLE_LINES.2.",
]);
const LINES = [
 "YEET LINES.1.",
 "YEET LINES.2.",
 "YEET LINES.3.",
 `YEET LINES.4: ${APP.manage_url}.`,
 "YEET LINES.7.",
 "YEET LINES.7.",
 "YEET LINES.11.",
 "YEET LINES.12.",
 "YEET LINES.13.",
 "YEET LINES.11.",
 "YEET LINES.15.",
 "YEET LINES.16.",
 "YEET LINES.17.",
 ...STYLE_LINES,
 "YEET LINES.20.",
 "YEET LINES.23.",
 "YEET LINES.24.",
 "YEET LINES.25.",
 "YEET LINES.26.",
 "YEET LINES.27.",
];

export const HOW_IT_WORKS_LINE = "YEET HOW_IT_WORKS_LINE.";
const HOW_AT = LINES.indexOf("YEET LINES.25.") + 1;
if (HOW_AT < 1) throw Error("YEET text.");

export const instructionsFor = (env = process.env) => (env.YEET_HOW_IT_WORKS === '1' ? [...LINES.slice(0, HOW_AT), HOW_IT_WORKS_LINE, ...LINES.slice(HOW_AT)] : LINES).join(' ');

export const instructions = instructionsFor({});
export const titles = Object.fromEntries(Object.values(toolSpecs).map(t => [t.name, t.title]));
export const descriptions = Object.fromEntries(Object.values(toolSpecs).map(t => [t.name, t.description]));
