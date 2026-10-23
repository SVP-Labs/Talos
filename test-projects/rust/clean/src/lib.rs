//! Counts words.

/// The number of words in `text`.
#[must_use]
pub fn words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// The longest word in `text`, if it has any.
///
/// ```
/// assert_eq!(tally::longest("a bb c"), Some("bb"));
/// ```
#[must_use]
pub fn longest(text: &str) -> Option<&str> {
    text.split_whitespace().max_by_key(|word| word.len())
}

#[cfg(test)]
mod tests {
    use super::{longest, words};

    #[test]
    fn counts_words() {
        assert_eq!(words("one two  three"), 3);
    }

    #[test]
    fn finds_the_longest() {
        assert_eq!(longest("a bb c"), Some("bb"));
        assert_eq!(longest(""), None);
    }
}
