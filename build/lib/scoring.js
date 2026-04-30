import { CATEGORY_WEIGHTS } from "../config.js";
export function scoreTopic(t) {
    let score = 0;
    if (t.has_accepted_answer)
        score += 50;
    if (t.solved)
        score += 50;
    if (t.category_id !== undefined && CATEGORY_WEIGHTS[t.category_id]) {
        score += CATEGORY_WEIGHTS[t.category_id] ?? 0;
    }
    score += (t.views ?? 0) * 0.001;
    score += (t.like_count ?? 0) * 0.5;
    if (t.created_at) {
        const daysOld = (Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24);
        score += Math.max(0, 30 - daysOld);
    }
    return score;
}
export function sortByRelevance(topics) {
    return [...topics].sort((a, b) => scoreTopic(b) - scoreTopic(a));
}
//# sourceMappingURL=scoring.js.map