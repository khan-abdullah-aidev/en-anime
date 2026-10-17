import { parseManualTitles } from "./titleUtils.js";

// When En isn't sure of a pick, it says why in one short clause: little left
// to choose from, or too little to go on yet. Nothing when the model failed
// outright or limits were relaxed; the reason itself already says so.
export function doubtFor({ pick, candidateList = [], steering = {}, list }) {
  if (pick?.fallback) return "";
  if (steering.constraintsRelaxed) return "";
  if (candidateList.length < 6) return "There wasn't much left to choose from tonight.";
  const known = Array.isArray(list) ? list.filter((entry) => entry.my_list_status?.status === "completed").length : parseManualTitles(list).length;
  if (known < 5) return "En doesn't know your taste well yet, so this is more of a guess.";
  return "";
}
