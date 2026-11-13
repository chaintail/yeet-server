// Server instructions and the tool titles and descriptions re-exported for the text gate. This repository carries
// neutral text in every line; the wording YEET deploys is not part of it.
import {toolSpecs} from './tool-contract.mjs';
export const instructions = [
 "YEET LINES.1.",
 "YEET LINES.2.",
 "YEET instructions.3.",
 "YEET LINES.7.",
 "YEET LINES.7.",
 "YEET instructions.6.",
 "YEET instructions.7.",
 "YEET instructions.8.",
 "YEET LINES.17.",
 "YEET LINES.20.",
 "YEET LINES.23.",
 "YEET LINES.24.",
 "YEET LINES.27.",
].join(' ');

export const titles = Object.fromEntries(Object.values(toolSpecs).map(t => [t.name, t.title]));
export const descriptions = Object.fromEntries(Object.values(toolSpecs).map(t => [t.name, t.description]));
