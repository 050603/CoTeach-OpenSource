const COMPANION_NAMES = ["知知", "问问", "灵灵", "策策", "评评", "记记"] as const;
const SPOKEN_STAGE_DIRECTIONS = ["收束", "记录", "总结", "回应", "补充", "建议", "发言", "整理"] as const;

const leadingSpeakerLabel = new RegExp(
  `^\\s*[【[(（]?\\s*(?:${COMPANION_NAMES.join("|")})(?:\\s*(?:${SPOKEN_STAGE_DIRECTIONS.join("|")}))?\\s*[】\\])）]?\\s*[:：\\-—]\\s*`,
);

/**
 * Removes model-authored stage directions such as “记记收束：” before the
 * response reaches classroom history, speech bubbles, or TTS. The visible
 * speaker identity already comes from companionId, so speaking it again is
 * both redundant and especially confusing when another companion was chosen.
 */
export function sanitizeCompanionResponse(text: string): string {
  let clean = text.trim();
  let previous = "";

  while (clean && clean !== previous) {
    previous = clean;
    clean = clean.replace(leadingSpeakerLabel, "").trimStart();
  }

  return clean;
}
