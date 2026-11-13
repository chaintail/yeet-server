// Server instructions and the tool titles and descriptions re-exported for the text gate. This repository carries
// neutral text in every line; the wording YEET deploys is not part of it.
import {toolSpecs} from './tool-contract.mjs';
export const instructions = "YEET instructions."
  + (toolSpecs.yeet_set_username ? " YEET instructions." : "");
export const titles = Object.fromEntries(Object.values(toolSpecs).map(t => [t.name, t.title]));
export const descriptions = Object.fromEntries(Object.values(toolSpecs).map(t => [t.name, t.description]));
