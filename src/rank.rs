//! Relevance re-ranking tuned for "is this thread going to fix my bug?".

use std::collections::{HashMap, HashSet};

use crate::discourse::{RawPost, RawTopic};
use crate::time;

const SOLVED_TAGS: &[&str] = &["solved", "fixed", "confirmed", "resolved"];
const DEAD_TAGS: &[&str] = &["cannot-reproduce", "duplicate", "not-a-bug", "invalid", "by-design"];

/// Likes for a topic; search payloads omit the topic's, so the matched post's count stands in.
pub fn likes_of(topic: &RawTopic, post: Option<&RawPost>) -> i64 {
    topic.like_count.unwrap_or_else(|| post.map_or(0, post_likes))
}

/// Likes on one post: `like_count`, or the action tally (id 2 is "like").
pub fn post_likes(post: &RawPost) -> i64 {
    post.like_count.or_else(|| post.actions_summary.iter().find(|a| a.id == 2).and_then(|a| a.count)).unwrap_or(0)
}

/// Thread length minus the opening post: Discourse's `reply_count` only counts direct replies.
pub fn reply_count(topic: &RawTopic) -> i64 {
    match topic.posts_count {
        Some(n) => (n - 1).max(0),
        None => topic.reply_count.unwrap_or(0),
    }
}

/// Triage status taken only from the topic's own tags.
pub fn tag_status(tags: &[String]) -> Option<String> {
    tags.iter().map(|t| t.to_lowercase()).find(|t| SOLVED_TAGS.contains(&t.as_str()) || DEAD_TAGS.contains(&t.as_str()))
}

#[derive(Debug, PartialEq)]
pub struct BugStatus {
    pub label: String,
    pub from_tag: bool,
}

/// The badge beside a result, and where it came from: a status tag, or an accepted answer
/// (which anyone who opened the thread can mark).
pub fn bug_status(tags: &[String], has_accepted_answer: bool) -> Option<BugStatus> {
    if let Some(tag) = tag_status(tags) {
        return Some(BugStatus { label: tag, from_tag: true });
    }
    has_accepted_answer.then(|| BugStatus { label: "answered".into(), from_tag: false })
}

/// Words that carry no weight in a Discourse index but still narrow an AND-ed query.
pub const FILLER: &[&str] = &[
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "not",
    "no",
    "on",
    "in",
    "at",
    "to",
    "of",
    "for",
    "and",
    "or",
    "but",
    "my",
    "me",
    "i",
    "it",
    "its",
    "this",
    "that",
    "when",
    "why",
    "how",
    "does",
    "doesnt",
    "dont",
    "cant",
    "with",
    "without",
    "after",
    "before",
    "from",
    "any",
    "some",
    "get",
    "getting",
    "still",
    "keep",
    "keeps",
    "randomly",
    "sometimes",
    "issue",
    "problem",
    "work",
    "works",
    "working",
    "worked",
    "broken",
    "broke",
    "breaks",
    "breaking",
    "help",
    "please",
    "trying",
    "tried",
    "need",
    "want",
    "make",
    "making",
    "use",
    "using",
    "way",
    "instead",
    "error",
];

pub fn is_filler(word: &str) -> bool {
    FILLER.contains(&word)
}

/// The words in a query that actually say what it is about.
pub fn distinctive_terms<S: AsRef<str>>(queries: &[S]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for q in queries {
        for word in q.as_ref().to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()) {
            if word.len() >= 3 && !is_filler(word) && seen.insert(word.to_string()) {
                out.push(word.to_string());
            }
        }
    }
    out
}

fn compact(text: &str) -> String {
    text.to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect()
}

/// How much of the query the title carries, weighted by term length.
fn title_match(compact_title: &str, terms: &[String]) -> f64 {
    if compact_title.is_empty() || terms.is_empty() {
        return 0.0;
    }
    let total: usize = terms.iter().map(String::len).sum();
    let hit: usize = terms.iter().filter(|t| compact_title.contains(t.as_str())).map(String::len).sum();
    hit as f64 / total as f64
}

fn age_years(iso: Option<&str>) -> f64 {
    match iso.and_then(time::parse_iso) {
        Some(t) => (time::now_ms() - t) as f64 / (365.0 * time::DAY_MS as f64),
        None => 5.0,
    }
}

pub struct SearchSet {
    pub query: String,
    pub topics: Vec<RawTopic>,
    pub posts: Vec<RawPost>,
}

#[derive(Default)]
pub struct Merged {
    pub topics: Vec<RawTopic>,
    pub posts: Vec<RawPost>,
    pub matched_by: HashMap<u64, Vec<String>>,
    pub positions: HashMap<u64, usize>,
}

/// Merge independent result sets, de-duplicated by topic. A topic keeps its best position,
/// and topics several phrasings found come first.
pub fn merge_results(sets: Vec<SearchSet>) -> Merged {
    let mut order: Vec<u64> = Vec::new();
    let mut best: HashMap<u64, (RawTopic, usize)> = HashMap::new();
    let mut matched_by: HashMap<u64, Vec<String>> = HashMap::new();
    let mut posts = Vec::new();
    let mut seen_posts = HashSet::new();
    for set in sets {
        for (index, topic) in set.topics.into_iter().enumerate() {
            let id = topic.id;
            match best.get_mut(&id) {
                Some(prev) => {
                    if index < prev.1 {
                        *prev = (topic, index);
                    }
                }
                None => {
                    order.push(id);
                    best.insert(id, (topic, index));
                }
            }
            let queries = matched_by.entry(id).or_default();
            if !queries.contains(&set.query) {
                queries.push(set.query.clone());
            }
        }
        for p in set.posts {
            if seen_posts.insert(p.id) {
                posts.push(p);
            }
        }
    }
    let agreement = |id: &u64| matched_by.get(id).map_or(1, Vec::len);
    let mut ids = order;
    ids.sort_by(|a, b| agreement(b).cmp(&agreement(a)).then(best[a].1.cmp(&best[b].1)));
    let positions: HashMap<u64, usize> = best.iter().map(|(id, e)| (*id, e.1)).collect();
    let topics = ids.into_iter().map(|id| best.remove(&id).unwrap().0).collect();
    Merged { topics, posts, matched_by, positions }
}

/// Put a multi-phrasing merge back into the order the caller asked for.
pub fn order_merged(mut topics: Vec<RawTopic>, posts: &[RawPost], order: &str, positions: &HashMap<u64, usize>) -> Vec<RawTopic> {
    let mut matched: HashMap<u64, &RawPost> = HashMap::new();
    for post in posts {
        let Some(tid) = post.topic_id else { continue };
        let better = match matched.get(&tid) {
            None => true,
            Some(seen) if order == "likes" => post.like_count.unwrap_or(0) > seen.like_count.unwrap_or(0),
            Some(seen) => {
                match (post.created_at.as_deref().and_then(time::parse_iso), seen.created_at.as_deref().and_then(time::parse_iso)) {
                    (Some(a), Some(b)) => a > b,
                    _ => false,
                }
            }
        };
        if better {
            matched.insert(tid, post);
        }
    }
    let key = |t: &RawTopic| -> f64 {
        match order {
            "latest" => matched
                .get(&t.id)
                .and_then(|p| p.created_at.as_deref())
                .or(t.bumped_at.as_deref())
                .or(t.created_at.as_deref())
                .and_then(time::parse_iso)
                .unwrap_or(0) as f64,
            "likes" => likes_of(t, matched.get(&t.id).copied()) as f64,
            _ => -(positions.get(&t.id).copied().unwrap_or(0) as f64),
        }
    };
    topics.sort_by(|a, b| key(b).total_cmp(&key(a)));
    topics
}

pub struct Ranked<'a> {
    pub topic: &'a RawTopic,
    pub post: Option<&'a RawPost>,
    pub score: f64,
}

/// Blend debugging signals into Discourse's relevance order: on-topic titles, freshness,
/// agreement between phrasings, then thread quality weighted by how on-topic it is.
pub fn rank<'a>(
    topics: &'a [RawTopic],
    posts: &'a [RawPost],
    original_order: bool,
    matched_by: Option<&HashMap<u64, Vec<String>>>,
    queries: &[String],
    positions: Option<&HashMap<u64, usize>>,
) -> Vec<Ranked<'a>> {
    let terms = distinctive_terms(queries);
    let per_query: Vec<Vec<String>> = queries.iter().map(|q| distinctive_terms(&[q])).filter(|t| !t.is_empty()).collect();
    let mut by_topic: HashMap<u64, &RawPost> = HashMap::new();
    for post in posts {
        let Some(tid) = post.topic_id else { continue };
        match by_topic.get(&tid) {
            Some(existing) if existing.post_number <= post.post_number => {}
            _ => {
                by_topic.insert(tid, post);
            }
        }
    }
    let mut ranked: Vec<Ranked> = topics
        .iter()
        .enumerate()
        .map(|(index, topic)| {
            let post = by_topic.get(&topic.id).copied();
            if original_order {
                return Ranked { topic, post, score: -(index as f64) };
            }
            let position = positions.and_then(|p| p.get(&topic.id).copied()).unwrap_or(index);
            let mut score = 100.0 - position as f64 * 3.0;
            let title = compact(&topic.title);
            let on_topic = if per_query.len() > 1 {
                per_query.iter().map(|t| title_match(&title, t)).fold(0.0, f64::max)
            } else {
                title_match(&title, &terms)
            };
            score += on_topic * 70.0;
            let bumped = topic.bumped_at.as_deref().or(topic.last_posted_at.as_deref()).or(topic.created_at.as_deref());
            score -= (age_years(bumped) * 15.0).min(85.0);
            let agreement = matched_by.and_then(|m| m.get(&topic.id)).map_or(1, Vec::len);
            score += (agreement as f64 - 1.0) * 22.0;

            let mut quality = 0.0;
            if topic.has_accepted_answer == Some(true) {
                quality += 45.0;
            }
            if let Some(status) = tag_status(&topic.tags) {
                if SOLVED_TAGS.contains(&status.as_str()) {
                    quality += 25.0;
                }
                if DEAD_TAGS.contains(&status.as_str()) {
                    quality -= 20.0;
                }
            }
            quality += (likes_of(topic, post) as f64 * 1.5).min(25.0);
            quality += (reply_count(topic) as f64 * 0.8).min(15.0);
            if topic.posts_count.unwrap_or(0) <= 1 {
                quality -= 8.0;
            }
            score += quality * if terms.is_empty() { 1.0 } else { 0.3 + 0.7 * on_topic };
            Ranked { topic, post, score }
        })
        .collect();
    ranked.sort_by(|a, b| b.score.total_cmp(&a.score));
    ranked
}

/// Drop results that carry none of the query's distinctive words (for the non-relevance
/// orders). Returns the input untouched when the filter would empty it.
pub fn on_topic_only(topics: Vec<RawTopic>, posts: &[RawPost], queries: &[String]) -> Vec<RawTopic> {
    let terms = distinctive_terms(queries);
    if terms.is_empty() {
        return topics;
    }
    let mut blurbs: HashMap<u64, String> = HashMap::new();
    for p in posts {
        if let Some(tid) = p.topic_id {
            let b = blurbs.entry(tid).or_default();
            b.push(' ');
            b.push_str(p.blurb.as_deref().unwrap_or(""));
        }
    }
    let keep: Vec<bool> = topics
        .iter()
        .map(|t| {
            let text = format!("{} {} {}", t.title, t.tags.join(" "), blurbs.get(&t.id).map_or("", String::as_str)).to_lowercase();
            terms.iter().any(|term| carries_term(&text, term))
        })
        .collect();
    if !keep.contains(&true) {
        return topics;
    }
    topics.into_iter().zip(keep).filter_map(|(t, k)| k.then_some(t)).collect()
}

/// The term has to start where a word starts ("tween" is not in "between"); long names also
/// match across separators ("ProximityPrompt" in "Proximity Prompt").
fn carries_term(text: &str, term: &str) -> bool {
    let bytes = text.as_bytes();
    for (at, _) in text.match_indices(term) {
        let boundary = at == 0 || {
            let prev = bytes[at - 1];
            !(prev.is_ascii_alphanumeric() || prev == b'_')
        };
        if boundary {
            return true;
        }
    }
    term.len() >= 8 && compact(text).contains(term)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(days: i64) -> Option<String> {
        Some(format!("{}T00:00:00Z", time::ymd(time::now_ms() - days * time::DAY_MS)))
    }
    fn topic(id: u64, title: &str) -> RawTopic {
        RawTopic { id, title: title.into(), ..Default::default() }
    }

    #[test]
    fn solved_recent_beats_stale() {
        let topics = vec![
            RawTopic { bumped_at: at(6 * 365), posts_count: Some(1), like_count: Some(0), ..topic(1, "old unanswered") },
            RawTopic {
                bumped_at: at(30),
                posts_count: Some(9),
                reply_count: Some(8),
                like_count: Some(12),
                has_accepted_answer: Some(true),
                ..topic(2, "recent solved")
            },
        ];
        assert_eq!(rank(&topics, &[], false, None, &[], None)[0].topic.id, 2);
        assert_eq!(rank(&topics, &[], true, None, &[], None)[0].topic.id, 1);
    }

    #[test]
    fn earliest_matching_post() {
        let topics = vec![topic(7, "t")];
        let posts = vec![
            RawPost { id: 20, topic_id: Some(7), post_number: 5, blurb: Some("later".into()), ..Default::default() },
            RawPost { id: 10, topic_id: Some(7), post_number: 1, blurb: Some("first".into()), ..Default::default() },
        ];
        assert_eq!(rank(&topics, &posts, false, None, &[], None)[0].post.unwrap().blurb.as_deref(), Some("first"));
    }

    #[test]
    fn statuses_and_counts() {
        assert_eq!(
            bug_status(&["confirmed".into(), "datastore".into()], false),
            Some(BugStatus { label: "confirmed".into(), from_tag: true })
        );
        assert_eq!(bug_status(&[], true), Some(BugStatus { label: "answered".into(), from_tag: false }));
        assert_eq!(bug_status(&[], false), None);
        assert_eq!(reply_count(&RawTopic { posts_count: Some(11), reply_count: Some(6), ..Default::default() }), 10);
        assert_eq!(reply_count(&RawTopic { reply_count: Some(3), ..Default::default() }), 3);
        assert_eq!(reply_count(&RawTopic::default()), 0);
        let p = RawPost { actions_summary: vec![crate::discourse::ActionSummary { id: 2, count: Some(5) }], ..Default::default() };
        assert_eq!(likes_of(&topic(1, "t"), Some(&p)), 5);
        assert_eq!(likes_of(&RawTopic { like_count: Some(12), ..Default::default() }, Some(&p)), 12);
    }

    #[test]
    fn fresh_vs_old_and_relevance() {
        let topics = vec![
            RawTopic {
                bumped_at: at(6 * 365),
                posts_count: Some(9),
                like_count: Some(20),
                has_accepted_answer: Some(true),
                ..topic(1, "old solved")
            },
            RawTopic { bumped_at: at(20), posts_count: Some(4), like_count: Some(1), ..topic(2, "fresh unsolved") },
        ];
        assert_eq!(rank(&topics, &[], false, None, &[], None)[0].topic.id, 2);
        let topics = vec![
            RawTopic {
                bumped_at: at(365),
                posts_count: Some(6),
                like_count: Some(10),
                has_accepted_answer: Some(true),
                ..topic(1, "top hit")
            },
            RawTopic { bumped_at: at(2), posts_count: Some(1), like_count: Some(0), ..topic(2, "weak hit") },
        ];
        assert_eq!(rank(&topics, &[], false, None, &[], None)[0].topic.id, 1);
    }

    #[test]
    fn on_topic_title_wins() {
        let topics = vec![
            RawTopic {
                bumped_at: at(23),
                posts_count: Some(3),
                like_count: Some(14),
                has_accepted_answer: Some(true),
                ..topic(1, "Roblox Audio API Mic System")
            },
            RawTopic {
                bumped_at: at(400),
                posts_count: Some(3),
                like_count: Some(0),
                ..topic(2, "ProximityPrompt Only firing \"TriggerEnded\"")
            },
        ];
        let q = vec!["ProximityPrompt not triggering".to_string()];
        assert_eq!(rank(&topics, &[], false, None, &q, None)[0].topic.id, 2);
        assert_eq!(rank(&topics, &[], false, None, &[], None)[0].topic.id, 1);
        let spaced = vec![RawTopic { bumped_at: at(400), posts_count: Some(2), ..topic(3, "Proximity Prompt broken") }];
        assert!(rank(&spaced, &[], false, None, &q, None)[0].score > 100.0);
    }

    #[test]
    fn merge_and_agreement() {
        let set = |q: &str, ids: &[u64]| SearchSet { query: q.into(), topics: ids.iter().map(|&i| topic(i, "t")).collect(), posts: vec![] };
        let m = merge_results(vec![set("a", &[1, 2]), set("b", &[3, 2])]);
        assert_eq!(m.topics[0].id, 2);
        assert_eq!(m.matched_by[&2], ["a", "b"]);
        let topics = vec![
            RawTopic { bumped_at: at(20), posts_count: Some(5), ..topic(1, "one phrasing") },
            RawTopic { bumped_at: at(20), posts_count: Some(5), ..topic(2, "three phrasings") },
        ];
        let mb: HashMap<u64, Vec<String>> = [(1, vec!["a".into()]), (2, vec!["a".into(), "b".into(), "c".into()])].into();
        assert_eq!(rank(&topics, &[], false, Some(&mb), &[], None)[0].topic.id, 2);
        assert_eq!(rank(&topics, &[], false, None, &[], None)[0].topic.id, 1);
    }

    #[test]
    fn latest_order_after_merge() {
        let post = |id, tid, days| RawPost { id, topic_id: Some(tid), post_number: 1, created_at: at(days), ..Default::default() };
        let m = merge_results(vec![
            SearchSet { query: "a".into(), topics: vec![topic(1, "new"), topic(2, "old")], posts: vec![post(10, 1, 1), post(20, 2, 90)] },
            SearchSet { query: "b".into(), topics: vec![topic(2, "old")], posts: vec![post(20, 2, 90)] },
        ]);
        assert_eq!(m.topics[0].id, 2);
        let latest = order_merged(m.topics.clone(), &m.posts, "latest", &m.positions);
        assert_eq!(latest.iter().map(|t| t.id).collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn filler_only_matches_are_dropped() {
        let topics = vec![
            topic(1, "Analytics: Break Down Your Client CPU Time By Category"),
            topic(2, "[Full Release] Styling Transitions"),
            topic(3, "Playing [Tween A] cancelling prevents [A] from working"),
        ];
        let posts = vec![
            RawPost { id: 10, topic_id: Some(1), blurb: Some("a new Client CPU Time graph".into()), ..Default::default() },
            RawPost {
                id: 20,
                topic_id: Some(2),
                blurb: Some("enables no-code UI tweens within the Styling ecosystem".into()),
                ..Default::default()
            },
        ];
        let q = vec!["tween not working".to_string()];
        let ids = |v: Vec<RawTopic>| v.into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(on_topic_only(topics.clone(), &posts, &q)), [2, 3]);
        assert_eq!(on_topic_only(vec![topic(4, "Difference between server and client")], &[], &q).len(), 1);
        let spaced = vec![topic(5, "Proximity Prompt never fires"), topic(6, "Sound delay")];
        assert_eq!(ids(on_topic_only(spaced, &[], &["ProximityPrompt not triggering".into()])), [5]);
        assert_eq!(on_topic_only(topics.clone(), &posts, &["is it not".into()]).len(), 3);
        assert_eq!(on_topic_only(topics, &posts, &["datastore".into()]).len(), 3);
    }

    #[test]
    fn distinctive() {
        assert_eq!(distinctive_terms(&["Why is my ProximityPrompt not triggering?"]), ["proximityprompt", "triggering"]);
        assert_eq!(distinctive_terms(&["DataStore 502", "datastore timeout"]), ["datastore", "502", "timeout"]);
    }
}
