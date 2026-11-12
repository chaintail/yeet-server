// Server instructions and the tool titles and descriptions re-exported for the text gate. This repository carries
// neutral text in every line; the wording YEET deploys is not part of it.
import {researchInstructions,saveResearchRules} from '#research-policy';
export const instructions = `YEET instructions: ${researchInstructions}.`;
export const descriptions = {
 get_profile:"YEET descriptions.get_profile.",
 get_portfolio:"YEET descriptions.get_portfolio.",
 save_research:`YEET descriptions.save_research: ${saveResearchRules}.`,
 get_quote:"YEET descriptions.get_quote."
};
