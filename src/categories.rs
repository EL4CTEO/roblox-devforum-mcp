//! Category slug <-> Discourse id resolution.
//!
//! The live tree comes from /site.json; the table below is only the offline fallback, used
//! until the first fetch lands and whenever the forum cannot be reached.

use std::collections::HashMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Category {
    pub id: u64,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Slug of the parent category, for the sub-categories Discourse nests one level deep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// Known slugs, in forum display order: (slug, id, parent).
const FALLBACK: &[(&str, u64, Option<&str>)] = &[
    ("updates", 45, None),
    ("announcements", 36, Some("updates")),
    ("news-alerts", 193, Some("updates")),
    ("release-notes", 62, Some("updates")),
    ("community", 90, Some("updates")),
    ("help-and-feedback", 54, None),
    ("scripting-support", 55, Some("help-and-feedback")),
    ("building-support", 56, Some("help-and-feedback")),
    ("art-design-support", 57, Some("help-and-feedback")),
    ("game-design-support", 103, Some("help-and-feedback")),
    ("platform-usage-support", 261, Some("help-and-feedback")),
    ("creations-feedback", 20, Some("help-and-feedback")),
    ("code-review", 75, Some("help-and-feedback")),
    ("cloud-apps", 379, Some("help-and-feedback")),
    ("education-support", 197, Some("help-and-feedback")),
    ("bug-reports", 10, None),
    ("engine-bugs", 28, Some("bug-reports")),
    ("studio-bugs", 29, Some("bug-reports")),
    ("website-bugs", 30, Some("bug-reports")),
    ("mobile-bugs", 31, Some("bug-reports")),
    ("xbox-bugs", 52, Some("bug-reports")),
    ("documentation-issues", 72, Some("bug-reports")),
    ("creator-hub-bugs", 341, Some("bug-reports")),
    ("cloud-services-bugs", 342, Some("bug-reports")),
    ("purchasing-bugs", 344, Some("bug-reports")),
    ("other-bugs", 345, Some("bug-reports")),
    ("talent-hub-bugs", 184, Some("bug-reports")),
    ("education-bugs", 209, Some("bug-reports")),
    ("catalog-asset-bugs", 228, Some("bug-reports")),
    ("roblox-application-and-website-bugs", 343, Some("bug-reports")),
    ("feature-requests", 170, None),
    ("engine-features", 23, Some("feature-requests")),
    ("studio-features", 24, Some("feature-requests")),
    ("website-features", 25, Some("feature-requests")),
    ("mobile-features", 26, Some("feature-requests")),
    ("xbox-features", 53, Some("feature-requests")),
    ("talent-hub-features", 185, Some("feature-requests")),
    ("education-features", 198, Some("feature-requests")),
    ("documentation-features", 247, Some("feature-requests")),
    ("resources", 71, None),
    ("community-resources", 74, Some("resources")),
    ("community-tutorials", 46, Some("resources")),
    ("community-events", 196, Some("resources")),
    ("roblox-staff", 278, Some("resources")),
    ("collaboration", 81, None),
    ("recruitment", 82, Some("collaboration")),
    ("portfolios", 83, Some("collaboration")),
    ("forum-help", 12, None),
    ("forum-bugs", 146, Some("forum-help")),
    ("forum-features", 147, Some("forum-help")),
    ("bulletin-board", 63, None),
];

pub fn fallback() -> Vec<Category> {
    FALLBACK.iter().map(|&(slug, id, parent)| Category { id, slug: slug.into(), name: None, parent: parent.map(Into::into) }).collect()
}

/// The slugs the tool descriptions advertise.
pub fn default_slugs() -> String {
    FALLBACK.iter().map(|c| c.0).collect::<Vec<_>>().join(", ")
}

/// Baked-in id for a slug, i.e. the tree as it stood when this version shipped.
pub fn fallback_id(slug: &str) -> Option<u64> {
    FALLBACK.iter().find(|c| c.0 == slug).map(|c| c.1)
}

/// Insertion-ordered slug map: a later entry for a known slug updates it in place, as a JS
/// Map does, so forum display order survives the live merge.
#[derive(Debug, Default)]
pub struct Index {
    list: Vec<Category>,
    by_slug: HashMap<String, usize>,
    by_id: HashMap<u64, usize>,
}

impl Index {
    pub fn build(categories: impl IntoIterator<Item = Category>) -> Self {
        let mut index = Index::default();
        for c in categories {
            let at = match index.by_slug.get(&c.slug) {
                Some(&at) => {
                    index.list[at] = c.clone();
                    at
                }
                None => {
                    index.list.push(c.clone());
                    index.by_slug.insert(c.slug.clone(), index.list.len() - 1);
                    index.list.len() - 1
                }
            };
            index.by_id.insert(c.id, at);
        }
        index
    }
}

/// Discourse's catch-all: it holds nothing on the DevForum and only clutters a listing.
const HIDDEN: &[&str] = &["uncategorized"];

pub struct Categories {
    current: RwLock<Index>,
}

pub struct TreeNode {
    pub category: Category,
    pub subcategories: Vec<Category>,
}

fn normalise(slug: &str) -> String {
    let lower = slug.trim().to_lowercase();
    let lower = lower.strip_prefix('#').unwrap_or(&lower);
    let mut out = String::with_capacity(lower.len());
    let mut in_sep = false;
    for ch in lower.chars() {
        if ch.is_whitespace() || ch == '_' {
            if !in_sep {
                out.push('-');
            }
            in_sep = true;
        } else {
            out.push(ch);
            in_sep = false;
        }
    }
    out
}

impl Default for Categories {
    fn default() -> Self {
        Categories { current: RwLock::new(Index::build(fallback())) }
    }
}

impl Categories {
    /// Replace the tree. The live tree wins on ids and parents but never removes a slug the
    /// tools advertise: a category hidden from anonymous readers must not become "unknown".
    pub fn merge_live(&self, live: Vec<Category>) {
        let index = Index::build(fallback().into_iter().chain(live));
        *self.current.write().unwrap() = index;
    }

    pub fn reset(&self) {
        *self.current.write().unwrap() = Index::build(fallback());
    }

    /// Accepts the spellings a caller copies from the forum: "Scripting Support",
    /// "#scripting-support", "scripting_support".
    pub fn resolve(&self, slug: &str) -> Option<Category> {
        let idx = self.current.read().unwrap();
        idx.by_slug.get(&normalise(slug)).map(|&i| idx.list[i].clone())
    }

    pub fn known_slugs(&self) -> Vec<String> {
        self.current.read().unwrap().list.iter().map(|c| c.slug.clone()).collect()
    }

    /// Parents in forum order with their children under them.
    pub fn tree(&self) -> Vec<TreeNode> {
        let idx = self.current.read().unwrap();
        let mut children: HashMap<&str, Vec<Category>> = HashMap::new();
        let mut roots = Vec::new();
        for c in &idx.list {
            if HIDDEN.contains(&c.slug.as_str()) {
                continue;
            }
            match &c.parent {
                Some(p) if idx.by_slug.contains_key(p) => children.entry(p.as_str()).or_default().push(c.clone()),
                _ => roots.push(c.clone()),
            }
        }
        roots
            .into_iter()
            .map(|root| {
                let subcategories = children.remove(root.slug.as_str()).unwrap_or_default();
                TreeNode { category: root, subcategories }
            })
            .collect()
    }

    pub fn name_of(&self, id: Option<u64>) -> String {
        let Some(id) = id else { return "unknown".into() };
        let idx = self.current.read().unwrap();
        idx.by_id.get(&id).map_or_else(|| format!("category-{id}"), |&i| idx.list[i].slug.clone())
    }

    /// Canonical listing path, e.g. "updates/release-notes/62". An unresolved slug still builds
    /// a usable path: Discourse redirects /c/<slug> to the real one.
    pub fn path_of(&self, slug: &str) -> String {
        match self.resolve(slug) {
            Some(c) => match c.parent {
                Some(p) => format!("{p}/{}/{}", c.slug, c.id),
                None => format!("{}/{}", c.slug, c.id),
            },
            None => slug.trim().to_lowercase(),
        }
    }

    pub fn child_slugs(&self, slug: &str) -> Vec<String> {
        let idx = self.current.read().unwrap();
        idx.list.iter().filter(|c| c.parent.as_deref() == Some(slug)).map(|c| c.slug.clone()).collect()
    }

    /// bug-reports and whatever sits under it, live tree included.
    pub fn bug_areas(&self) -> Vec<String> {
        let mut out = vec!["bug-reports".to_string()];
        out.extend(self.child_slugs("bug-reports"));
        out
    }

    /// Slugs within `budget` edits of what was asked, nearest only.
    fn closest_by_spelling(&self, asked: &str, limit: usize, budget: usize) -> Vec<String> {
        let mut near: Vec<(String, usize)> = self
            .known_slugs()
            .into_iter()
            .map(|k| {
                let d = edit_distance(asked, &k, budget);
                (k, d)
            })
            .filter(|(_, d)| *d <= budget)
            .collect();
        near.sort_by_key(|(_, d)| *d);
        let Some(best) = near.first().map(|n| n.1) else { return vec![] };
        near.into_iter().filter(|n| n.1 == best).take(limit).map(|n| n.0).collect()
    }

    /// Slugs close enough to be what the caller meant, best tier only.
    pub fn suggest(&self, slug: &str, limit: usize) -> Vec<String> {
        let asked = slug.trim().to_lowercase();
        let words: Vec<&str> = asked.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
        if words.is_empty() {
            return vec![];
        }
        // One slip from a real slug is a clearer answer than every slug sharing a word.
        let slip = self.closest_by_spelling(&asked, limit, 1);
        if !slip.is_empty() {
            return slip;
        }
        // Only a distinctive word counts; half the tree ends in "bugs".
        let distinctive: Vec<&str> = words.iter().copied().filter(|w| family(w).is_none()).collect();
        let generic: Vec<&str> = words.iter().copied().filter(|w| family(w).is_some()).collect();
        let mut scored: Vec<(String, usize)> = self
            .known_slugs()
            .into_iter()
            .filter_map(|known| {
                let parts: Vec<&str> = known.split('-').collect();
                let hits = distinctive.iter().filter(|w| parts.contains(w)).count();
                let mut score = if hits > 0 { hits * 4 + generic.iter().filter(|w| parts.contains(w)).count() } else { 0 };
                if score == 0 && (known.contains(&asked) || asked.contains(&known)) {
                    score = 1;
                }
                (score > 0).then_some((known, score))
            })
            .collect();
        if !scored.is_empty() {
            scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.len().cmp(&b.0.len())));
            let best = scored[0].1;
            return scored.into_iter().filter(|s| s.1 == best).take(limit).map(|s| s.0).collect();
        }
        // A misspelling shares no whole word with any slug.
        let loose = self.closest_by_spelling(&asked, limit, (asked.chars().count() / 6).max(1));
        if !loose.is_empty() {
            return loose;
        }
        // Nothing distinctive matched: name the family the caller was plainly aiming at.
        match words.iter().find_map(|w| family(w)) {
            Some(f) if self.resolve(f).is_some() => vec![f.to_string()],
            _ => vec![],
        }
    }
}

/// Words that end a whole family of slugs, mapped to the family root worth suggesting.
fn family(word: &str) -> Option<&'static str> {
    Some(match word {
        "bug" | "bugs" | "report" | "reports" => "bug-reports",
        "feature" | "features" | "request" | "requests" => "feature-requests",
        "support" | "help" | "feedback" => "help-and-feedback",
        "resource" | "resources" => "resources",
        _ => return None,
    })
}

/// Levenshtein distance, giving up (returning limit + 1) once it must exceed `limit`.
pub fn edit_distance(a: &str, b: &str, limit: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > limit {
        return limit + 1;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut row = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        row[0] = i;
        for j in 1..=b.len() {
            row[j] = (prev[j] + 1).min(row[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        std::mem::swap(&mut prev, &mut row);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_resolve_to_canonical_paths() {
        let c = Categories::default();
        assert_eq!(c.path_of("release-notes"), "updates/release-notes/62");
        assert_eq!(c.path_of("bug-reports"), "bug-reports/10");
        assert_eq!(c.path_of("Scripting-Support"), "help-and-feedback/scripting-support/55");
        assert_eq!(c.path_of("brand-new-category"), "brand-new-category");
        assert!(c.resolve("nope").is_none());
        for s in ["scripting-support", "Scripting Support", "#scripting-support", "scripting_support"] {
            assert_eq!(c.resolve(s).unwrap().slug, "scripting-support", "{s}");
        }
        assert!(c.resolve("scripting").is_none());
        assert_eq!(c.name_of(Some(28)), "engine-bugs");
        assert_eq!(c.name_of(Some(999_999)), "category-999999");
    }

    #[test]
    fn suggestions() {
        let c = Categories::default();
        assert_eq!(c.suggest("scripting", 3), ["scripting-support"]);
        assert!(c.suggest("engine-bug", 3).contains(&"engine-bugs".to_string()));
        assert!(c.suggest("!!!", 3).is_empty());
        assert_eq!(c.suggest("studio bugs", 3), ["studio-bugs"]);
        assert_eq!(c.suggest("physics-bugs", 3), ["bug-reports"]);
        assert_eq!(c.suggest("networking-features", 3), ["feature-requests"]);
        assert_eq!(c.suggest("lua-support", 3), ["help-and-feedback"]);
        assert_eq!(c.suggest("scriptng-support", 3), ["scripting-support"]);
    }

    #[test]
    fn bug_areas_cover_only_bug_children() {
        let c = Categories::default();
        let areas = c.bug_areas();
        assert!(areas.contains(&"engine-bugs".into()) && areas.contains(&"studio-bugs".into()));
        assert!(!areas.contains(&"scripting-support".into()) && !areas.contains(&"engine-features".into()));
        assert!(c.child_slugs("scripting-support").is_empty());
        assert!(!c.child_slugs("bug-reports").contains(&"bug-reports".into()));
    }
}
